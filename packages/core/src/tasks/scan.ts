import { readdir, stat } from "node:fs/promises";
import { AppError, EXIT } from "../exit";
import { extname, join } from "node:path";
import { detectContentType, extractNumber, parseFileInfo } from "../domain/identify";
import { existsSync } from "node:fs";
import { nfoPathFor } from "../domain/nfo";
import { hasNetworkSource } from "./nfo-sync";
import type { Library } from "../domain/materialize";
import { metadataColumns, parsePhase, stringify, type MediaFileRow } from "../db/rows";
import type { FileInfo } from "../domain/types";
import type { Runtime } from "../runtime";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".wmv", ".mov", ".ts", ".m2ts", ".iso", ".rmvb", ".flv", ".webm", ".m4v"]);

export type ScanEventType = "file.added" | "file.updated" | "file.unchanged" | "file.removed" | "file.unparsed";

export interface ScanEvent {
  type: ScanEventType;
  path: string;
  number?: string | null;
}

export interface ScanReport {
  libraryId: number;
  root: string;
  dryRun: boolean;
  counts: {
    added: number;
    updated: number;
    unchanged: number;
    removed: number;
    unparsed: number;
    /**
     * 视频旁边有 .nfo、但库里该条目还没有网络来源的个数。
     *
     * scan 自己不再读 nfo 入库 —— 那是 `nfo sync` 的活(双向, 且共用一份实现)。
     * 这里只报数, 免得"换电脑重扫"这条路上的人不知道下一步该做什么。
     */
    nfoPending: number;
    /**
     * 修正了内容类型的条数。
     *
     * 内容类型按理只在建条目时落定, 但它同时决定刮削路由 —— 解析器有 bug 时
     * (把 SNIS-191 判成国产) 修完必须让旧库自愈, 否则那些条目永远只路由到
     * 一个源。只动"还没刮到任何标题"的条目: 有元数据的类型已经参与过路由,
     * 改它等于换一条来源线, 应该由人来决定。
     */
    retyped: number;
  };
  durationMs: number;
}

export interface ScanOptions {
  library: Library;
  dryRun?: boolean;
  onEvent?: (event: ScanEvent) => void;
  /**
   * 跳过"一次要移除太多"的安全阀。
   *
   * 默认不跳过: 盘没挂上、库根目录指错、网络盘只挂了一半时, 直接把索引里
   * 没看到的文件全删掉, 后果是**按库筛选的条目列表突然空了** (条目还在库里,
   * 但它的文件没了), 下次扫描再登记文件又"恢复"。这种"自己好了"的现象最坑人。
   */
  force?: boolean;
}

interface Found {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * REFRESH: 只读磁盘。登记文件、解析番号、建条目占位行 —— **不抓网、不改名**。
 * 幂等: 同一目录重复扫描, 第二次应全部 unchanged。
 */
export async function scan(rt: Runtime, opts: ScanOptions): Promise<ScanReport> {
  const started = Date.now();
  const { library } = opts;
  const dryRun = opts.dryRun ?? false;
  const emit = opts.onEvent ?? (() => {});

  const rootStat = await stat(library.root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`媒体库目录不存在: ${library.root}`);
  }

  const found: Found[] = [];
  await walk(library.root, found);

  const known = new Map<string, MediaFileRow>();
  for (const row of rt.db.all<MediaFileRow>(
    "select path, library_id, number, size, mtime_ms, sha256, phase from media_files where library_id = ?",
    [library.id],
  )) {
    known.set(row.path, row);
  }

  const counts = { added: 0, updated: 0, unchanged: 0, removed: 0, unparsed: 0, nfoPending: 0, retyped: 0 };
  const seen = new Set<string>();
  // 同一个番号可能对应多个文件, nfo 只读一次。
  const nfoChecked = new Set<string>();
  /** 每次扫描内同一条目只判一次类型。 */
  const retyped = new Set<string>();

  rt.db.exec("begin");
  try {
    for (const file of found) {
      seen.add(file.path);
      const previous = known.get(file.path);

      // 解析本身是纯函数、不花 IO, 所以每次都重算, 不跟着 size/mtime 一起跳过。
      // 这样解析器升级后, 旧库里"以前认不出"的文件重扫一次就能自愈。
      const number = extractNumber(file.path);
      const phase = parseFileInfo(file.path);
      if (!number) counts.unparsed++;

      // 空条目的元数据可以从旁边的 nfo 捞回来 —— 换电脑时数据库是空的, 这一步能省掉全部刮削。
      // 只数, 不读: 读 nfo 是 `nfo sync` 的事。
      if (number && !nfoChecked.has(number)) {
        nfoChecked.add(number);
        if (existsSync(nfoPathFor(file.path)) && !hasNetworkSource(fieldSourcesOf(rt, number))) counts.nfoPending++;
      }

      // 类型自愈必须在 unchanged 短路之前: 文件没变, 但解析器修好了。
      if (number && !dryRun && !retyped.has(number)) {
        retyped.add(number);
        const detected = detectContentType(number, file.path) ?? "censored";
        if (retypeUntouched(rt, number, detected)) counts.retyped++;
      }

      const untouched = previous && previous.size === file.size && previous.mtime_ms === file.mtimeMs;
      if (untouched && previous.number === number) {
        counts.unchanged++;
        emit({ type: "file.unchanged", path: file.path, number });
        continue;
      }

      if (number && !dryRun) {
        // 条目是一等公民: 有番号就先建占位行, 刮削再填字段。
        rt.db.run("insert or ignore into items (number, content_type) values (?, ?)", [
          number,
          detectContentType(number, file.path) ?? "censored",
        ]);
      }

      // sha256 留给后续去重; v0.1 不算, 否则首次扫描大库要跑几十分钟。
      const sha256 = previous?.sha256 ?? null;
      const type: ScanEventType = previous ? "file.updated" : "file.added";
      counts[type === "file.added" ? "added" : "updated"]++;

      if (!dryRun) {
        rt.db.run(
          `insert into media_files (path, library_id, number, size, mtime_ms, sha256, phase, seen_at)
           values (?, ?, ?, ?, ?, ?, ?, unixepoch())
           on conflict(path) do update set library_id = excluded.library_id, number = excluded.number,
             size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256,
             phase = excluded.phase, seen_at = excluded.seen_at`,
          [file.path, library.id, number, file.size, file.mtimeMs, sha256, stringify(phase)],
        );
      }
      emit({ type, path: file.path, number });
    }

    const toRemove = [...known.keys()].filter((path) => !seen.has(path));
    const pruneGuard = !opts.force && known.size >= 20 && toRemove.length / known.size > 0.3;
    if (pruneGuard) {
      // 不在这里 rollback: 外层 catch 统一回滚, 这里再回滚一次会报
      // "cannot rollback - no transaction is active"
      const percent = Math.round((toRemove.length / known.size) * 100);
      throw new AppError(
        `这次扫描要移除 ${toRemove.length} 个已登记文件 (占 ${percent}%), 库根可能没挂载完整, 已中止`,
        EXIT.NEEDS_INPUT,
        {
          libraryId: library.id,
          root: library.root,
          known: known.size,
          wouldRemove: toRemove.length,
          sample: toRemove.slice(0, 3),
          hint: `确认目录完整后重试; 确实要删就加 --force`,
        },
      );
    }

    for (const path of known.keys()) {
      if (seen.has(path)) continue;
      counts.removed++;
      if (!dryRun) rt.db.run("delete from media_files where path = ?", [path]);
      emit({ type: "file.removed", path });
    }

    if (dryRun) rt.db.exec("rollback");
    else rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  return { libraryId: library.id, root: library.root, dryRun, counts, durationMs: Date.now() - started };
}

export interface MediaFileView {
  path: string;
  number: string | null;
  libraryId: number;
  size: number;
  mtimeMs: number;
  phase: FileInfo;
}

/**
 * 索引里的文件清单。`unparsedOnly` 就是"扫到了但认不出番号"的那批 ——
 * 它们不会有 items 行, 所以在条目列表里永远看不到, 必须单独给入口。
 */
export function listFiles(
  rt: Runtime,
  options: { libraryId?: number; unparsedOnly?: boolean; limit?: number; offset?: number } = {},
): MediaFileView[] {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (options.libraryId !== undefined) {
    where.push("library_id = ?");
    params.push(options.libraryId);
  }
  if (options.unparsedOnly) where.push("number is null");

  const sql = `select path, number, library_id, size, mtime_ms, phase from media_files
    ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
    order by path limit ? offset ?`;
  params.push(options.limit ?? 200, options.offset ?? 0);

  return rt.db.all<MediaFileRow & { library_id: number; size: number; mtime_ms: number }>(sql, params).map((row) => ({
    path: row.path,
    number: row.number,
    libraryId: row.library_id,
    size: row.size,
    mtimeMs: row.mtime_ms,
    phase: parsePhase(row.phase),
  }));
}

export function countFiles(
  rt: Runtime,
  options: { libraryId?: number; unparsedOnly?: boolean } = {},
): number {
  const where: string[] = [];
  const params: number[] = [];
  if (options.libraryId !== undefined) {
    where.push("library_id = ?");
    params.push(options.libraryId);
  }
  if (options.unparsedOnly) where.push("number is null");
  const sql = `select count(*) c from media_files ${where.length > 0 ? `where ${where.join(" and ")}` : ""}`;
  return rt.db.get<{ c: number }>(sql, params)?.c ?? 0;
}

/** 供 GUI / 排查用: 某个文件当前登记到的相位。 */
export function filePhase(rt: Runtime, path: string) {
  const row = rt.db.get<MediaFileRow>("select * from media_files where path = ?", [path]);
  return row ? parsePhase(row.phase) : null;
}

/**
 * 条目还空着的时候, 用视频旁边的同名 nfo 补上元数据。
 *
 * 只在 `title` 为空时动手: 库里已经有刮削结果的条目, 不该被一个旧 nfo 覆盖回去。
 */
/**
 * 没刮过网络的条目, 按当前解析器重新判定内容类型。
 *
 * 判据是"从来没被任何来源填过字段" —— `field_sources` 为空说明它身上的数据
 * 不是刮来的 (可能只是从旁边的 nfo 读回来的标题)。这类条目改类型没有损失。
 *
 * 已经真刮过字段的条目不在此列: 换类型等于换来源线, 而且 `{content_type}`
 * 目录模板会跟着变, 该由人来决定 (`kura item retype`)。
 */
function retypeUntouched(rt: Runtime, number: string, detected: string): boolean {
  const row = rt.db.get<{ content_type: string; title: string | null; field_sources: string | null }>(
    "select content_type, title, field_sources from items where number = ?",
    [number],
  );
  if (!row || row.content_type === detected) return false;
  const sources = row.field_sources;
  const scraped = Boolean(sources && sources !== "{}" && sources !== "null");
  if (scraped && row.title) return false;
  rt.db.run("update items set content_type = ?, updated_at = unixepoch() where number = ?", [detected, number]);
  return true;
}

function fieldSourcesOf(rt: Runtime, number: string): Record<string, string> {
  const row = rt.db.get<{ field_sources: string | null }>("select field_sources from items where number = ?", [number]);
  return parseFieldSources(row?.field_sources);
}

function parseFieldSources(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function walk(dir: string, out: Found[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, out);
    } else if (entry.isFile()) {
      if (!VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const info = await stat(path);
      out.push({ path, size: info.size, mtimeMs: Math.round(info.mtimeMs) });
    }
  }
}
