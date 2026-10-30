import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { detectContentType, extractNumber, parseFileInfo } from "../domain/identify";
import type { Library } from "../domain/materialize";
import { parsePhase, stringify, type MediaFileRow } from "../db/rows";
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
  counts: { added: number; updated: number; unchanged: number; removed: number; unparsed: number };
  durationMs: number;
}

export interface ScanOptions {
  library: Library;
  dryRun?: boolean;
  onEvent?: (event: ScanEvent) => void;
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

  const counts = { added: 0, updated: 0, unchanged: 0, removed: 0, unparsed: 0 };
  const seen = new Set<string>();

  rt.db.exec("begin");
  try {
    for (const file of found) {
      seen.add(file.path);
      const previous = known.get(file.path);

      if (previous && previous.size === file.size && previous.mtime_ms === file.mtimeMs) {
        counts.unchanged++;
        emit({ type: "file.unchanged", path: file.path, number: previous.number });
        continue;
      }

      const number = extractNumber(file.path);
      const phase = parseFileInfo(file.path);
      if (!number) counts.unparsed++;

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
