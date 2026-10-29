import { buildPlan, applyPlan, type ApplyResult, type Library, type Plan, type PlanInput } from "../domain/materialize";
import type { Metadata } from "../domain/types";
import { parsePhase, rowToMetadata, type ItemRow } from "../db/rows";
import type { Runtime } from "../runtime";
import { cachedPoster } from "./resources";

export interface OrganizeOptions {
  library: Library;
  /** 默认 false —— 见 ADR 0002: 整理是唯一不可逆的动作。 */
  apply?: boolean;
}

export interface OrganizeReport {
  plan: Plan;
  applied: ApplyResult[] | null;
}

/**
 * ORGANIZE: 生成计划(纯计算), 只有 apply 时才碰磁盘。
 * 目标路径只来自 `items` + `libraries.template`; 文件名只来自番号与相位,
 * 不使用旧文件名 —— 否则改名规则会随文件历史漂移。
 */
export async function organize(rt: Runtime, opts: OrganizeOptions): Promise<OrganizeReport> {
  const apply = opts.apply ?? false;

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
    inputs.push({ path: row.path, metadata, phase: parsePhase(row.phase), posterPath: cachedPoster(rt, metadata)?.path });
  }

  const plan = buildPlan(opts.library, inputs);
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
