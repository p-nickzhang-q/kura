import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { buildNfo } from "../domain/materialize";
import { nfoPathFor, updateNfoContent } from "../domain/nfo";
import { rowToMetadata, type ItemRow } from "../db/rows";
import type { Runtime } from "../runtime";

/**
 * 把库里的元数据回写到视频旁的 `.nfo`。
 *
 * 为什么必须存在: Emby / Jellyfin / Kodi 读的是 **nfo 文件**, 不是 Kura 的数据库。
 * 只修数据库的话, 界面上演员对了, 播放器里还是旧值 —— 两边永远对不上。
 *
 * 边界(与 organize 的区别):
 *  - **不动视频、不改名、不建目录**, 只改这一个旁路文件的内容;
 *  - 只改 Kura 认识的字段, 其它标签原样保留(见 domain/nfo.ts `updateNfoContent`);
 *  - 默认只处理"已经联网刮过"的条目: 没刮过的回写只是把旧值抄一遍;
 *  - 默认 dry-run, `apply` 才写盘; 内容没变化的文件不碰(mtime 不抖)。
 */
export interface NfoWriteOptions {
  /** 不传 = 所有库 */
  libraryId?: number;
  /** 只处理这一条 */
  number?: string;
  apply?: boolean;
  /** 连"从没联网刮过"的条目也写(默认跳过) */
  includeUnscraped?: boolean;
  limit?: number;
}

export interface NfoWriteEntry {
  number: string;
  path: string;
  nfoPath: string;
  /** 新建 / 更新 / 跳过 的原因 */
  status: "create" | "update" | "skip";
  reason?: string;
  changed: string[];
  ok?: boolean;
  error?: string;
}

export interface NfoWriteReport {
  dryRun: boolean;
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  entries: NfoWriteEntry[];
}

/** 一条条目的元数据是否真的联网刮过 —— NFO 种下的种子不算。 */
export function hasNetworkSource(fieldSources: Record<string, string>): boolean {
  return Object.values(fieldSources).some((source) => source !== "nfo" && source !== "manual");
}

export function writeNfo(rt: Runtime, options: NfoWriteOptions = {}): NfoWriteReport {
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

  const report: NfoWriteReport = { dryRun: !apply, scanned: rows.length, created: 0, updated: 0, skipped: 0, errors: 0, entries: [] };

  for (const row of rows) {
    const metadata = rowToMetadata(row);
    const nfoPath = nfoPathFor(row.path);
    const entry: NfoWriteEntry = { number: metadata.key, path: row.path, nfoPath, status: "skip", changed: [] };

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

    try {
      if (!existsSync(nfoPath)) {
        entry.status = "create";
        entry.changed = ["(新建)"];
        report.created++;
        if (apply) writeFileSync(nfoPath, buildNfo(metadata), "utf8");
        report.entries.push(entry);
        continue;
      }

      const original = readFileSync(nfoPath, "utf8");
      const update = updateNfoContent(original, metadata);
      if (update.changed.length === 0) {
        entry.reason = "内容已经一致";
        report.skipped++;
        report.entries.push(entry);
        continue;
      }
      entry.status = "update";
      entry.changed = update.changed;
      report.updated++;
      if (apply) writeFileSync(nfoPath, update.content, "utf8");
      report.entries.push(entry);
    } catch (err) {
      // 单条失败不中断整批: 一个只读盘不该让 3000 个文件全白跑。
      entry.ok = false;
      entry.error = err instanceof Error ? err.message : String(err);
      report.errors++;
      report.entries.push(entry);
    }
  }

  return report;
}
