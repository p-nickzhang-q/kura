/**
 * 退出码是 CLI 与 agent 之间的契约, 不是给人看的。
 * 改动此表等于破坏 API, 需同步 docs/dev/cli-contract.md 与 cli 的 `schema` 输出。
 */
export const EXIT = {
  OK: 0,
  /** 用法错误: 参数缺失、互斥、未知子命令。agent 应修正参数后重试。 */
  USAGE: 2,
  /** 可重试: 数据库被占用、网络抖动。agent 可原样重试。 */
  RETRYABLE: 3,
  /** 需要人: 缺凭据、需要确认。agent 必须停下来问人, 不要重试。 */
  NEEDS_INPUT: 4,
  /** 目标不存在。agent 应换参数, 不要重试。 */
  NOT_FOUND: 5,
  /** 内部错误 (bug)。agent 应报告, 不要重试。 */
  INTERNAL: 10,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** 领域错误: 携带退出码, CLI 层只做一次映射, 不做字符串匹配。 */
export class AppError extends Error {
  readonly exitCode: ExitCode;
  /** 给 agent 的结构化补充信息, 会进入 JSON 输出的 error.details。 */
  readonly details?: Record<string, unknown>;

  constructor(message: string, exitCode: ExitCode = EXIT.INTERNAL, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof AppError) return err.exitCode === EXIT.RETRYABLE;
  const code = (err as { code?: string } | null)?.code;
  // SQLITE_BUSY / SQLITE_LOCKED: 另一个进程 (GUI 或另一个 CLI) 正在写。
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}
