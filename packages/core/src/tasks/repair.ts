import { existsSync, unlinkSync } from "node:fs";
import { findLibrary, listLibraries } from "../db/rows";
import { nfoPathFor } from "../domain/nfo";
import type { Runtime } from "../runtime";
import { organize } from "./organize";
import { organizeVideo } from "./organize-video";

/**
 * 修「文件搬走了、索引没跟上」的陈旧行。
 *
 * 事故现场: 用户库里 20 部电影已经躺在 `E:\视频\<片名> (年)\` 里, 而 `media_files.path`
 * 还指着整理以前的 `E:\视频\movie\2013-5-15\...`。表现就是详情页「打开位置」点了没反应、
 * NFO 同步往空目录里写 nfo。
 *
 * 怎么修: **不另写一套路径推导**, 直接跑一次整理的干跑计划 —— 计划里的 `from → to`
 * 就是"如果现在整理一次, 这个文件该去哪"。若 `from` 没了而 `to` 在, 说明搬是搬了,
 * 只是索引没改, 把 path 改过去即可(动画、集号、模板全都由计划负责, 这里不重复判断)。
 *
 * 只认"from 不在 + to 在"这一种情况。两个都在 → 是真正的重复, 该由人决定;
 * 两个都不在 → 文件真丢了, 修不了。
 */
export interface PathRepair {
  libraryId: number;
  library: string;
  from: string;
  to: string;
  /** 条目身份, 方便核对。 */
  key: string | null;
  /** 旧位置留下的、已经没人指向的 nfo。 */
  orphanNfo: string | null;
}

export interface PathRepairReport {
  dryRun: boolean;
  /** 修好的(或 dry-run 时"将要修的")。 */
  repaired: PathRepair[];
  /** 文件真的不在了, 修不了; 扫描会清掉这些行。 */
  missing: { libraryId: number; path: string }[];
  /** 两个位置都在: 多半是真的重复, 不自动动。 */
  ambiguous: { libraryId: number; from: string; to: string }[];
}

export async function repairIndexPaths(
  rt: Runtime,
  options: { libraryId?: number; apply?: boolean } = {},
): Promise<PathRepairReport> {
  const apply = options.apply === true;
  const libraries =
    options.libraryId === undefined
      ? listLibraries(rt.db)
      : [findLibrary(rt.db, String(options.libraryId))].filter((library) => library !== undefined);

  const report: PathRepairReport = { dryRun: !apply, repaired: [], missing: [], ambiguous: [] };

  for (const library of libraries) {
    // 整理计划就是"文件应该在哪"的唯一答案; 两个域各算各的
    const plan =
      library.domain === "video"
        ? (await organizeVideo(rt, { library })).plan
        : (await organize(rt, { library })).plan;

    // 计划里还有 copy-image(缓存图 → 海报)这类条目, 它们的 from 不是索引行。
    // 只认 media_files 里真有的路径, 否则会把图片缓存也算成"要修的路径"。
    const indexed = new Set(
      rt.db
        .all<{ path: string }>("select path from media_files where library_id = ?", [library.id])
        .map((row) => row.path),
    );

    for (const entry of plan.entries) {
      if (!entry.from || !entry.to || entry.from === entry.to) continue;
      if (!indexed.has(entry.from)) continue;
      const fromThere = existsSync(entry.from);
      const toThere = existsSync(entry.to);
      if (fromThere && toThere) {
        report.ambiguous.push({ libraryId: library.id, from: entry.from, to: entry.to });
        continue;
      }
      if (fromThere || !toThere) {
        // 源还在(没搬) → 正常情况; 两头都没有 → 文件真丢了
        if (!fromThere && !toThere) report.missing.push({ libraryId: library.id, path: entry.from });
        continue;
      }

      const key = rt.db.get<{ number: string | null }>("select number from media_files where path = ?", [entry.from])?.number ?? null;
      const orphanNfo = nfoPathFor(entry.from);
      report.repaired.push({
        libraryId: library.id,
        library: library.name,
        from: entry.from,
        to: entry.to,
        key,
        orphanNfo: existsSync(orphanNfo) ? orphanNfo : null,
      });

      if (apply) {
        rt.db.run("update media_files set path = ? where path = ?", [entry.to, entry.from]);
        // 旧位置只剩 Kura 自己写的 nfo: 影片已经搬走, 这份 nfo 没人会读, 留着只会骗人
        if (existsSync(orphanNfo)) unlinkSync(orphanNfo);
      }
    }
  }

  return report;
}
