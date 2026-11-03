import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildNfo } from "../domain/materialize";
import { nfoPathFor, nfoToMetadata, readNfo, updateNfoContent } from "../domain/nfo";
import { metadataColumns, rowToMetadata, stringify, type ItemRow } from "../db/rows";
import { pruneActors, syncItemActors } from "../db/actors";
import type { Metadata } from "../domain/types";
import type { Runtime } from "../runtime";

/**
 * NFO 的双向同步 —— 与 `scan` 读 nfo 是同一件事的两个方向。
 *
 * 为什么必须成对出现: Emby / Jellyfin / Kodi 读的是 **nfo 文件**, Kura 改的是自己的库。
 * 只读不写, 播放器里永远是旧演员; 只写不读, 换机器重扫就丢了元数据。
 *
 * 一次过, 每个文件只做一件事, 规则是确定的 (没有"冲突"需要人裁决):
 *  - 库里没有网络来源 → 读 nfo 当种子(只填空字段), 库补上;
 *  - 库里有网络来源 → 用库里的值改 nfo(Kura 认识的字段, 其它标签原样保留);
 *  - 两边已经一致 → 什么都不做。
 *
 * 与 `organize` 的边界: 这里**不动视频、不改名、不建目录**, 只碰旁路文件。
 */

export interface NfoSyncOptions {
  libraryId?: number;
  number?: string;
  /** 只写不读(默认 false: 两个方向都做) */
  writeOnly?: boolean;
  /** 只读不写 */
  readOnly?: boolean;
  /** 连"没联网刮过"的条目也写(默认跳过写回, 但仍会读入) */
  includeUnscraped?: boolean;
  apply?: boolean;
  limit?: number;
}

export interface NfoSyncEntry {
  number: string;
  path: string;
  nfoPath: string;
  action: "import" | "write" | "create" | "skip";
  reason?: string;
  changed: string[];
  ok?: boolean;
  error?: string;
}

export interface NfoSyncReport {
  dryRun: boolean;
  scanned: number;
  imported: number;
  written: number;
  created: number;
  skipped: number;
  errors: number;
  entries: NfoSyncEntry[];
}

/** 一条条目的元数据是否真的联网刮过 —— NFO 种下的种子、手改的字段都不算。 */
export function hasNetworkSource(fieldSources: Record<string, string>): boolean {
  return Object.values(fieldSources).some((source) => source !== "nfo" && source !== "manual");
}

/** 键是 `Metadata` 的字段名(不是数据库列名 —— 原名是 titleOriginal)。 */
const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  titleOriginal: "原名",
  plot: "简介",
  release_date: "发行日期",
  duration_min: "时长",
  studio: "片商",
  label: "厂牌",
  series: "系列",
  actors: "演员",
  directors: "导演",
  tags: "标签",
};

/**
 * 把 nfo 里**库中还空着**的字段补进去。已有的值不动 —— 这是"nfo 让步"的另一半:
 * 网络值不会被旧 nfo 覆盖回来, 但库里真没有的字段, 有 nfo 就该用起来。
 */
export function importNfoFields(
  rt: Runtime,
  number: string,
  videoPath: string,
  options: { apply?: boolean } = {},
): string[] | null {
  const fields = readNfo(videoPath);
  if (!fields) return null;

  const row = rt.db.get<ItemRow>("select * from items where number = ?", [number]);
  if (!row) return null;

  const current = rowToMetadata(row);
  const seeded = nfoToMetadata(fields, number);
  const merged: Metadata = { ...current };
  const changed: string[] = [];

  for (const key of Object.keys(FIELD_LABELS)) {
    const column = key as keyof Metadata & string;
    const existing = merged[column];
    const filled = Array.isArray(existing) ? existing.length > 0 : existing !== undefined && existing !== null && existing !== "";
    if (filled) continue;
    const incoming = seeded[column];
    const incomingFilled = Array.isArray(incoming) ? incoming.length > 0 : incoming !== undefined && incoming !== null && incoming !== "";
    if (!incomingFilled) continue;
    (merged as unknown as Record<string, unknown>)[column] = incoming;
    merged.fieldSources[column] = "nfo";
    changed.push(`${FIELD_LABELS[key]} ← ${Array.isArray(incoming) ? incoming.join("、") : incoming}`);
  }

  if (changed.length === 0) return [];
  // dry-run 只算差异, 不落库 —— 否则"先看看"就把库改了。
  if (options.apply === false) return changed;

  const columns = metadataColumns(merged);
  const names = Object.keys(columns);
  rt.db.run(
    `update items set ${names.map((name) => `${name} = ?`).join(", ")}, field_sources = ?, updated_at = unixepoch()
     where number = ?`,
    [...names.map((name) => columns[name]), stringify(merged.fieldSources), number],
  );
  // 演员换了就要重建索引, 否则"点演员看全部"会漏掉这条 (scan 的旧实现就漏了这一步)。
  if (changed.some((item) => item.startsWith("演员"))) {
    syncItemActors(rt.db, number);
    pruneActors(rt.db);
  }
  return changed;
}

export function syncNfo(rt: Runtime, options: NfoSyncOptions = {}): NfoSyncReport {
  const apply = options.apply === true;
  const limit = options.limit ?? 5000;
  const where: string[] = ["m.number is not null"];
  const params: unknown[] = [];
  if (options.libraryId !== undefined) {
    where.push("m.library_id = ?");
    params.push(options.libraryId);
  }
  if (options.number) {
    where.push("m.number = ?");
    params.push(options.number);
  }

  const rows = rt.db.all<ItemRow & { path: string }>(
    `select m.path, i.* from media_files m join items i on i.number = m.number
     where ${where.join(" and ")}
     order by m.path
     limit ?`,
    [...params, limit],
  );

  const report: NfoSyncReport = { dryRun: !apply, scanned: rows.length, imported: 0, written: 0, created: 0, skipped: 0, errors: 0, entries: [] };

  for (const row of rows) {
    const nfoPath = nfoPathFor(row.path);
    const entry: NfoSyncEntry = { number: row.number ?? String(row["number"]), path: row.path, nfoPath, action: "skip", changed: [] };
    const metadata = rowToMetadata(row);

    try {
      // 方向一: 库里没有网络来源 → 拿 nfo 当种子补空字段(只读磁盘)
      if (!options.writeOnly && !hasNetworkSource(metadata.fieldSources)) {
        const changed = importNfoFields(rt, metadata.key, row.path, { apply });
        if (changed && changed.length > 0) {
          report.imported++;
          report.entries.push({ ...entry, action: "import", changed });
          continue;
        }
      }

      // 方向二: 库里有网络来源 → 用库里的值改 nfo
      if (options.readOnly) {
        entry.reason = "只读模式";
        report.skipped++;
        report.entries.push(entry);
        continue;
      }
      if (!metadata.title) {
        entry.reason = "还没有标题, 没有可写的内容";
        report.skipped++;
        report.entries.push(entry);
        continue;
      }
      if (!options.includeUnscraped && !hasNetworkSource(metadata.fieldSources)) {
        entry.reason = "没联网刮过 (只有 nfo/manual 来源), 回写只是抄旧值";
        report.skipped++;
        report.entries.push(entry);
        continue;
      }

      if (!existsSync(nfoPath)) {
        report.created++;
        report.entries.push({ ...entry, action: "create", changed: ["(新建)"] });
        if (apply) writeFileSync(nfoPath, buildNfo(metadata), "utf8");
        continue;
      }

      const update = updateNfoContent(readFileSync(nfoPath, "utf8"), metadata);
      if (update.changed.length === 0) {
        entry.reason = "内容已经一致";
        report.skipped++;
        report.entries.push(entry);
        continue;
      }
      report.written++;
      report.entries.push({ ...entry, action: "write", changed: update.changed });
      if (apply) writeFileSync(nfoPath, update.content, "utf8");
    } catch (err) {
      // 单条失败不中断整批: 一个只读盘不该让 3000 个文件全白跑。
      report.errors++;
      report.entries.push({ ...entry, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return report;
}
