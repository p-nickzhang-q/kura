import { AppError, EXIT } from "../exit";
import type { Runtime } from "../runtime";
import { TaskLog } from "../observability/task-log";

/**
 * 持久化任务队列。
 *
 * 与 Amane 的差别是刻意收窄的: 只有一张表 + 单 worker + 取消/重试, **没有**
 * 任务树、优先级、链式派生、cron。目的是回答一个问题:
 * "关掉软件再打开, 我还能知道上次跑到哪、并且继续跑。"
 *
 * 没有常驻 worker: 任务由 CLI/GUI 在进程内运行, 进程退出后 mark_* 把它标成
 * `interrupted`(启动时 recover), 下次 `task retry` 继续。
 */
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export const TERMINAL_STATUSES: TaskStatus[] = ["done", "failed", "cancelled", "interrupted"];

export interface TaskRow {
  id: number;
  type: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  total: number;
  processed: number;
  failed: number;
  error: string | null;
  ownerPid: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

interface RawRow {
  id: number;
  type: string;
  status: TaskStatus;
  payload: string;
  total: number;
  processed: number;
  failed: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  owner_pid: number | null;
}

function toTask(row: RawRow): TaskRow {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload: safeParse(row.payload),
    total: row.total,
    processed: row.processed,
    failed: row.failed,
    error: row.error,
    ownerPid: row.owner_pid,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function safeParse(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createTask(
  rt: Runtime,
  input: { type: string; payload?: Record<string, unknown>; total?: number },
): TaskRow {
  rt.db.run("insert into tasks (type, status, payload, total) values (?, 'queued', ?, ?)", [
    input.type,
    JSON.stringify(input.payload ?? {}),
    input.total ?? 0,
  ]);
  const row = rt.db.get<RawRow>("select * from tasks where id = last_insert_rowid()");
  return toTask(row!);
}

export function getTask(rt: Runtime, id: number): TaskRow | null {
  const row = rt.db.get<RawRow>("select * from tasks where id = ?", [id]);
  return row ? toTask(row) : null;
}

export function listTasks(rt: Runtime, options: { limit?: number; status?: TaskStatus } = {}): TaskRow[] {
  const limit = options.limit ?? 20;
  const rows = options.status
    ? rt.db.all<RawRow>("select * from tasks where status = ? order by id desc limit ?", [options.status, limit])
    : rt.db.all<RawRow>("select * from tasks order by id desc limit ?", [limit]);
  return rows.map(toTask);
}

export function markRunning(rt: Runtime, id: number): void {
  rt.db.run("update tasks set status = 'running', started_at = unixepoch(), owner_pid = ? where id = ?", [
    process.pid,
    id,
  ]);
}

export function updateProgress(rt: Runtime, id: number, progress: { processed: number; failed: number; total?: number }): void {
  rt.db.run("update tasks set processed = ?, failed = ?, total = coalesce(?, total) where id = ?", [
    progress.processed,
    progress.failed,
    progress.total ?? null,
    id,
  ]);
}

export function finishTask(rt: Runtime, id: number, status: TaskStatus, error?: string | null): void {
  rt.db.run("update tasks set status = ?, error = ?, finished_at = unixepoch() where id = ?", [
    status,
    error ?? null,
    id,
  ]);
}

/** 只取消还没开始的任务; 运行中的取消走进程内 AbortSignal。 */
export function cancelTask(rt: Runtime, id: number): boolean {
  const task = getTask(rt, id);
  if (!task || task.status !== "queued") return false;
  finishTask(rt, id, "cancelled", "提交后在执行前被取消");
  return true;
}

/** 重试 = 用同一份 payload 新建一个任务, 不继承原任务的历史。 */
export function retryTask(rt: Runtime, id: number): TaskRow {
  const task = getTask(rt, id);
  if (!task) throw new AppError(`任务不存在: ${id}`, EXIT.NOT_FOUND, { id });
  if (!TERMINAL_STATUSES.includes(task.status)) {
    throw new AppError(`任务尚未结束 (${task.status}), 不能重试`, EXIT.USAGE, { id, status: task.status });
  }
  return createTask(rt, { type: task.type, payload: task.payload, total: task.total });
}

/**
 * 进程启动时调用: 上次被强杀的任务会永远停在 `running`,
 * 改成 `interrupted` 才能让人看出"跑到一半断了", 而不是"还在跑"。
 */
export function recoverInterrupted(rt: Runtime): number {
  const rows = rt.db.all<{ id: number; owner_pid: number | null }>(
    "select id, owner_pid from tasks where status = 'running'",
  );
  // 只回收"宿主进程已经不在了"的任务: GUI 正在跑的时候另一个 CLI 命令打开库,
  // 不能把它的任务误标成中断。
  const orphans = rows.filter((row) => !isAlive(row.owner_pid));
  for (const row of orphans) {
    rt.db.run("update tasks set status = 'interrupted', finished_at = unixepoch() where id = ?", [row.id]);
    new TaskLog(rt.paths.logDir, row.id, "recover").write("interrupted", { note: "宿主进程已退出" });
  }
  return orphans.length;
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次任务运行的上下文: 进度、日志、取消。
 * 任务实现只依赖这个接口, 不直接碰 tasks 表。
 */
export interface TaskRun {
  id: number;
  log: TaskLog;
  signal: AbortSignal;
  progress(processed: number, failed: number, total?: number): void;
  cancelled(): boolean;
}

export async function runTask<T>(
  rt: Runtime,
  task: TaskRow,
  signal: AbortSignal,
  body: (run: TaskRun) => Promise<{ result: T; processed: number; failed: number }>,
): Promise<{ task: TaskRow; result: T | null }> {
  markRunning(rt, task.id);
  const log = new TaskLog(rt.paths.logDir, task.id, task.type);
  log.write("start", { type: task.type, payload: task.payload, total: task.total });

  const run: TaskRun = {
    id: task.id,
    log,
    signal,
    progress: (processed, failed, total) => {
      updateProgress(rt, task.id, { processed, failed, total });
    },
    cancelled: () => signal.aborted,
  };

  try {
    const outcome = await body(run);
    const status: TaskStatus = signal.aborted ? "cancelled" : "done";
    updateProgress(rt, task.id, { processed: outcome.processed, failed: outcome.failed });
    finishTask(rt, task.id, status);
    log.write("end", { status, processed: outcome.processed, failed: outcome.failed });
    return { task: getTask(rt, task.id)!, result: outcome.result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishTask(rt, task.id, signal.aborted ? "cancelled" : "failed", err instanceof AppError ? null : message);
    log.write("error", { message });
    if (err instanceof AppError) throw err;
    throw new AppError(`任务失败: ${message}`, EXIT.INTERNAL, { taskId: task.id });
  }
}
