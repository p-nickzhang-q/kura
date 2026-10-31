import { buildPlan, applyPlan, type ApplyResult, type Library, type Plan, type PlanInput } from "../domain/materialize";
import type { Metadata } from "../domain/types";
import { parsePhase, rowToMetadata, type ItemRow } from "../db/rows";
import type { Runtime } from "../runtime";
import { cachedPoster, cachedThumb } from "./resources";

export interface OrganizeOptions {
  library: Library;
  /** 默认 false —— 见 ADR 0002: 整理是唯一不可逆的动作。 */
  apply?: boolean;
}

export interface OrganizeReport {
  plan: Plan;
  applied: ApplyResult[] | null;
  /** 该库被设为"只索引不整理", 本次什么都没算也没动。 */
  skipped?: boolean;
  reason?: string;
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
    inputs.push({
      path: row.path,
      metadata,
      phase: parsePhase(row.phase),
      posterPath: cachedPoster(rt, metadata)?.path,
      thumbPath: cachedThumb(rt, metadata)?.path,
    });
  }

  const plan = await buildPlan(opts.library, inputs);
  const applied = apply ? await applyPlan(plan) : null;

  // 移动成功后必须同步索引, 否则下一次扫描会把"同一文件的旧路径"判成 removed + added。
  if (applied) {
    rt.db.exec("begin");
    try {
      for (const result of applied) {
        const { entry } = result;
        if (result.ok && entry.action === "move" && entry.from && entry.to) {
          rt.db.run("update media_files set path = ? where path = ?", [entry.to, entry.from]);
        }
      }
      rt.db.exec("commit");
    } catch (err) {
      rt.db.exec("rollback");
      throw err;
    }
  }

  return { plan, applied };
}
