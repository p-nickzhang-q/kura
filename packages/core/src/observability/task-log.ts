import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 任务日志: 一次运行一个 JSONL 文件。
 *
 * 为什么是文件而不是只写 DB: 日志要能跨进程读、能直接 `tail`、能在数据库坏掉时仍然存在。
 * 目录归进程自己管 (dataDir/logs/tasks), 与媒体库无关。
 */
export interface TaskLogEvent {
  at: string;
  event: string;
  [key: string]: unknown;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1***"],
  [/((?:api[_-]?key|apikey|token|password|authorization)\s*[=:]\s*)["']?[^\s"',}]{6,}/gi, "$1***"],
];

/** 日志会落盘并且可能被贴到 issue 里, 所以写入前统一脱敏。 */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

export class TaskLog {
  private readonly file: string;

  constructor(logDir: string, taskId: number, type: string) {
    const dir = join(logDir, "tasks");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join(dir, `${String(taskId).padStart(6, "0")}-${stamp}-${type}.jsonl`);
  }

  get path(): string {
    return this.file;
  }

  write(event: string, data: Record<string, unknown> = {}): void {
    const line: TaskLogEvent = { at: new Date().toISOString(), event, ...data };
    // 单行 JSON, 便于 `jq` 或 `tail`; 换行符必须转义, 否则一条日志会裂成两行。
    appendFileSync(this.file, `${redact(JSON.stringify(line))}\n`, "utf8");
  }
}

/** 供 `kura logs` 与 GUI 列表用: 只读文件名, 不解析内容。 */
export function taskLogFiles(logDir: string): string[] {
  const dir = join(logDir, "tasks");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}
