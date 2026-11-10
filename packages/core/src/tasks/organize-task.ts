import type { Runtime } from "../runtime";
import { findLibrary } from "../db/rows";
import type { Library } from "../domain/materialize";
import { AppError, EXIT } from "../exit";
import { organize, type OrganizeReport } from "./organize";
import { organizeVideo, type VideoOrganizeReport } from "./organize-video";
import { createTask, getTask, runTask, type TaskRow } from "./queue";

/**
 * 「执行整理」一条任务行。
 *
 * 以前它是 IPC 里一个 await: 搬 47 个文件 + 写 1,225 份 nfo + 复制 312 张图,
 * 全程只有一个"进行中…", 关掉窗口就再也不知道跑到哪 —— 而整理是目前**唯一会移动用户文件**
 * 的动作, 更该能看见、能停下来。
 */
export interface OrganizeTaskOptions {
  libraryId: number;
  apply: boolean;
}

export async function organizeTask(
  rt: Runtime,
  options: OrganizeTaskOptions,
  signal: AbortSignal,
  onProgress?: (progress: { index: number; total: number; key: string }) => void,
): Promise<{ task: TaskRow; report: OrganizeReport | VideoOrganizeReport | null; cancelled: boolean }> {
  const library = findLibrary(rt.db, String(options.libraryId));
  if (!library) throw new AppError(`库不存在: ${options.libraryId}`, EXIT.NOT_FOUND, { libraryId: options.libraryId });

  // 干跑不建任务行(它不改磁盘也不改库), 只有真搬运才记一条
  if (!options.apply) {
    const report = await runOrganize(rt, library, false, signal, (progress) =>
      onProgress?.({ index: progress.index, total: progress.total, key: progress.path }),
    );
    return { task: { id: 0 } as TaskRow, report, cancelled: false };
  }

  // 先算一遍计划只为拿到**真实工作量**: 以前任务 total 直接取 entries.length,
  // 而计划里一半以上是 skip(已在目标位置), 于是"整理 2754"里真正的搬运只有几十个。
  const planned = await runOrganize(rt, library, false, signal);
  const total = planned.plan.summary.move + planned.plan.summary.writeNfo + planned.plan.summary.copyImage;

  const task = createTask(rt, {
    type: "organize",
    payload: { libraryId: library.id, domain: library.domain },
    total,
  });

  const { result } = await runTask(rt, task, signal, async (run) => {
    const failures: { key: string; error: string; index: number }[] = [];
    const report = await runOrganize(rt, library, true, run.signal, (progress) => {
      run.progress(progress.index, failures.length, total);
      onProgress?.({ index: progress.index, total, key: progress.path });
    }, undefined, (entry, progress) => {
      if (entry.ok) return;
      failures.push({ key: entry.entry.to ?? entry.entry.from ?? "", error: entry.error ?? "未知原因", index: progress.index });
      // 失败原因进 jsonl: 任务详情的「失败 N」靠它列出是哪几个、为什么
      run.log.write("item", { index: progress.index, key: entry.entry.to ?? entry.entry.from ?? "", ok: false, error: entry.error });
    });
    const applied = (report as VideoOrganizeReport).applied ?? (report as OrganizeReport).applied ?? [];
    return {
      result: report,
      processed: applied.filter((entry) => entry.entry.action !== "skip").length,
      failed: failures.length,
    };
  });

  return { task: getTask(rt, task.id) ?? task, report: result, cancelled: signal.aborted };
}

async function runOrganize(
  rt: Runtime,
  library: Library,
  apply: boolean,
  signal: AbortSignal,
  onProgress?: (progress: { index: number; total: number; action: string; path: string }) => void,
  _unused?: undefined,
  onResult?: (entry: { ok: boolean; error?: string; entry: { from?: string; to?: string } }, progress: { index: number; total: number }) => void,
): Promise<OrganizeReport | VideoOrganizeReport> {
  const common = {
    library,
    apply,
    signal,
    ...(onProgress ? { onProgress } : {}),
    ...(onResult ? { onResult } : {}),
  };
  return library.domain === "video" ? organizeVideo(rt, common) : organize(rt, common);
}
