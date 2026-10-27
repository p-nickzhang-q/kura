import { AppError, EXIT, scan, type Runtime } from "@kura/core";
import type { ArgSpec, ParsedArgs } from "./args";
import type { Output } from "./output";
import { VERSION } from "./version";

export interface CommandContext {
  /** 命令声明 needsDb: false 时为 null; 用 ctx.rt! 前先看 needsDb。 */
  rt: Runtime | null;
  out: Output;
}

export interface Command {
  name: string;
  summary: string;
  /** 需要的参数: 同一份 spec 驱动解析、`--help` 与 `schema` 输出。 */
  args: ArgSpec[];
  needsDb: boolean;
  run(ctx: CommandContext, args: ParsedArgs): Promise<unknown>;
  /** text 模式的渲染; 不写副作用。 */
  render(data: never): string;
}

/** 全局参数: 所有命令都接受, 因此不进 `schema` 的 commands[].args, 单独暴露。 */
export const GLOBAL_ARGS: ArgSpec[] = [
  { name: "json", type: "boolean", description: "机器通道输出 (非 TTY 时自动开启)", default: false },
  { name: "data-dir", type: "string", description: "覆盖数据目录 (默认见 paths.ts)" },
  { name: "stream", type: "boolean", description: "以 JSONL 流式输出事件, 最后一行是结果", default: false },
  { name: "yes", type: "boolean", description: "跳过交互确认 (当前无交互命令, 预留)", default: false },
  { name: "help", type: "boolean", description: "显示帮助", default: false },
  { name: "version", type: "boolean", description: "显示版本", default: false },
];

export const COMMANDS: Command[] = [
  {
    name: "scan",
    summary: "扫描目录, 把文件指纹写入库 (幂等; 重复扫描应全部 unchanged)",
    needsDb: true,
    args: [
      { name: "root", type: "string", description: "要扫描的目录", positional: true, required: true },
      { name: "dry-run", type: "boolean", description: "只报告变更, 不写库", default: false },
    ],
    async run(ctx, args) {
      const root = args.positionals.root!;
      const dryRun = Boolean(args.options["dry-run"]);
      ctx.out.log(`扫描 ${root}${dryRun ? " (dry-run)" : ""}`);
      const report = await scan(ctx.rt!, {
        root,
        dryRun,
        onEvent: (event) => ctx.out.event({ ...event, event: "file" }),
      });
      return report;
    },
    render(data: { root: string; dryRun: boolean; counts: Record<string, number>; durationMs: number }) {
      const { counts } = data;
      return [
        `扫描完成: ${data.root}${data.dryRun ? " (dry-run, 未写库)" : ""}`,
        `  新增 ${counts.added} · 更新 ${counts.updated} · 未变 ${counts.unchanged} · 删除 ${counts.removed}`,
        `  耗时 ${data.durationMs}ms`,
      ].join("\n");
    },
  },
  {
    name: "doctor",
    summary: "自检: 数据目录、数据库、驱动、schema 版本",
    needsDb: true,
    args: [],
    async run(ctx) {
      const items = ctx.rt!.db.get<{ c: number }>("select count(*) as c from items");
      return {
        version: VERSION,
        dataDir: ctx.rt!.paths.dataDir,
        dbFile: ctx.rt!.paths.dbFile,
        dbRuntime: ctx.rt!.dbInfo.runtime,
        platform: process.platform,
        nodeVersion: process.version,
        schemaVersion: ctx.rt!.schemaVersion,
        itemCount: items?.c ?? 0,
      };
    },
    render(data: { dataDir: string; dbRuntime: string; schemaVersion: number; itemCount: number; version: string }) {
      return [
        `kura ${data.version}`,
        `  数据目录   ${data.dataDir}`,
        `  SQLite     ${data.dbRuntime}`,
        `  schema v${data.schemaVersion}`,
        `  条目       ${data.itemCount}`,
      ].join("\n");
    },
  },
  {
    name: "schema",
    summary: "输出机器可读的命令清单 (agent 用它做工具发现)",
    needsDb: false,
    args: [],
    async run() {
      return {
        version: VERSION,
        globalArgs: GLOBAL_ARGS.filter((a) => a.name !== "help" && a.name !== "version"),
        commands: COMMANDS.filter((c) => c.name !== "schema").map((c) => ({
          name: c.name,
          summary: c.summary,
          args: c.args,
        })),
        exitCodes: {
          "0": "成功",
          "2": "用法错误: 修正参数后重试",
          "3": "可重试: 数据库占用 / 网络抖动, 原样重试",
          "4": "需要人: 缺凭据或需确认, 停下来问人",
          "5": "目标不存在: 换参数, 不要重试",
          "10": "内部错误 (bug): 报告, 不要重试",
        },
        env: {
          KURA_DATA_DIR: "覆盖数据目录",
          KURA_DEBUG: "打印异常栈到 stderr",
        },
      };
    },
    render(data: { commands: { name: string; summary: string }[] }) {
      return data.commands.map((c) => `${c.name.padEnd(8)} ${c.summary}`).join("\n");
    },
  },
];

export function findCommand(name: string): Command {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) throw new AppError(`未知命令: ${name}`, EXIT.USAGE, { command: name });
  return command;
}

export function helpText(): string {
  const lines = [
    `kura ${VERSION} — 桌面应用 + 面向 agent 的 CLI, 无守护进程`,
    "",
    "用法: kura <command> [args]",
    "",
    "命令:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(8)} ${c.summary}`),
    "",
    "全局参数:",
    ...GLOBAL_ARGS.map((a) => `  --${a.name.padEnd(12)} ${a.description}`),
    "",
    "示例:",
    "  kura scan ~/Videos --dry-run",
    "  kura scan ~/Videos --json",
    "  kura schema --json",
  ];
  return lines.join("\n");
}
