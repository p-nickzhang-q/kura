import { buildPlan, applyPlan, pruneEmptyDirs, type ApplyResult, type Library, type Plan, type PlanEntry, type PlanInput } from "../domain/materialize";
import type { Metadata } from "../domain/types";
import { existsSync } from "node:fs";
import { moveIndexPath } from "../db/rows";
import { dirname, extname, sep } from "node:path";
import { parsePhase, rowToMetadata, type ItemRow } from "../db/rows";
import type { Runtime } from "../runtime";
import { cachedPoster, cachedThumb, findSidecarImages } from "./resources";

export interface OrganizeOptions {
  library: Library;
  /** 默认 false —— 见 ADR 0002: 整理是唯一不可逆的动作。 */
  apply?: boolean;
  /** 停止信号(只对真搬运有意义: 已经搬完的保持原样)。 */
  signal?: AbortSignal;
  /** 进度: 一个计划条目一次。 */
  onProgress?: (progress: { index: number; total: number; action: "move" | "write-nfo" | "copy-image" | "skip"; path: string }) => void;
  /** 每个条目结束后的结果(成功/失败/本来就不用动)。 */
  onResult?: (result: { entry: PlanEntry; ok: boolean; error?: string; unchanged?: boolean }, progress: { index: number; total: number }) => void;
}

export interface OrganizeReport {
  plan: Plan;
  applied: ApplyResult[] | null;
  /** 该库被设为"只索引不整理", 本次什么都没算也没动。 */
  skipped?: boolean;
  reason?: string;
  /** 搬空之后删掉的源目录。 */
  removedDirs?: string[];
  /** 源目录里还有东西(字幕等)、所以没删的。 */
  leftoverDirs?: { dir: string; files: string[] }[];
  /** 删掉的 Kura 自己生成的残留。 */
  removedFiles?: string[];
}

/**
 * ORGANIZE: 生成计划(纯计算), 只有 apply 时才碰磁盘。
 * 目标路径只来自 `items` + `libraries.template`; 文件名只来自番号与相位,
 * 不使用旧文件名 —— 否则改名规则会随文件历史漂移。
 */
export async function organize(rt: Runtime, opts: OrganizeOptions): Promise<OrganizeReport> {
  const apply = opts.apply ?? false;

  // 旧成品库: 允许扫描/刮削, 但绝不动文件。见 ADR 0003。
  if (opts.library.organizeEnabled === false) {
    return {
      plan: {
        libraryId: opts.library.id,
        libraryRoot: opts.library.root,
        entries: [],
        summary: { move: 0, writeNfo: 0, copyImage: 0, skip: 0 },
      },
      applied: null,
      skipped: true,
      reason: "该库已设为不整理 (只索引), 不会移动或改名文件",
    };
  }

  const rows = rt.db.all<ItemRow & { path: string; phase: string | null }>(
    `select m.path, m.phase, i.*
     from media_files m join items i on i.number = m.number
     where m.library_id = ? and m.number is not null
     order by m.path`,
    [opts.library.id],
  );

  const inputs: PlanInput[] = [];
  for (const row of rows) {
    const metadata: Metadata = rowToMetadata(row);
    if (!metadata.title) continue; // 没刮削过的条目不整理
    // 优先用缓存 (刮削时下的), 其次用视频旁边已经存在的图 (别的工具下的)
    const sidecar = findSidecarImages(row.path);
    inputs.push({
      path: row.path,
      metadata,
      phase: parsePhase(row.phase),
      posterPath: cachedPoster(rt, metadata)?.path ?? sidecar.poster ?? undefined,
      thumbPath: cachedThumb(rt, metadata)?.path ?? sidecar.thumb ?? undefined,
    });
  }

  const plan = await buildPlan(opts.library, inputs);
  const applied = apply
    ? await applyPlan(plan, { signal: opts.signal, onProgress: opts.onProgress, onResult: opts.onResult })
    : null;

  // 移动成功后必须同步索引, 否则下一次扫描会把"同一文件的旧路径"判成 removed + added。
  if (applied) {
    rt.db.exec("begin");
    try {
      for (const result of applied) {
        const { entry } = result;
        if (!result.ok || !entry.from || !entry.to) continue;
        if (entry.action === "move") {
          moveIndexPath(rt.db, entry.from, entry.to);
          continue;
        }
        // 计划说"目标就是它", 而源文件已经不在了 —— 说明上一次整理搬了文件、索引没跟上。
        // 不纠正的话, 索引会一直指着空目录, nfo 同步往里写就是 ENOENT, 永远不收敛。
        if (entry.action === "skip" && !existsSync(entry.from) && existsSync(entry.to)) {
          moveIndexPath(rt.db, entry.from, entry.to);
        }
      }
      rt.db.exec("commit");
    } catch (err) {
      rt.db.exec("rollback");
      throw err;
    }
  }

  if (!applied) return { plan, applied };

  // 搬空的源目录顺手清掉 —— 只删空目录, 还有东西的一律留着并报出来
  const targets = plan.entries.filter((entry) => entry.action !== "skip" && entry.to).map((entry) => entry.to!);
  const byDir = new Map<string, string[]>();
  for (const result of applied) {
    if (!result.ok || result.entry.action !== "move" || !result.entry.from) continue;
    const dir = dirname(result.entry.from);
    // 目标目录可能就是源目录本身: 那是新结构, 不是"搬空的旧目录"
    if (targets.some((target) => target === dir || target.startsWith(`${dir}${sep}`))) continue;
    const base = result.entry.from.slice(result.entry.from.length - extname(result.entry.from).length);
    byDir.set(dir, [...(byDir.get(dir) ?? []), base.slice(dir.length + 1)]);
  }
  const prune = await pruneEmptyDirs(
    [opts.library.root],
    [...byDir].map(([dir, bases]) => ({ dir, bases })),
  );
  return {
    plan,
    applied,
    removedDirs: prune.removed,
    leftoverDirs: prune.leftover,
    removedFiles: prune.removedFiles,
  };
}
