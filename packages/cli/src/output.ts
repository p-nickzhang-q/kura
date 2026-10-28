import { AppError, EXIT, exitCodeName, isRetryable } from "@kura/core";

export type OutputMode = "json" | "text";

/**
 * 输出契约 (详见 docs/dev/cli-contract.md):
 *  - stdout = 机器通道。JSON 模式下始终是一行一个完整 JSON 对象, 成功与失败都走这里。
 *  - stderr = 人通道。日志、进度、诊断, agent 可以整段丢弃。
 *  - 退出码 = 主信号。agent 应当先看退出码, 再看 stdout 里的 error 对象。
 */
export class Output {
  constructor(
    readonly mode: OutputMode,
    /** JSON 模式下是否输出事件流。默认只给最终结果, 避免 agent 要过滤多行。 */
    readonly stream = false,
  ) {}

  /** 流式事件 (--stream)。仅 JSON 模式输出, text 模式转成一行人类可读进度。 */
  event(payload: Record<string, unknown>): void {
    if (this.mode === "json" && !this.stream) return;
    if (this.mode === "json") {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    process.stderr.write(`· ${describeEvent(payload)}\n`);
  }

  /** 正常结束。render 只用于 text 模式, 不应包含副作用。 */
  result(command: string, data: unknown, render?: (data: never) => string): void {
    if (this.mode === "json") {
      process.stdout.write(`${JSON.stringify({ ok: true, command, data })}\n`);
      return;
    }
    process.stdout.write(render ? `${render(data as never)}\n` : `${JSON.stringify(data, null, 2)}\n`);
  }

  /** 失败。返回进程退出码, 由 main 直接交给 process.exit。 */
  fail(command: string | null, err: unknown): number {
    const appErr =
      err instanceof AppError
        ? err
        : new AppError(err instanceof Error ? err.message : String(err), isRetryable(err) ? EXIT.RETRYABLE : EXIT.INTERNAL);

    const exitCode = appErr.exitCode;
    const code = exitCodeName(exitCode);

    if (this.mode === "json") {
      const error = {
        code,
        message: appErr.message,
        retryable: exitCode === EXIT.RETRYABLE,
        details: appErr.details ?? null,
      };
      process.stdout.write(`${JSON.stringify({ ok: false, command, error })}\n`);
      // 人通道保留完整栈, 便于 GUI 打日志, 但 agent 不需要读它。
      process.stderr.write(`${code}: ${appErr.message}\n`);
    } else {
      process.stderr.write(`error [${code}]: ${appErr.message}\n`);
      if (exitCode === EXIT.USAGE) process.stderr.write(`提示: 运行 \`kura schema\` 查看完整参数。\n`);
    }
    if (process.env.KURA_DEBUG && appErr.stack) process.stderr.write(`${appErr.stack}\n`);
    return exitCode;
  }

  log(message: string): void {
    process.stderr.write(`${message}\n`);
  }
}

function describeEvent(payload: Record<string, unknown>): string {
  const type = String(payload.type ?? "event");
  const path = payload.path ? String(payload.path) : "";
  return path ? `${type} ${path}` : type;
}
