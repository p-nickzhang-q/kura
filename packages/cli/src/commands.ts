import {
  AppError,
  CONTENT_TYPE_LABEL,
  CONTENT_TYPES,
  EXIT,
  createLibrary,
  defaultSources,
  detectContentType,
  findLibrary,
  getItem,
  isSiteKey,
  listItems,
  listLibraries,
  organize,
  pendingKeys,
  scan,
  scrape,
  type ContentType,
  type ItemKey,
} from "@kura/core";
import type { ArgSpec, ParsedArgs } from "./args";
import type { Output } from "./output";
import { VERSION } from "./version";

export interface CommandContext {
  /** 命令声明 needsDb: false 时为 null; 用 ctx.rt! 前先看 needsDb。 */
  rt: import("@kura/core").Runtime | null;
  out: Output;
}

export interface Command {
  name: string;
  summary: string;
  /** 同一份 spec 驱动解析、`--help` 与 `schema` 输出。 */
  args: ArgSpec[];
  needsDb: boolean;
  run(ctx: CommandContext, args: ParsedArgs): Promise<unknown>;
  render(data: never): string;
}

export const GLOBAL_ARGS: ArgSpec[] = [
  { name: "json", type: "boolean", description: "机器通道输出 (非 TTY 时自动开启)", default: false },
  { name: "data-dir", type: "string", description: "覆盖数据目录 (默认见 paths.ts)" },
  { name: "stream", type: "boolean", description: "以 JSONL 流式输出事件, 最后一行是结果", default: false },
  { name: "yes", type: "boolean", description: "跳过交互确认 (当前无交互命令, 预留)", default: false },
  { name: "help", type: "boolean", description: "显示帮助", default: false },
  { name: "version", type: "boolean", description: "显示版本", default: false },
];

function requireLibrary(ctx: CommandContext, ref: string) {
  const library = findLibrary(ctx.rt!.db, ref);
  if (!library) {
    throw new AppError(`媒体库不存在: ${ref}`, EXIT.NOT_FOUND, { library: ref });
  }
  return library;
}

function parseContentType(value: unknown): ContentType | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if ((CONTENT_TYPES as readonly string[]).includes(value)) return value as ContentType;
  const byLabel = CONTENT_TYPES.find((type) => CONTENT_TYPE_LABEL[type] === value);
  if (byLabel) return byLabel;
  throw new AppError(`未知类型: ${value}`, EXIT.USAGE, { types: CONTENT_TYPES as unknown as string[] });
}

export const COMMANDS: Command[] = [
  {
    name: "library",
    summary: "媒体库: list | add <名称> <根目录> [--template]",
    needsDb: true,
    args: [
      { name: "action", type: "string", description: "list 或 add", positional: true, required: true },
      { name: "name", type: "string", description: "库名 (add)", positional: true },
      { name: "root", type: "string", description: "库根目录 (add)", positional: true },
      { name: "template", type: "string", description: "整理模板, 相对库根", default: "{content_type}/{studio}/{number}" },
    ],
    async run(ctx, args) {
      const action = args.positionals.action;
      if (action === "list") return { libraries: listLibraries(ctx.rt!.db) };
      if (action !== "add") throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });

      const name = args.positionals.name;
      const root = args.positionals.root;
      if (!name || !root) throw new AppError("用法: library add <名称> <根目录>", EXIT.USAGE);
      const library = createLibrary(ctx.rt!.db, {
        name,
        root,
        template: String(args.options.template ?? ""),
      });
      return { library };
    },
    render(data: { libraries?: { name: string; root: string }[]; library?: { name: string; root: string; template: string } }) {
      if (data.library) return `已创建媒体库 ${data.library.name} → ${data.library.root}\n模板: ${data.library.template}`;
      const libraries = data.libraries ?? [];
      if (libraries.length === 0) return "还没有媒体库。用 `kura library add <名称> <根目录>` 添加。";
      return libraries.map((library) => `${library.name.padEnd(12)} ${library.root}`).join("\n");
    },
  },

  {
    name: "scan",
    summary: "扫描媒体库, 登记文件并解析番号 (REFRESH: 不抓网、不改名)",
    needsDb: true,
    args: [
      { name: "library", type: "string", description: "库名或 id", positional: true, required: true },
      { name: "dry-run", type: "boolean", description: "只报告, 不写库", default: false },
    ],
    async run(ctx, args) {
      const library = requireLibrary(ctx, args.positionals.library!);
      const report = await scan(ctx.rt!, {
        library,
        dryRun: Boolean(args.options["dry-run"]),
        onEvent: (event) => ctx.out.event({ ...event, event: "file" }),
      });
      return report;
    },
    render(data: { root: string; counts: Record<string, number>; durationMs: number; dryRun: boolean }) {
      const { counts } = data;
      return [
        `扫描完成: ${data.root}${data.dryRun ? " (dry-run)" : ""}`,
        `  新增 ${counts.added} · 更新 ${counts.updated} · 未变 ${counts.unchanged} · 移除 ${counts.removed} · 未识别 ${counts.unparsed}`,
        `  耗时 ${data.durationMs}ms`,
      ].join("\n");
    },
  },

  {
    name: "scrape",
    summary: "刮削: <番号> 或 --pending, 多源取字段并逐字段择优 (不动文件)",
    needsDb: true,
    args: [
      { name: "number", type: "string", description: "番号, 或 site:id 形式的站点键", positional: true },
      { name: "pending", type: "boolean", description: "刮削所有还没有标题的条目", default: false },
      { name: "source", type: "string", description: "覆盖来源路由, 逗号分隔 (如 fixture)" },
      { name: "fixtures", type: "string", description: "离线样本目录 (fixture 源用)" },
      { name: "type", type: "string", description: "无番号条目必须显式给类型" },
      { name: "limit", type: "number", description: "--pending 时的批大小", default: 50 },
      { name: "dry-run", type: "boolean", description: "只报告, 不写库", default: false },
    ],
    async run(ctx, args) {
      const registry = defaultSources();
      const fixturesDir = typeof args.options.fixtures === "string" ? args.options.fixtures : null;
      const sources =
        typeof args.options.source === "string" ? args.options.source.split(",").map((id) => id.trim()) : undefined;
      const dryRun = Boolean(args.options["dry-run"]);

      const runOne = (key: ItemKey) => scrape(ctx.rt!, { key, registry, fixturesDir, sources, dryRun });

      if (args.options.pending) {
        const keys = pendingKeys(ctx.rt!, Number(args.options.limit ?? 50));
        const reports = [];
        for (const key of keys) {
          try {
            reports.push(await runOne(key));
          } catch (err) {
            reports.push({ key: key.value, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return { pending: true, count: reports.length, reports };
      }

      const raw = args.positionals.number;
      if (!raw) throw new AppError("用法: scrape <番号> | scrape --pending", EXIT.USAGE);

      const explicitType = parseContentType(args.options.type);
      const key: ItemKey = isSiteKey(raw)
        ? {
            value: raw.toLowerCase(),
            number: null,
            contentType: explicitType ?? (() => {
              throw new AppError("site:id 形式的条目必须给 --type", EXIT.USAGE, { key: raw });
            })(),
          }
        : {
            value: raw.toUpperCase(),
            number: raw.toUpperCase(),
            contentType: explicitType ?? detectContentType(raw) ?? "censored",
          };

      return runOne(key);
    },
    render(data: unknown) {
      const single = data as {
        key: string;
        route: string[];
        skipped: string[];
        filled: string[];
        failures: { site: string; error: string }[];
        metadata?: { title?: string; actors?: string[] } | null;
      };
      if ("reports" in (data as object)) {
        const batch = data as { count: number; reports: { key: string; error?: string; filled?: string[] }[] };
        return [
          `批量刮削 ${batch.count} 条`,
          ...batch.reports.map((report) =>
            report.error ? `  ✗ ${report.key}: ${report.error}` : `  ✓ ${report.key} (${report.filled?.length ?? 0} 字段)`,
          ),
        ].join("\n");
      }
      const lines = [
        `${single.key}  来源: ${single.route.join(" → ") || "无"}${single.skipped.length ? ` (跳过未实现: ${single.skipped.join(", ")})` : ""}`,
        `  标题: ${single.metadata?.title ?? "(空)"}`,
        `  演员: ${single.metadata?.actors?.join(", ") ?? "(空)"}`,
        `  取到字段: ${single.filled.join(", ") || "无"}`,
      ];
      for (const failure of single.failures) lines.push(`  ! ${failure.site}: ${failure.error}`);
      return lines.join("\n");
    },
  },

  {
    name: "organize",
    summary: "整理: 生成计划 (默认 dry-run), --apply 才动磁盘",
    needsDb: true,
    args: [
      { name: "library", type: "string", description: "库名或 id", positional: true, required: true },
      { name: "apply", type: "boolean", description: "真的移动文件并写 NFO", default: false },
    ],
    async run(ctx, args) {
      const library = requireLibrary(ctx, args.positionals.library!);
      return organize(ctx.rt!, { library, apply: Boolean(args.options.apply) });
    },
    render(data: {
      plan: { entries: { action: string; from?: string; to?: string }[]; summary: Record<string, number> };
      applied: { ok: boolean; error?: string }[] | null;
    }) {
      const lines = [
        `整理计划: 移动 ${data.plan.summary.move} · 写 NFO ${data.plan.summary.writeNfo} · 跳过 ${data.plan.summary.skip}`,
      ];
      for (const entry of data.plan.entries.slice(0, 50)) {
        if (entry.action === "move") lines.push(`  → ${entry.from}\n    ${entry.to}`);
      }
      if (data.plan.entries.length > 50) lines.push(`  … 还有 ${data.plan.entries.length - 50} 条`);
      if (data.applied) {
        const failed = data.applied.filter((result) => !result.ok);
        lines.push(`已执行, 失败 ${failed.length} 项`);
        for (const result of failed) lines.push(`  ✗ ${result.error}`);
      } else {
        lines.push("(dry-run, 未动磁盘; 加 --apply 执行)");
      }
      return lines.join("\n");
    },
  },

  {
    name: "item",
    summary: "条目: get <番号> | list [--type] [--limit]",
    needsDb: true,
    args: [
      { name: "action", type: "string", description: "get 或 list", positional: true, required: true },
      { name: "number", type: "string", description: "番号 (get)", positional: true },
      { name: "type", type: "string", description: "按类型筛选 (list)" },
      { name: "limit", type: "number", description: "条数 (list)", default: 20 },
    ],
    async run(ctx, args) {
      const action = args.positionals.action;
      if (action === "get") {
        const number = args.positionals.number;
        if (!number) throw new AppError("用法: item get <番号>", EXIT.USAGE);
        const item = getItem(ctx.rt!, number.toUpperCase());
        if (!item) throw new AppError(`条目不存在: ${number}`, EXIT.NOT_FOUND, { number });
        return { item };
      }
      if (action === "list") {
        const items = listItems(ctx.rt!, {
          limit: Number(args.options.limit ?? 20),
          type: typeof args.options.type === "string" ? args.options.type : undefined,
        });
        return { items };
      }
      throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });
    },
    render(data: { item?: Record<string, unknown>; items?: Record<string, unknown>[] }) {
      if (data.item) {
        return Object.entries(data.item)
          .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
          .map(([key, value]) => `${key.padEnd(14)} ${Array.isArray(value) ? value.join(", ") : String(value)}`)
          .join("\n");
      }
      const items = data.items ?? [];
      if (items.length === 0) return "没有条目。先 `kura scan <库>`。";
      return items
        .map((item) => `${String(item.number).padEnd(14)} ${String(item.content_type).padEnd(11)} ${item.title ?? "(未刮削)"}`)
        .join("\n");
    },
  },

  {
    name: "source",
    summary: "来源: list (显示实现状态与路由)",
    needsDb: false,
    args: [{ name: "action", type: "string", description: "目前只有 list", positional: true, default: "list" }],
    async run(_ctx, args) {
      const action = args.positionals.action ?? "list";
      if (action !== "list") throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });
      return {
        sources: defaultSources()
          .list()
          .map((source) => ({
            id: source.id,
            label: source.label,
            status: source.status,
            contentTypes: source.contentTypes,
          })),
      };
    },
    render(data: { sources: { id: string; label: string; status: string }[] }) {
      return data.sources
        .map((source) => `${source.id.padEnd(10)} ${source.status.padEnd(6)} ${source.label}`)
        .join("\n");
    },
  },

  {
    name: "doctor",
    summary: "自检: 数据目录、数据库、驱动、schema 版本、库与条目数",
    needsDb: true,
    args: [],
    async run(ctx) {
      const counts = ctx.rt!.db.get<{ items: number; files: number; libraries: number }>(
        "select (select count(*) from items) as items, (select count(*) from media_files) as files, (select count(*) from libraries) as libraries",
      );
      return {
        version: VERSION,
        dataDir: ctx.rt!.paths.dataDir,
        dbFile: ctx.rt!.paths.dbFile,
        dbRuntime: ctx.rt!.dbInfo.runtime,
        platform: process.platform,
        nodeVersion: process.version,
        schemaVersion: ctx.rt!.schemaVersion,
        libraries: counts?.libraries ?? 0,
        items: counts?.items ?? 0,
        mediaFiles: counts?.files ?? 0,
      };
    },
    render(data: Record<string, unknown>) {
      return [
        `kura ${data.version}`,
        `  数据目录   ${data.dataDir}`,
        `  SQLite     ${data.dbRuntime}`,
        `  schema     v${data.schemaVersion}`,
        `  媒体库     ${data.libraries}`,
        `  条目       ${data.items}`,
        `  媒体文件   ${data.mediaFiles}`,
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
        globalArgs: GLOBAL_ARGS.filter((arg) => arg.name !== "help" && arg.name !== "version"),
        commands: COMMANDS.filter((command) => command.name !== "schema").map((command) => ({
          name: command.name,
          summary: command.summary,
          args: command.args,
        })),
        contentType: CONTENT_TYPES.map((type) => ({ id: type, label: CONTENT_TYPE_LABEL[type] })),
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
      return data.commands.map((command) => `${command.name.padEnd(10)} ${command.summary}`).join("\n");
    },
  },
];

export function findCommand(name: string): Command {
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (!command) throw new AppError(`未知命令: ${name}`, EXIT.USAGE, { command: name });
  return command;
}

export function helpText(): string {
  const lines = [
    `kura ${VERSION} — 番号制本地影片库管理器 (桌面 + agent CLI, 无守护进程)`,
    "",
    "用法: kura <command> [args]",
    "",
    "命令:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(10)} ${command.summary}`),
    "",
    "全局参数:",
    ...GLOBAL_ARGS.map((arg) => `  --${arg.name.padEnd(12)} ${arg.description}`),
    "",
    "典型流程:",
    "  kura library add 主库 ~/Videos",
    "  kura scan 主库",
    "  kura scrape ABC-123 --source fixture",
    "  kura organize 主库              # 只看计划",
    "  kura organize 主库 --apply      # 真的移动",
  ];
  return lines.join("\n");
}
