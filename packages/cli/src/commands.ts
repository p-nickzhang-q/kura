import {
  AppError,
  CONTENT_TYPES,
  CONTENT_TYPE_LABEL,
  DIMENSIONS,
  EXIT,
  HttpClient,
  LIBRARY_DOMAINS,
  LIBRARY_DOMAIN_LABEL,
  MAX_SCRAPE_ATTEMPTS,
  TEMPLATE_PLACEHOLDERS,
  actorIndexDrift,
  bindDirectory,
  bindLocalDirectory,
  cleanupEmptyDirs,
  clearFileEpisode,
  cachedPoster,
  cancelTask,
  countExhausted,
  countItems,
  countPending,
  createLibrary,
  createTask,
  defaultSources,
  deleteLibrary,
  deleteTask,
  detectContentType,
  detectRetypes,
  dimensionTemplate,
  downloadPoster,
  exitCodeName,
  exportTvNfo,
  repairIndexPaths,
  relocateLibrary,
  recoverFromNfo,
  findLibrary,
  findResource,
  getItem,
  getTask,
  isDmmConfigured,
  isItemSortField,
  isLibraryDomain,
  isLocalKey,
  isSiteKey,
  listBindableDirs,
  listFiles,
  listItems,
  listLibraries,
  listTasks,
  maskSettings,
  normalizeItemKey,
  openTranslator,
  organize,
  organizeVideo,
  parseFieldList,
  parseListValue,
  pendingKeys,
  pendingTranslationKeys,
  placeImagesBesideVideo,
  probeTranslator,
  renameLibrary,
  repairTranslations,
  resolveDmmEnv,
  resolveLlm,
  resolveProxy,
  resolveProxyUrl,
  retryTask,
  retypeItem,
  runTask,
  saveSettings,
  scan,
  scrape,
  scrapePendingTask,
  scrapeShow,
  scrapeShows,
  scrapeShowsTask,
  setDirectorySeason,
  setFileEpisode,
  settingsPath,
  syncNfo,
  syncNfoTask,
  taskLogFiles,
  translateEnabled,
  translateItem,
  translatePending,
  type ContentType,
  type FieldKey,
  type ItemKey,
  unbindDirectory,
  unknownPlaceholders,
  updateItem,
  updateLibraryOrganize,
  updateLibraryTemplate,
} from "@kura/core";
import { createTmdbClient, resolveTmdbEnv } from "@kura/core";
import type { TranslateReport, TaskRow, TmdbShow } from "@kura/core";
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

/**
 * 影视库的刮削入口。
 *
 * 与 av 的分叉只在"按什么取数据": av 是番号路由到多个站点, 影视是 TMDB id。
 * 任务记账、失败处理、进度都复用同一套。
 */
async function scrapeVideo(
  ctx: CommandContext,
  library: { id: number; name: string; domain: string } | null,
  args: { options: Record<string, unknown>; positionals: Record<string, string | undefined> },
  http: HttpClient,
) {
  const tmdb = createTmdbClient({ http, env: resolveTmdbEnv(ctx.rt!.settings) });
  const missing = tmdb.requirements();
  if (missing.length > 0) {
    throw new AppError("未配置 TMDB API key", EXIT.NEEDS_INPUT, {
      missing,
      hint: "kura config set --tmdb-api-key <key>",
    });
  }

  const controller = new AbortController();
  const onInterrupt = () => {
    ctx.out.log("收到中断, 正在停止…");
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);
  try {
    const dryRun = Boolean(args.options["dry-run"]);
    const key = args.positionals.number;
    if (key) {
      const report = await scrapeShow(ctx.rt!, { key, tmdb, signal: controller.signal });
      return { library: library?.name ?? null, dryRun, reports: [report] };
    }
    if (!library) {
      throw new AppError("批量刮影视要给 --library <库名>", EXIT.USAGE, {
        hint: "kura scrape tmdb:tv:1399 是单部; kura scrape --library 剧库 是整库",
      });
    }
    // 干跑不建任务行(与同步 NFO 一条规矩): 它不改库, 只是看看要做什么
    if (dryRun) {
      const { reports } = await scrapeShows(ctx.rt!, {
        tmdb,
        libraryId: library.id,
        signal: controller.signal,
        onProgress: (progress) =>
          ctx.out.log(`[${progress.index}/${progress.total}] ${progress.key} ${progress.ok ? "ok" : "失败"}`),
      });
      return { library: library.name, dryRun, reports };
    }
    const { task, result } = await scrapeShowsTask(
      ctx.rt!,
      {
        tmdb,
        libraryId: library.id,
        limit: Number(args.options.limit ?? 50),
        onProgress: (progress) =>
          ctx.out.log(`[${progress.index}/${progress.total}] ${progress.key} ${progress.ok ? "ok" : "失败"}`),
      },
      controller.signal,
    );
    return { library: library.name, dryRun, taskId: task.id, reports: result?.reports ?? [] };
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

/**
 * bind / unbind 需要一个明确的库: 目录名在两个库里都可能存在。
 * 只有一个库时省掉 --library; 多个库就要求显式指定, 免得绑错库。
 */
function requireSingleLibrary(ctx: CommandContext) {
  const libraries = listLibraries(ctx.rt!.db);
  const first = libraries[0];
  if (!first) throw new AppError("还没有媒体库", EXIT.USAGE, { hint: "kura library add <名称> <根目录>" });
  if (libraries.length > 1) {
    throw new AppError("有多个媒体库, 请用 --library 指定", EXIT.USAGE, {
      libraries: libraries.map((library) => library.name),
    });
  }
  return first;
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
    summary: "媒体库: list | add <名称> <根目录> [--domain av|video] [--no-organize] | rename <库> --to <新名> | relocate <库> <新根> [--apply] | set-template | set-organize | repair-paths [库] [--apply] | remove <库>",
    needsDb: true,
    args: [
      { name: "action", type: "string", description: "list | add | rename | relocate | set-template | set-organize | repair-paths | remove", positional: true, required: true },
      { name: "name", type: "string", description: "库名 (add: 新库名; set-template: 目标库)", positional: true },
      { name: "root", type: "string", description: "库根目录 (add / relocate: 新根目录)", positional: true },
      { name: "template", type: "string", description: "自定义整理模板, 相对库根" },
      { name: "dimension", type: "string", description: `整理维度: ${DIMENSIONS.map((d) => d.id).join(" | ")}` },
      { name: "organize", type: "boolean", description: "允许整理 (--no-organize 表示只索引的旧成品库)", default: true },
      { name: "to", type: "string", description: "rename: 新库名" },
      { name: "apply", type: "boolean", description: "repair-paths / relocate: 真的改索引 (默认只列清单)" },
      {
        name: "domain",
        type: "string",
        description: "add: 域 av(番号制) | video(影视: 剧集/动画/综艺/电影), 建库时落定不可改",
        default: "av",
      },
    ],
    async run(ctx, args) {
      const action = args.positionals.action;
      if (action === "list") return { libraries: listLibraries(ctx.rt!.db), dimensions: DIMENSIONS };

      const resolveTemplate = (): string => {
        const dimension = typeof args.options.dimension === "string" ? args.options.dimension : null;
        const explicit = typeof args.options.template === "string" ? args.options.template : null;

        if (dimension) {
          const template = dimensionTemplate(dimension);
          if (!template) {
            throw new AppError(`未知维度: ${dimension}`, EXIT.USAGE, {
              dimensions: DIMENSIONS.map((item) => item.id),
            });
          }
          return template;
        }
        if (explicit) {
          const unknown = unknownPlaceholders(explicit);
          if (unknown.length > 0) {
            throw new AppError(`未知占位符: ${unknown.join(", ")}`, EXIT.USAGE, {
              allowed: Object.keys(TEMPLATE_PLACEHOLDERS),
            });
          }
          return explicit;
        }
        throw new AppError("需要 --dimension 或 --template", EXIT.USAGE);
      };

      if (action === "add") {
        const name = args.positionals.name;
        const root = args.positionals.root;
        if (!name || !root) throw new AppError("用法: library add <名称> <根目录>", EXIT.USAGE);
        const rawDomain = typeof args.options.domain === "string" ? args.options.domain : "av";
        if (!isLibraryDomain(rawDomain)) {
          throw new AppError(`未知的域: ${rawDomain}`, EXIT.USAGE, {
            allowed: LIBRARY_DOMAINS.map((domain) => ({ id: domain, label: LIBRARY_DOMAIN_LABEL[domain] })),
          });
        }
        const template = args.options.dimension || args.options.template ? resolveTemplate() : undefined;
        const organizeEnabled = args.options.organize !== false;
        return { library: createLibrary(ctx.rt!.db, { name, root, template, organizeEnabled, domain: rawDomain }) };
      }

      if (action === "remove" || action === "delete") {
        const ref = args.positionals.name;
        if (!ref) throw new AppError("用法: library remove <库名|id>", EXIT.USAGE);
        const library = requireLibrary(ctx, ref);
        // 只删索引, 磁盘一个文件都不动 —— 删完重扫即可恢复
        return { removed: deleteLibrary(ctx.rt!.db, library.id), note: "只删了库与文件索引, 磁盘上的文件一个都没动" };
      }

      if (action === "rename") {
        const ref = args.positionals.name;
        const to = typeof args.options.to === "string" ? args.options.to : "";
        if (!ref) throw new AppError("用法: library rename <库> --to <新名>", EXIT.USAGE);
        if (!to) throw new AppError("缺少 --to <新名>", EXIT.USAGE);
        const library = requireLibrary(ctx, ref);
        return { library: renameLibrary(ctx.rt!.db, library.id, to) };
      }

      // 换盘 / 目录改名: 路径变了但相对结构一样, 改前缀就能保住全部绑定关系
      if (action === "relocate") {
        const ref = args.positionals.name;
        const root = args.positionals.root;
        if (!ref || !root) throw new AppError("用法: library relocate <库> <新根目录> [--apply]", EXIT.USAGE);
        const library = requireLibrary(ctx, ref);
        const apply = Boolean(args.options.apply);
        const relocate = relocateLibrary(ctx.rt!.db, library, root, { apply });
        return { relocate: { ...relocate, applied: apply } };
      }

      if (action === "set-organize") {
        const ref = args.positionals.name;
        if (!ref) throw new AppError("用法: library set-organize <库> [--no-organize]", EXIT.USAGE);
        const library = requireLibrary(ctx, ref);
        const enabled = args.options.organize !== false;
        updateLibraryOrganize(ctx.rt!.db, library.id, enabled);
        return { library: { ...library, organizeEnabled: enabled } };
      }

      // 文件搬走了、索引没跟上(旧版整理 / 中途崩): 按整理计划把 path 找回来
      if (action === "repair-paths") {
        const ref = args.positionals.name;
        const library = ref ? requireLibrary(ctx, ref) : null;
        const report = await repairIndexPaths(ctx.rt!, {
          ...(library ? { libraryId: library.id } : {}),
          apply: Boolean(args.options.apply),
        });
        return { repair: report };
      }

      if (action === "set-template") {
        const ref = args.positionals.name;
        if (!ref) throw new AppError("用法: library set-template <库> --dimension actor", EXIT.USAGE);
        const library = requireLibrary(ctx, ref);
        const template = resolveTemplate();
        updateLibraryTemplate(ctx.rt!.db, library.id, template);
        return { library: { ...library, template } };
      }

      throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });
    },
    render(data: {
      libraries?: { name: string; root: string; template: string; organizeEnabled?: boolean }[];
      library?: { name: string; root: string; template: string; organizeEnabled?: boolean };
      removed?: { library: { name: string; root: string }; removedFiles: number; orphanItems: number };
      relocate?: {
        library: string;
        from: string;
        to: string;
        moved: number;
        missing: number;
        missingSample: string[];
        applied: boolean;
      };
      repair?: {
        dryRun: boolean;
        repaired: { from: string; to: string; key: string | null; orphanNfo: string | null }[];
        missing: { path: string }[];
        ambiguous: { from: string; to: string }[];
      };
    }) {
      // remove 动作返回的是 {removed, note}, 不是 library —— 以前会走到底部那句
      // "还没有媒体库", 看着像整库都没了一样。
      if (data.removed) {
        const { library, removedFiles, orphanItems } = data.removed;
        return [
          `已删除媒体库「${library.name}」(${library.root})`,
          `  磁盘上的文件一个都没动`,
          `  清掉索引 ${removedFiles} 个文件${orphanItems ? ` · 保留 ${orphanItems} 个条目 (条目跨库, 元数据没删)` : ""}`,
        ].join("\n");
      }
      if (data.relocate) {
        const { library, from, to, moved, missing, missingSample, applied: apply } = data.relocate;
        if (moved === 0) return `「${library}」的索引里没有文件, 无需搬。`;
        const lines = [
          apply ? `「${library}」已搬到 ${to} (改了 ${moved} 条索引路径)` : `「${library}」可以搬到 ${to} (要改 ${moved} 条索引路径)`,
          `  原位置: ${from}`,
        ];
        if (missing > 0) {
          lines.push(`  ${missing} 条在新位置找不到对应文件${missing === moved ? " (文件还没拷过来吧?)" : ""}`);
          for (const sample of missingSample) lines.push(`    ${sample}`);
        }
        if (!apply) lines.push("(这是干跑; 加 --apply 才改索引)");
        return lines.join("\n");
      }
      if (data.repair) {
        const { dryRun, repaired, missing, ambiguous } = data.repair;
        if (repaired.length === 0 && missing.length === 0 && ambiguous.length === 0) {
          return "索引和磁盘一致, 没有需要修的路径。";
        }
        const lines = [
          dryRun
            ? `要修 ${repaired.length} 条 (文件已经搬到整理后的位置, 索引还指着旧路径)`
            : `已修 ${repaired.length} 条`,
        ];
        for (const item of repaired.slice(0, 20)) lines.push(`  ${item.from}\n    → ${item.to}`);
        if (repaired.length > 20) lines.push(`  …还有 ${repaired.length - 20} 条`);
        if (missing.length > 0) lines.push(`${missing.length} 条的文件真的不在了, 扫一遍库会清掉`);
        if (ambiguous.length > 0) lines.push(`${ambiguous.length} 条两个位置都有文件, 当成重复不动, 需要人决定`);
        if (dryRun) lines.push("(这是干跑; 加 --apply 才改索引)");
        return lines.join("\n");
      }
      if (data.library) {
        const mode = data.library.organizeEnabled === false ? "只索引 (不整理)" : "允许整理";
        return `${data.library.name} → ${data.library.root}\n  模板: ${data.library.template}\n  模式: ${mode}`;
      }
      const libraries = data.libraries ?? [];
      if (libraries.length === 0) return "还没有媒体库。用 `kura library add <名称> <根目录>` 添加。";
      return libraries
        .map(
          (library) =>
            `${library.name.padEnd(12)} ${library.template.padEnd(30)} ${library.organizeEnabled === false ? "[只索引] " : ""}${library.root}`,
        )
        .join("\n");
    },
  },

  {
    name: "scan",
    summary: "扫描媒体库, 登记文件并解析番号 (REFRESH: 不抓网、不改名)",
    needsDb: true,
    args: [
      { name: "library", type: "string", description: "库名或 id", positional: true, required: true },
      { name: "dry-run", type: "boolean", description: "只报告, 不写库", default: false },
      { name: "force", type: "boolean", description: "允许一次移除超过 30% 的已登记文件 (盘没挂全时别加)", default: false },
    ],
    async run(ctx, args) {
      const library = requireLibrary(ctx, args.positionals.library!);
      const report = await scan(ctx.rt!, {
        library,
        dryRun: Boolean(args.options["dry-run"]),
        force: Boolean(args.options.force),
        onEvent: (event) => ctx.out.event({ ...event, event: "file" }),
      });
      return report;
    },
    render(data: { root: string; counts: Record<string, number>; durationMs: number; dryRun: boolean }) {
      const { counts } = data;
      return [
        `扫描完成: ${data.root}${data.dryRun ? " (dry-run)" : ""}`,
        `  新增 ${counts.added} · 更新 ${counts.updated} · 未变 ${counts.unchanged} · 移除 ${counts.removed} · 未识别 ${counts.unparsed}`,
        ...(counts.auxiliary ? [`  跳过 ${counts.auxiliary} 个 Emby 辅助媒体 (主题视频/预告片/样片)`] : []),
        ...(counts.nfoPending ? [`  有 ${counts.nfoPending} 个条目的 .nfo 还没读进库 —— 跑 \`kura nfo sync\` 补上`] : []),
        ...(counts.retyped ? [`  修正内容类型 ${counts.retyped} 条 (解析器升级, 只动还没刮到标题的条目)`] : []),
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
      { name: "retry-failed", type: "boolean", description: "连已达重试上限的条目一起重试", default: false },
      { name: "dry-run", type: "boolean", description: "只报告, 不写库", default: false },
      { name: "library", type: "string", description: "影视库: 按 TMDB 刮这个库里的剧/电影 (番号库不用给)" },
    ],
    async run(ctx, args) {
      const http = new HttpClient({ proxy: await resolveProxyUrl(ctx.rt!.settings) });

      // 影视域走 TMDB, 与 av 域的番号路由无关 —— 按库的域或身份前缀分流,
      // 不给用户第二个可能矛盾的参数 (库自带域)。
      const scrapeLibraryRef = typeof args.options.library === "string" ? args.options.library : null;
      if (scrapeLibraryRef) {
        const target = requireLibrary(ctx, scrapeLibraryRef);
        if (target.domain !== "av") return scrapeVideo(ctx, target, args, http);
      }
      const firstArg = typeof args.positionals.number === "string" ? args.positionals.number : "";
      if (/^tmdb:/i.test(firstArg)) return scrapeVideo(ctx, null, args, http);

      const registry = defaultSources({ http, dmm: resolveDmmEnv(ctx.rt!.settings) });

      // 翻译是可选后处理: 没配置就跳过, 不阻断刮削。
      const translator = translateEnabled(ctx.rt!.settings)
        ? await openTranslator(ctx.rt!, http, resolveLlm(ctx.rt!.settings))
        : null;
      if (translateEnabled(ctx.rt!.settings) && !translator) {
        ctx.out.log("已开启翻译但未配置 LLM (config set --llm-base-url/--llm-model), 本次跳过翻译");
      }
      const fixturesDir = typeof args.options.fixtures === "string" ? args.options.fixtures : null;
      const sources =
        typeof args.options.source === "string" ? args.options.source.split(",").map((id) => id.trim()) : undefined;
      const dryRun = Boolean(args.options["dry-run"]);

      const runOne = (key: ItemKey) =>
        // saveImages 跟着设置走: 图进本地缓存, 整理时才复制到媒体目录
        scrape(ctx.rt!, {
          key,
          registry,
          fixturesDir,
          sources,
          dryRun,
          translator,
          saveImages: ctx.rt!.settings.saveImages !== false,
        });

      if (args.options.pending) {
        // Ctrl-C 不再静默杀进程: 先中断当前请求, 再把已完成的条数报出来。
        const controller = new AbortController();
        const onInterrupt = () => {
          ctx.out.log("收到中断, 正在停止…");
          controller.abort();
        };
        process.once("SIGINT", onInterrupt);

        try {
          const { task, result } = await scrapePendingTask(
            ctx.rt!,
            {
              registry,
              fixturesDir,
              sources,
              translator,
              dryRun,
              limit: Number(args.options.limit ?? 50),
              includeFailed: Boolean(args.options["retry-failed"]),
              onProgress: (progress) => {
                if ("translateErrors" in progress && Array.isArray((progress as { translateErrors?: string[] }).translateErrors)) {
                  ctx.out.log(`  ⚠ ${progress.key} 翻译失败: ${(progress as { translateErrors: string[] }).translateErrors[0]}`);
                }
                ctx.out.log(
                  progress.ok
                    ? `[${progress.index}/${progress.total}] ${progress.key} ✓ ${progress.filled} 字段`
                    : `[${progress.index}/${progress.total}] ${progress.key} ✗ ${progress.error}`,
                );
                ctx.out.event({ event: "scrape", ...progress });
              },
            },
            controller.signal,
          );

          return {
            pending: true,
            taskId: task.id,
            total: result?.total ?? task.total,
            cancelled: result?.cancelled ?? false,
            count: result?.reports.length ?? task.processed,
            reports: result?.reports ?? [],
            log: taskLogFiles(ctx.rt!.paths.logDir).find((file) => file.includes(String(task.id).padStart(6, "0"))),
          };
        } finally {
          process.off("SIGINT", onInterrupt);
        }
      }

      const raw = args.positionals.number;
      if (!raw) throw new AppError("用法: scrape <番号> | scrape --pending", EXIT.USAGE);

      // 本地条目(手动加入的 UGC)没有来源: 走不到路由那一步就该说清楚, 而不是报"必须给 --type"
      if (isLocalKey(raw)) {
        throw new AppError(`本地条目没有来源可刮: ${raw.toLowerCase()}`, EXIT.USAGE, {
          key: raw.toLowerCase(),
          hint: "手动加入的条目 (local:) 只能自己补字段: kura item title/plot/tag <身份>",
        });
      }

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
        const batch = data as {
          count: number;
          total?: number;
          cancelled?: boolean;
          reports: { key: string; ok?: boolean; error?: string; filled?: number }[];
        };
        const failed = batch.reports.filter((report) => report.ok === false).length;
        const head = batch.cancelled
          ? `已取消: 完成 ${batch.count}/${batch.total ?? "?"} 条`
          : `批量刮削 ${batch.count} 条, 失败 ${failed} 条`;
        const taskLine = (batch as { taskId?: number; log?: string }).taskId
          ? `任务 #${(batch as { taskId?: number }).taskId}  日志 ${(batch as { log?: string }).log ?? "-"}`
          : null;
        return [
          head,
          ...(taskLine ? [taskLine] : []),
          ...batch.reports.map((report) =>
            report.ok === false
              ? `  ✗ ${report.key}: ${report.error}`
              : `  ✓ ${report.key} (${report.filled ?? 0} 字段)`,
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
    name: "nfo",
    summary: "NFO: sync [库|番号] 双向 (默认 dry-run) | recover <影视库> [--apply] 按盘上 nfo 的 TMDB id 建条目绑文件",
    needsDb: true,
    args: [
      { name: "action", type: "string", description: "sync (双向) | write (只写) | import (只读) | recover (影视: 从 nfo 恢复)", positional: true, default: "sync" },
      { name: "target", type: "string", description: "库名/id, 或番号 (省略 = 所有库)", positional: true },
      { name: "apply", type: "boolean", description: "真的写文件 (默认只列清单)", default: false },
      { name: "include-unscraped", type: "boolean", description: "连没联网刮过 (只有 nfo/manual 来源) 的条目也写", default: false },
      { name: "limit", type: "number", description: "最多处理多少个文件", default: 5000 },
    ],
    async run(ctx, args) {
      const target = args.positionals.target ?? "";
      const options = {
        apply: Boolean(args.options.apply),
        includeUnscraped: Boolean(args.options["include-unscraped"]),
        limit: Number(args.options.limit ?? 5000),
      } as { libraryId?: number; number?: string; apply: boolean; includeUnscraped: boolean; limit: number };
      // 从盘上的 nfo 恢复影视库(换电脑 / 换盘): 身份就在 nfo 的 <uniqueid type="tmdb"> 里,
      // 不用联网重新找。干跑只数, --apply 才建条目 + 绑文件 + 补空字段。
      if (args.positionals.action === "recover") {
        if (!target) throw new AppError("用法: nfo recover <影视库> [--apply]", EXIT.USAGE);
        const library = findLibrary(ctx.rt!.db, target);
        if (!library) throw new AppError(`媒体库不存在: ${target}`, EXIT.NOT_FOUND, { library: target });
        return { library: library.name, domain: library.domain, ...(await recoverFromNfo(ctx.rt!, { libraryId: library.id, apply: options.apply })) };
      }

      if (target) {
        // 先当库名找, 找不到再当番号 —— 番号不会是库名, 两个命名空间撞不了。
        const library = findLibrary(ctx.rt!.db, target);
        // 影视库只有写方向(Emby 会自己写集级 nfo, 回读等于把播放器状态当元数据)
        if (library && library.domain !== "av") {
          const report = await exportTvNfo(ctx.rt!, {
            libraryId: library.id,
            apply: options.apply,
            limit: options.limit,
          });
          return { library: library.name, domain: library.domain, ...report };
        }
        if (library) options.libraryId = library.id;
        else options.number = target;
      }

      // 不带目标 = 所有库, 但两个域的 nfo 不是一回事: 番号制双向、影视只写。
      // 以前这里只跑番号制那套, 影视库被静默跳过(而且 av 那套会把影视文件写成 <movie>)。
      if (!target) {
        const libraries = listLibraries(ctx.rt!.db);
        const merged = {
          dryRun: !options.apply,
          scanned: 0,
          imported: 0,
          written: 0,
          created: 0,
          skipped: 0,
          errors: 0,
          cancelled: false,
          entries: [] as Record<string, unknown>[],
          byDomain: { av: 0, video: 0 },
        };
        for (const library of libraries) {
          if (library.domain === "av") {
            merged.byDomain.av += 1;
            const report = options.apply
              ? await syncNfo(ctx.rt!, { ...options, libraryId: library.id, apply: true })
              : await syncNfo(ctx.rt!, { ...options, libraryId: library.id });
            merged.scanned += report.scanned;
            merged.imported += report.imported;
            merged.written += report.written;
            merged.created += report.created;
            merged.skipped += report.skipped;
            merged.errors += report.errors;
            merged.cancelled = merged.cancelled || report.cancelled;
            merged.entries.push(...(report.entries as unknown as Record<string, unknown>[]));
          } else {
            merged.byDomain.video += 1;
            const report = await exportTvNfo(ctx.rt!, {
              libraryId: library.id,
              apply: options.apply,
              limit: options.limit,
            });
            merged.scanned += report.shows;
            merged.written += report.updated;
            merged.created += report.created;
            merged.skipped += report.skipped;
            merged.errors += report.errors;
            merged.cancelled = merged.cancelled || report.cancelled;
            merged.entries.push(
              ...report.entries.map((entry) => ({
                number: entry.key,
                path: entry.path,
                nfoPath: entry.path,
                action: entry.action,
                changed: entry.changed,
                ...(entry.error ? { error: entry.error } : {}),
              })),
            );
          }
        }
        return merged;
      }
      const action = args.positionals.action ?? "sync";
      if (!["sync", "write", "import"].includes(action)) {
        throw new AppError(`未知动作: ${action} (sync | write | import)`, EXIT.USAGE);
      }
      const variant = action === "write" ? { ...options, writeOnly: true } : action === "import" ? { ...options, readOnly: true } : options;
      // 干跑不建任务行(不改库、不写盘), 只有真写盘才记一条, 历史里一次同步只有一行。
      if (!options.apply) return syncNfo(ctx.rt!, variant);
      const controller = new AbortController();
      const { task, result } = await syncNfoTask(ctx.rt!, { ...variant, apply: true }, controller.signal);
      if (!result) throw new AppError(`任务 #${task.id} 没有结果`, EXIT.INTERNAL);
      return { ...result, taskId: task.id };
    },
    render(data: {
      dryRun: boolean;
      scanned: number;
      created: number;
      skipped: number;
      errors: number;
      imported?: number;
      written?: number;
      updated?: number;
      entries: { number: string; nfoPath: string; status?: string; action?: string; reason?: string; changed: string[]; error?: string }[];
      [key: string]: unknown;
    }) {
      // recover 走的是另一份形状(没有 entries/scanned), 单独渲染 ——
      // 否则会掉到下面那句"扫描 0 个文件", 看着像什么都没干。
      const recovered = data as unknown as {
        shows?: number;
        movies?: number;
        files?: number;
        done?: { kind: "tv" | "movie"; key: string; target: string; files: number; title: string | null; created: boolean; episodes: number }[];
        noTmdbId?: string[];
      };
      if (recovered.done) {
        const lines = [
          `${data.dryRun ? "可以恢复" : "已恢复"} ${recovered.shows ?? 0} 个剧 + ${recovered.movies ?? 0} 部电影 · ` +
            `${recovered.files ?? 0} 个文件 (元数据取自盘上的 nfo, 只补空字段, 不联网)`,
        ];
        for (const entry of recovered.done.slice(0, 20)) {
          lines.push(
            `  ${entry.key}  ${entry.kind === "tv" ? "剧" : "电影"}  ${entry.title ?? ""}  ${entry.files} 个文件` +
              `${entry.episodes ? ` · ${entry.episodes} 集` : ""}${entry.created ? "" : " (已有条目, 只补空字段)"}`,
          );
        }
        if (recovered.done.length > 20) lines.push(`  … 还有 ${recovered.done.length - 20} 条`);
        if (recovered.noTmdbId?.length) {
          lines.push(`${recovered.noTmdbId.length} 个 nfo 里没有 TMDB id, 没动 (这些只能走「找建议」):`);
          for (const path of recovered.noTmdbId.slice(0, 5)) lines.push(`  ${path}`);
        }
        if (data.dryRun) lines.push("(dry-run, 没改库; 加 --apply 执行)");
        return lines.join("\n");
      }

      const statusOf = (entry: { status?: string; action?: string }): string => entry.action ?? entry.status ?? "skip";
      const written = data.written ?? data.updated ?? 0;
      const imported = data.imported ?? 0;
      const lines = [
        `扫描 ${data.scanned} 个文件: 写回 ${written} · 新建 ${data.created} · 读入 ${imported} · 跳过 ${data.skipped}${data.errors ? ` · 失败 ${data.errors}` : ""}`,
      ];
      const done = data.entries.filter((item) => statusOf(item) !== "skip");
      const ACTION_LABEL: Record<string, string> = { create: "新建", write: "写回", import: "读入" };
      for (const entry of done.slice(0, 40)) {
        lines.push(`  ${entry.number}  ${ACTION_LABEL[statusOf(entry)] ?? statusOf(entry)}  ${entry.nfoPath}`);
        for (const change of entry.changed.slice(0, 6)) lines.push(`      ${change}`);
        if (entry.changed.length > 6) lines.push(`      … 还有 ${entry.changed.length - 6} 项`);
        if (entry.error) lines.push(`      ✗ ${entry.error}`);
      }
      const skips = new Map<string, number>();
      for (const entry of data.entries.filter((item) => statusOf(item) === "skip")) {
        const reason = entry.reason ?? "未知原因";
        skips.set(reason, (skips.get(reason) ?? 0) + 1);
      }
      for (const [reason, count] of skips) lines.push(`  跳过 ${count} 个: ${reason}`);
      if (done.length > 40) lines.push(`  … 还有 ${done.length - 40} 个文件`);
      lines.push(data.dryRun ? "(dry-run, 没动任何文件; 加 --apply 写入)" : "已写入。Emby/Jellyfin 里重新扫描媒体库即可看到新元数据");
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
      // 影视库是另一套形状(剧目录/Season 目录/SxxEyy 文件名), 不走模板
      if (library.domain !== "av") return organizeVideo(ctx.rt!, { library, apply: Boolean(args.options.apply) });
      return organize(ctx.rt!, { library, apply: Boolean(args.options.apply) });
    },
    render(data: {
      plan: { entries: { action: string; from?: string; to?: string; reason?: string }[]; summary: Record<string, number> };
      applied: { ok: boolean; error?: string }[] | null;
      skipped?: boolean;
      reason?: string;
      warnings?: string[];
      removedDirs?: string[];
      leftoverDirs?: { dir: string; files: string[] }[];
      removedFiles?: string[];
    }) {
      if (data.skipped) return `跳过: ${data.reason}`;
      const lines = [
        `整理计划: 移动 ${data.plan.summary.move} · 写 NFO ${data.plan.summary.writeNfo} · 海报 ${data.plan.summary.copyImage} · 跳过 ${data.plan.summary.skip}`,
      ];
      for (const entry of data.plan.entries.slice(0, 50)) {
        if (entry.action === "move") lines.push(`  → ${entry.from}\n    ${entry.to}`);
      }
      if (data.plan.entries.length > 50) lines.push(`  … 还有 ${data.plan.entries.length - 50} 条`);
      for (const warning of data.warnings ?? []) lines.push(`  ! ${warning}`);
      if (data.removedFiles?.length) lines.push(`  清掉 ${data.removedFiles.length} 个残留文件 (旧目录里的海报 / nfo)`);
      if (data.removedDirs?.length) lines.push(`  搬空后清理了 ${data.removedDirs.length} 个源目录`);
      if (data.leftoverDirs?.length) lines.push(`  还有 ${data.leftoverDirs.length} 个源目录没删 (里面有文件)`);
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
    name: "cleanup",
    summary: "清理: 删掉只剩海报/nfo 的空壳目录 (默认 dry-run, --apply 才删)",
    needsDb: true,
    args: [
      { name: "library", type: "string", description: "库名或 id (省略 = 所有库)", positional: true },
      { name: "apply", type: "boolean", description: "真的删 (默认只列清单)", default: false },
    ],
    async run(ctx, args) {
      const ref = args.positionals.library;
      const library = ref ? requireLibrary(ctx, ref) : null;
      return cleanupEmptyDirs(ctx.rt!, {
        ...(library ? { libraryId: library.id } : {}),
        apply: Boolean(args.options.apply),
      });
    },
    render(data: {
      dryRun: boolean;
      removedDirs: string[];
      removedFiles: string[];
      kept: { dir: string; files: string[] }[];
    }) {
      const lines = [
        `清理${data.dryRun ? " (dry-run, 未删)" : ""}: 目录 ${data.removedDirs.length} 个 · 文件 ${data.removedFiles.length} 个`,
      ];
      for (const dir of data.removedDirs.slice(0, 30)) lines.push(`  ✗ ${dir}`);
      if (data.removedDirs.length > 30) lines.push(`  … 还有 ${data.removedDirs.length - 30} 个`);
      for (const item of data.kept.slice(0, 10)) {
        lines.push(`  留着 ${item.dir} (${item.files.join("、")})`);
      }
      if (data.dryRun && data.removedDirs.length > 0) lines.push("加 --apply 真的删。");
      return lines.join("\n");
    },
  },

  {
    name: "translate",
    summary: "翻译: <番号> 或 --pending (日→中, 覆盖 title/plot, 原文存 *_original)",
    needsDb: true,
    args: [
      { name: "number", type: "string", description: "番号", positional: true },
      { name: "pending", type: "boolean", description: "翻译所有含日文且未翻译的条目", default: false },
      { name: "repair", type: "boolean", description: "只用本地缓存恢复'翻过但没记录'的条目 (不发请求)", default: false },
      { name: "limit", type: "number", description: "--pending 时的批大小", default: 1000 },
    ],
    async run(ctx, args) {
      const config = resolveLlm(ctx.rt!.settings);
      if (!config) {
        throw new AppError("未配置 LLM", EXIT.NEEDS_INPUT, {
          hint: "kura config set --llm-base-url https://api.deepseek.com/v1 --llm-api-key ... --llm-model deepseek-chat",
        });
      }

      const http = new HttpClient({ proxy: await resolveProxyUrl(ctx.rt!.settings) });
      const translator = await openTranslator(ctx.rt!, http, config);
      if (!translator) throw new AppError("翻译器初始化失败", EXIT.INTERNAL);

      if (args.options.repair) {
        const repaired = repairTranslations(ctx.rt!, translator);
        return { repaired: repaired.repaired, reports: repaired.reports };
      }

      if (args.options.pending) {
        const result = await translatePending(ctx.rt!, {
          translator,
          limit: Number(args.options.limit ?? 1000),
          onProgress: (progress) => {
            if (progress.error) ctx.out.log(`[${progress.index}/${progress.total}] ${progress.key} ✗ ${progress.error}`);
            else ctx.out.log(`[${progress.index}/${progress.total}] ${progress.key} ✓ ${progress.translated.join(", ") || "无变化"}`);
          },
        });
        return { pending: true, count: result.count, reports: result.reports };
      }

      const number = args.positionals.number;
      if (!number) throw new AppError("用法: translate <番号> | translate --pending", EXIT.USAGE);
      return translateItem(ctx.rt!, normalizeItemKey(number), translator);
    },
    render(data: unknown) {
      if (data && typeof data === "object" && "repaired" in data) {
        const repair = data as { repaired: number; reports: { key: string; fields: string[] }[] };
        if (repair.repaired === 0) return "没有可从缓存恢复的条目";
        return [
          `从本地缓存恢复 ${repair.repaired} 条 (未调用模型)`,
          ...repair.reports.map((report) => `  ✓ ${report.key} (${report.fields.join(", ")})`),
        ].join("\n");
      }
      if (data && typeof data === "object" && "reports" in data) {
        const batch = data as { count: number; reports: { key: string; translated: string[]; skipped?: string }[] };
        return [
          `翻译 ${batch.count} 条`,
          ...batch.reports.map((report) =>
            report.translated.length > 0
              ? `  ✓ ${report.key} (${report.translated.join(", ")})`
              : `  - ${report.key}: ${report.skipped ?? "无变化"}`,
          ),
        ].join("\n");
      }
      const single = data as TranslateReport;
      return single.translated.length > 0
        ? `${single.key} 已翻译: ${single.translated.join(", ")}`
        : `${single.key} 跳过: ${single.skipped ?? "无变化"}`;
    },
  },

  {
    name: "resource",
    summary: "资源: fetch <番号> 下载海报(竖版)+缩略图(横版)到本地缓存 (整理时再复制进库)",
    needsDb: true,
    args: [
      { name: "action", type: "string", description: "目前只有 fetch", positional: true, default: "fetch" },
      { name: "number", type: "string", description: "番号", positional: true, required: true },
    ],
    async run(ctx, args) {
      const action = args.positionals.action ?? "fetch";
      if (action !== "fetch") throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });
      const key = normalizeItemKey(args.positionals.number!);
      const item = getItem(ctx.rt!, key);
      if (!item) throw new AppError(`条目不存在: ${key}`, EXIT.NOT_FOUND, { number: key });

      const http = new HttpClient({ proxy: await resolveProxyUrl(ctx.rt!.settings) });
      const result = await downloadPoster(ctx.rt!, http, item);
      // 只在设置没关掉时做; 只读盘上的失败不影响缓存。
      const placed =
        ctx.rt!.settings.saveImages !== false
          ? await placeImagesBesideVideo(ctx.rt!, item, { poster: result.poster, thumb: result.thumb })
          : { saved: [], skipped: [], errors: [] };
      if (!result.poster) {
        throw new AppError(
          result.tried.length === 0 ? "该条目没有图片 URL, 先刮削一次" : "所有海报地址都下载失败",
          result.tried.length === 0 ? EXIT.NEEDS_INPUT : EXIT.RETRYABLE,
          { failures: result.failures },
        );
      }
      return {
        key,
        poster: result.poster ? { path: result.poster.path, size: result.poster.size } : null,
        thumb: result.thumb ? { path: result.thumb.path, size: result.thumb.size } : null,
        failures: result.failures,
        saved: placed.saved,
        saveErrors: placed.errors,
      };
    },
    render(data: {
      key: string;
      poster: { path: string; size: number } | null;
      thumb: { path: string; size: number } | null;
      saved?: string[];
      saveErrors?: string[];
    }) {
      const line = (label: string, file: { path: string; size: number } | null): string =>
        file ? `  ${label} ${file.path} (${Math.round(file.size / 1024)} KB)` : `  ${label} (无)`;
      const placed = data.saved?.length
        ? data.saved.map((path) => `  → ${path}`).join("\n")
        : "  (没有需要复制到视频旁边的图)";
      const errors = data.saveErrors?.length ? `\n写盘失败:\n${data.saveErrors.map((e) => `  ! ${e}`).join("\n")}` : "";
      return `${data.key} 图片已缓存\n${line("海报", data.poster)}\n${line("缩略图", data.thumb)}\n复制到视频旁:\n${placed}${errors}`;
    },
  },

  {
    name: "file",
    summary:
      "文件: list [--library 库] | reveal <番号> | dirs | bind <目录> --tmdb <身份> [--season N] | bind <目录> --local [--title 名] [--type movie|tv] | unbind <目录> | set-season <目录> --season N | set-episode <路径> --episode N | clear-episode <路径>",
    needsDb: true,
    args: [
      {
        name: "action",
        type: "string",
        description: "list | reveal | dirs | bind | unbind | set-season | set-episode | clear-episode",
        positional: true,
        default: "list",
      },
      { name: "number", type: "string", description: "reveal: 番号; bind/unbind: 目录; set-episode: 文件路径", positional: true },
      { name: "library", type: "string", description: "只看某个库" },
      { name: "unparsed", type: "boolean", description: "只看认不出番号的文件", default: false },
      { name: "limit", type: "number", description: "条数", default: 200 },
      { name: "tmdb", type: "string", description: "bind: TMDB 身份, 如 tmdb:tv:1399" },
      { name: "local", type: "boolean", description: "bind: 手动加入库 (local: 身份, 标 ugc, 不连任何来源)", default: false },
      { name: "title", type: "string", description: "bind --local: 条目标题 (默认取目录名)" },
      { name: "type", type: "string", description: "bind --local: movie | tv (默认: 目录里多于一个文件 = tv)" },
      { name: "episode", type: "number", description: "set-episode: 集号" },
      { name: "season", type: "number", description: "bind/set-season: 强制季号 (同一部剧拆成多个目录时用)" },
      { name: "dry-run", type: "boolean", description: "bind: 只报告会绑多少文件", default: false },
    ],
    async run(ctx, args) {
      const action = args.positionals.action ?? "list";

      // 影视域: 列出待绑定的目录 (一个目录 = 一部剧的候选)
      if (action === "dirs") {
        const libraryRef = typeof args.options.library === "string" ? args.options.library : null;
        const library = libraryRef ? requireLibrary(ctx, libraryRef) : null;
        const dirs = listBindableDirs(ctx.rt!, {
          libraryId: library?.id,
          limit: Number(args.options.limit ?? 200),
        });
        return { count: dirs.length, dirs };
      }

      if (action === "bind" && args.options.local) {
        const dir = args.positionals.number;
        if (!dir) throw new AppError("用法: file bind <目录> --local [--title 名] [--type movie|tv]", EXIT.USAGE);
        const library = args.options.library
          ? requireLibrary(ctx, String(args.options.library))
          : requireSingleLibrary(ctx);
        const type = typeof args.options.type === "string" ? args.options.type : undefined;
        if (type !== undefined && type !== "movie" && type !== "tv") {
          throw new AppError(`--type 只能是 movie 或 tv: ${type}`, EXIT.USAGE);
        }
        return {
          result: bindLocalDirectory(ctx.rt!, {
            libraryId: library.id,
            dir,
            ...(typeof args.options.title === "string" ? { title: args.options.title } : {}),
            ...(type ? { type } : {}),
            dryRun: Boolean(args.options["dry-run"]),
          }),
        };
      }

      if (action === "bind") {
        const dir = args.positionals.number;
        const key = typeof args.options.tmdb === "string" ? args.options.tmdb : "";
        if (!dir) throw new AppError("用法: file bind <目录> --tmdb tmdb:tv:1399", EXIT.USAGE);
        if (!key) throw new AppError("缺少 --tmdb tmdb:tv:1399", EXIT.USAGE);
        const library = args.options.library
          ? requireLibrary(ctx, String(args.options.library))
          : requireSingleLibrary(ctx);
        const season = args.options.season === undefined ? undefined : Number(args.options.season);
        return {
          result: bindDirectory(ctx.rt!, {
            libraryId: library.id,
            dir,
            key,
            ...(season === undefined ? {} : { season }),
            dryRun: Boolean(args.options["dry-run"]),
          }),
        };
      }

      if (action === "unbind") {
        const dir = args.positionals.number;
        if (!dir) throw new AppError("用法: file unbind <目录> [--library 库]", EXIT.USAGE);
        const library = args.options.library
          ? requireLibrary(ctx, String(args.options.library))
          : requireSingleLibrary(ctx);
        return { unbound: unbindDirectory(ctx.rt!, { libraryId: library.id, dir }) };
      }

      if (action === "set-season") {
        const dir = args.positionals.number;
        if (!dir) throw new AppError("用法: file set-season <目录> --season 2", EXIT.USAGE);
        const season = Number(args.options.season);
        if (!Number.isInteger(season) || season < 0) throw new AppError("缺少 --season <非负整数>", EXIT.USAGE);
        const library = args.options.library
          ? requireLibrary(ctx, String(args.options.library))
          : requireSingleLibrary(ctx);
        return { result: setDirectorySeason(ctx.rt!, { dir, season, libraryId: library.id }) };
      }

      if (action === "set-episode") {
        const path = args.positionals.number;
        if (!path) throw new AppError("用法: file set-episode <路径> --episode 5 [--season 1]", EXIT.USAGE);
        const episode = Number(args.options.episode);
        if (!Number.isInteger(episode) || episode <= 0) {
          throw new AppError("缺少 --episode <正整数>", EXIT.USAGE);
        }
        const season = args.options.season === undefined ? undefined : Number(args.options.season);
        return { result: setFileEpisode(ctx.rt!, { path, season, episode }) };
      }

      // 解析规则变准之后(比如 13.5 不再被当成第 13 集), 老库里写死的错误季集不会自己消失
      // —— 扫描刻意不覆盖已有的季集。这条命令就是"按文件名重来一次"。
      if (action === "clear-episode") {
        const path = args.positionals.number;
        if (!path) throw new AppError("用法: file clear-episode <路径>", EXIT.USAGE);
        return { result: clearFileEpisode(ctx.rt!, { path }) };
      }

      if (action === "reveal") {
        const number = args.positionals.number;
        if (!number) throw new AppError("用法: file reveal <番号>", EXIT.USAGE);
        const key = normalizeItemKey(number);
        const files = ctx.rt!.db.all<{ path: string; size: number }>(
          "select path, size from media_files where number = ? order by path",
          [key],
        );
        if (files.length === 0) throw new AppError(`条目 ${key} 没有登记到任何文件`, EXIT.NOT_FOUND, { number: key });
        return { number: key, files };
      }

      if (action !== "list") throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });

      const libraryRef = typeof args.options.library === "string" ? args.options.library : null;
      const library = libraryRef ? requireLibrary(ctx, libraryRef) : null;
      const files = listFiles(ctx.rt!, {
        libraryId: library?.id,
        unparsedOnly: Boolean(args.options.unparsed),
        limit: Number(args.options.limit ?? 200),
      });
      return { count: files.length, files };
    },
    render(data: {
      count?: number;
      number?: string;
      files?: { path: string; number?: string | null }[];
      result?: Record<string, unknown>;
    }) {
      // bind / unbind / set-season / set-episode / clear-episode 返回的是 {result},
      // 这里曾经直接读 data.files.map —— 单条动作成功后照样崩在渲染上
      // (报 "undefined is not an object (evaluating 'Z.files.map')", 看着像命令失败了)。
      if (data.result) {
        return Object.entries(data.result)
          .map(([field, value]) => `${field}: ${Array.isArray(value) ? value.join(", ") : String(value ?? "")}`)
          .join("\n");
      }
      if (!data.files) return "完成。";
      if (data.number) return data.files.map((file) => file.path).join("\n");
      if (data.count === 0) return "没有匹配的文件。";
      return data.files
        .map((file) => `${(file.number ?? "(未识别)").padEnd(14)} ${file.path}`)
        .join("\n");
    },
  },

  {
    name: "item",
    summary: "条目: get <番号> | list [--type] [--actor] | set <番号> --title ... | lock/unlock <番号> 字段,字段 | retype <番号> <类型>",
    needsDb: true,
    args: [
      { name: "action", type: "string", description: "get | list | set | lock | unlock | retype", positional: true, required: true },
      { name: "number", type: "string", description: "番号 (get/set/lock/unlock)", positional: true },
      { name: "fields", type: "string", description: "lock/unlock 的字段, 逗号分隔; retype 时要写的类型", positional: true },
      { name: "type", type: "string", description: "按类型筛选 (list)" },
      { name: "actor", type: "string", description: "按演员筛选 (list), 空白与全半角差异不影响命中" },
      { name: "q", type: "string", description: "关键词: 番号/标题/原名/片商/系列/演员/标签" },
      { name: "studio", type: "string", description: "按片商筛选 (list)" },
      { name: "label", type: "string", description: "按厂牌筛选 (list)" },
      { name: "series", type: "string", description: "按系列筛选 (list)" },
      { name: "director", type: "string", description: "按导演筛选 (list)" },
      { name: "tag", type: "string", description: "按标签筛选 (list)" },
      { name: "library", type: "string", description: "只看某个媒体库 (list)" },
      { name: "state", type: "string", description: "list: unscraped (还没标题) | scraped | exhausted (刮削失败到上限)" },
      { name: "sort", type: "string", description: "list: number | title | release | studio | duration | updated (默认 updated)" },
      { name: "desc", type: "boolean", description: "list: 排序方向改为倒序", default: false },
      { name: "detect", type: "boolean", description: "retype: 按当前解析器找出所有可能判错的条目", default: false },
      { name: "apply", type: "boolean", description: "retype --detect: 真的改 (默认只列清单)", default: false },
      { name: "limit", type: "number", description: "条数 (list)", default: 20 },
      { name: "offset", type: "number", description: "跳过条数 (list)", default: 0 },
      { name: "title", type: "string", description: "set: 标题" },
      { name: "plot", type: "string", description: "set: 简介" },
      { name: "studio", type: "string", description: "set: 片商" },
      { name: "label", type: "string", description: "set: 厂牌" },
      { name: "series", type: "string", description: "set: 系列" },
      { name: "release-date", type: "string", description: "set: 发行日期 YYYY-MM-DD" },
      { name: "duration-min", type: "number", description: "set: 时长(分钟)" },
      { name: "actors", type: "string", description: "set: 演员, 逗号分隔" },
      { name: "directors", type: "string", description: "set: 导演, 逗号分隔" },
      { name: "tags", type: "string", description: "set: 标签, 逗号分隔" },
      { name: "pin", type: "boolean", description: "set 时同时锁定被改的字段", default: true },
    ],
    async run(ctx, args) {
      const action = args.positionals.action;

      if (action === "get") {
        const number = args.positionals.number;
        if (!number) throw new AppError("用法: item get <番号>", EXIT.USAGE);
        const item = getItem(ctx.rt!, normalizeItemKey(number));
        if (!item) throw new AppError(`条目不存在: ${number}`, EXIT.NOT_FOUND, { number });
        return { item };
      }

      if (action === "list") {
        const text = (name: string) => (typeof args.options[name] === "string" ? (args.options[name] as string) : undefined);
        const libraryRef = text("library");
        const library = libraryRef ? requireLibrary(ctx, libraryRef) : null;
        const filters = {
          type: text("type"),
          actor: text("actor"),
          q: text("q"),
          studio: text("studio"),
          label: text("label"),
          series: text("series"),
          director: text("director"),
          tag: text("tag"),
          libraryId: library?.id,
          state: text("state") as "unscraped" | "scraped" | "exhausted" | undefined,
          sort: (() => {
            const field = text("sort");
            if (!field) return undefined;
            if (!isItemSortField(field)) {
              throw new AppError(`未知排序字段: ${field}`, EXIT.USAGE, { field, allowed: "number|title|release|studio|duration|updated" });
            }
            return { field, desc: args.options.desc === true };
          })(),
        };
        const items = listItems(ctx.rt!, {
          ...filters,
          limit: Number(args.options.limit ?? 20),
          offset: Number(args.options.offset ?? 0),
        });
        return {
          items,
          total: countItems(ctx.rt!, filters),
          pending: countPending(ctx.rt!),
          exhausted: countExhausted(ctx.rt!),
        };
      }

      if (action === "retype") {
        // 两种用法:
        //   item retype <番号> <类型>     改一条
        //   item retype --detect [--apply]  按当前解析器找出所有判错的, 默认只列清单
        if (args.options.detect === true) {
          const changes = detectRetypes(ctx.rt!, { apply: args.options.apply === true });
          return { applied: args.options.apply === true, changes };
        }
        const number = args.positionals.number;
        const type = args.positionals.fields ?? (typeof args.options.type === "string" ? args.options.type : "");
        if (!number || !type) {
          throw new AppError(
            "用法: item retype <番号> <类型> | item retype --detect [--apply]",
            EXIT.USAGE,
          );
        }
        const key = normalizeItemKey(number);
        const result = retypeItem(ctx.rt!, key, type);
        return { number: key, ...result };
      }

      if (action === "set" || action === "lock" || action === "unlock") {
        const number = args.positionals.number;
        if (!number) throw new AppError(`用法: item ${action} <番号> ...`, EXIT.USAGE);
        const key = normalizeItemKey(number);

        if (action === "set") {
          const patch: Partial<Record<FieldKey, string | string[] | number>> = {};
          const single: [string, FieldKey][] = [
            ["title", "title"],
            ["plot", "plot"],
            ["studio", "studio"],
            ["label", "label"],
            ["series", "series"],
            ["release-date", "release_date"],
          ];
          for (const [option, field] of single) {
            const value = args.options[option];
            if (typeof value === "string") patch[field] = value;
          }
          if (typeof args.options["duration-min"] === "number") patch.duration_min = args.options["duration-min"];
          for (const [option, field] of [
            ["actors", "actors"],
            ["directors", "directors"],
            ["tags", "tags"],
          ] as const) {
            const value = args.options[option];
            if (typeof value === "string") patch[field] = parseListValue(value);
          }
          if (Object.keys(patch).length === 0) {
            throw new AppError("item set 至少要给一个字段, 如 --title", EXIT.USAGE);
          }
          const pin = Boolean(args.options.pin) ? (Object.keys(patch) as FieldKey[]) : [];
          return { item: updateItem(ctx.rt!, { key, patch, pin }) };
        }

        const fields = parseFieldList(args.positionals.fields);
        if (fields.length === 0) {
          throw new AppError(`用法: item ${action} <番号> title,plot`, EXIT.USAGE);
        }
        const item =
          action === "lock"
            ? updateItem(ctx.rt!, { key, pin: fields })
            : updateItem(ctx.rt!, { key, unpin: fields });
        return { item };
      }

      throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });
    },
    render(data: {
      item?: Record<string, unknown>;
      items?: Record<string, unknown>[];
      from?: string;
      to?: string;
      number?: string;
      applied?: boolean;
      changes?: { number: string; from: string; to: string; hasTitle: boolean }[];
    }) {
      if (data.changes) {
        const changes = data.changes;
        if (changes.length === 0) return "没有判错的条目。";
        const head = data.applied ? `已修正 ${changes.length} 条:` : `发现 ${changes.length} 条判错 (加 --apply 才会改):`;
        return [
          head,
          ...changes.map((c) => `  ${c.number.padEnd(14)} ${c.from} → ${c.to}${c.hasTitle ? "  (已有标题, 改类型会换来源线)" : ""}`),
        ].join("\n");
      }
      if (data.from && data.to != null && data.number) {
        return data.from === data.to ? `${data.number} 类型本来就是 ${data.to}` : `${data.number} 类型 ${data.from} → ${data.to}`;
      }
      if (data.item) {
        const pinned = (data.item.pinned as string[] | undefined) ?? [];
        return Object.entries(data.item)
          .filter(([key, value]) => key !== "pinned" && value !== undefined && value !== null && String(value).length > 0)
          .map(([key, value]) => {
            const lock = pinned.includes(key) ? "🔒" : "  ";
            return `${lock} ${key.padEnd(13)} ${Array.isArray(value) ? value.join(", ") : String(value)}`;
          })
          .join("\n");
      }
      const items = data.items ?? [];
      const total = (data as { total?: number }).total;
      const pending = (data as { pending?: number }).pending ?? 0;
      const exhausted = (data as { exhausted?: number }).exhausted ?? 0;
      if (items.length === 0) return "没有条目。先 `kura scan <库>`。";

      const lines = items.map((item) => {
        const pinned = ((item.pinned as string[] | undefined) ?? []).length > 0 ? "🔒" : "  ";
        return `${pinned} ${String(item.number).padEnd(13)} ${String(item.contentType).padEnd(10)} ${item.title ?? "(未刮削)"}`;
      });
      if (total !== undefined) {
        lines.push(
          `— 共 ${total} 条, 待刮削 ${pending} 条${exhausted > 0 ? `, 已达重试上限 ${exhausted} 条 (scrape --retry-failed 可再试)` : ""} —`,
        );
      }
      return lines.join("\n");
    },
  },

  {
    name: "source",
    summary: "来源: list (状态与缺失配置) | test <id> [--probe 番号]",
    needsDb: true,
    args: [
      { name: "action", type: "string", description: "list 或 test", positional: true, default: "list" },
      { name: "id", type: "string", description: "test 时指定来源 id", positional: true },
      { name: "probe", type: "string", description: "test 用的探测番号", default: "SSIS-001" },
    ],
    async run(ctx, args) {
      const action = args.positionals.action ?? "list";
      const http = new HttpClient({ proxy: await resolveProxyUrl(ctx.rt!.settings) });
      const registry = defaultSources({ http, dmm: resolveDmmEnv(ctx.rt!.settings) });

      // 翻译是可选后处理: 没配置就跳过, 不阻断刮削。
      const translator = translateEnabled(ctx.rt!.settings)
        ? await openTranslator(ctx.rt!, http, resolveLlm(ctx.rt!.settings))
        : null;
      if (translateEnabled(ctx.rt!.settings) && !translator) {
        ctx.out.log("已开启翻译但未配置 LLM (config set --llm-base-url/--llm-model), 本次跳过翻译");
      }

      if (action === "list") {
        const tmdbEnv = resolveTmdbEnv(ctx.rt!.settings);
        return {
          sources: [
            ...registry.list().map((source) => ({
              id: source.id,
              label: source.label,
              status: source.status,
              missing: source.requirements(),
              contentTypes: source.contentTypes,
              domains: ["av"],
            })),
            // TMDB 不进 registry: 它按 TMDB id 取而不是番号, 也没有内容类型路由
            {
              id: "tmdb",
              label: "TMDB",
              status: "ready",
              missing: tmdbEnv.apiKey ? [] : ["KURA_TMDB_API_KEY"],
              contentTypes: [],
              domains: ["video"],
            },
          ],
        };
      }

      if (action === "test") {
        const id = args.positionals.id;
        if (!id) throw new AppError("用法: source test <id> [--probe SSIS-001]", EXIT.USAGE);

        if (id === "tmdb") {
          // 影视域的自检: 拿一部固定剧验证 key、语言与集列表三层都通
          const tmdb = createTmdbClient({ http, env: resolveTmdbEnv(ctx.rt!.settings) });
          const missingTmdb = tmdb.requirements();
          if (missingTmdb.length > 0) {
            throw new AppError("未配置 TMDB API key", EXIT.NEEDS_INPUT, {
              missing: missingTmdb,
              hint: "kura config set --tmdb-api-key <key>; key 到 https://www.themoviedb.org/settings/api 申请 (个人用途免费)",
            });
          }
          const probe = String(args.options.probe ?? "1429");
          const id2 = Number(probe);
          if (!Number.isInteger(id2) || id2 <= 0) throw new AppError("--probe 用 TMDB 剧集 id (如 1429)", EXIT.USAGE);
          const started = Date.now();
          const show: TmdbShow | null = await tmdb.show(id2, { seasons: [1] });
          if (!show) throw new AppError(`TMDB 没有这个 id: ${id2}`, EXIT.NOT_FOUND, { id: id2 });
          return {
            id: "tmdb",
            ok: true,
            status: "ok",
            probe: id2,
            title: show.fields.title ?? null,
            originalTitle: show.originalTitle,
            fields: Object.keys(show.fields),
            seasons: show.seasons.map((season) => ({ season: season.season, episodes: season.declaredEpisodes })),
            firstEpisodes: show.seasons[0]?.episodes.slice(0, 3).map((episode) => episode.title) ?? [],
            durationMs: Date.now() - started,
          };
        }

        const source = registry.get(id);
        if (!source) throw new AppError(`未知来源: ${id}`, EXIT.NOT_FOUND, { id });
        if (source.status !== "ready") return { id, ok: false, status: "todo" };

        const missing = source.requirements();
        if (missing.length > 0) return { id, ok: false, status: "missing-config", missing };

        const probe = String(args.options.probe ?? "SSIS-001").toUpperCase();
        const key = { value: probe, number: probe, contentType: detectContentType(probe) ?? "censored" } as const;
        const started = Date.now();
        try {
          const fields = await source.fetch(key, { fixturesDir: null });
          return {
            id,
            ok: Boolean(fields),
            status: fields ? "ok" : "empty",
            probe,
            fields: fields ? Object.keys(fields) : [],
            durationMs: Date.now() - started,
          };
        } catch (err) {
          return {
            id,
            ok: false,
            status: err instanceof AppError ? exitCodeName(err.exitCode) : "ERROR",
            probe,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });
    },
    render(data: Record<string, unknown>) {
      if (Array.isArray(data.sources)) {
        return (data.sources as { id: string; label: string; status: string; missing: string[] }[])
          .map(
            (source) =>
              `${source.id.padEnd(10)} ${source.status.padEnd(6)} ${source.label}${
                source.missing.length ? `  缺: ${source.missing.join(", ")}` : ""
              }`,
          )
          .join("\n");
      }
      const result = data as { id: string; ok: boolean; status: string; probe?: string; error?: string; fields?: string[] };
      return [
        `${result.id}: ${result.ok ? "通过" : "未通过"} (${result.status})`,
        result.probe ? `  探测番号 ${result.probe}` : "",
        result.fields?.length ? `  取到字段: ${result.fields.join(", ")}` : "",
        result.error ? `  ${result.error}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },

  {
    name: "task",
    summary: "任务: list | show <id> | retry <id> | cancel <id> | delete <id> —— 批量操作的进度与恢复",
    needsDb: true,
    args: [
      { name: "action", type: "string", description: "list | show | retry | cancel | delete", positional: true, default: "list" },
      { name: "id", type: "number", description: "任务号", positional: true },
      { name: "limit", type: "number", description: "list 条数", default: 10 },
    ],
    async run(ctx, args) {
      const action = args.positionals.action ?? "list";
      const id = args.positionals.id ? Number(args.positionals.id) : null;

      if (action === "list") {
        return { tasks: listTasks(ctx.rt!, { limit: Number(args.options.limit ?? 10) }) };
      }

      if (action === "show") {
        if (id === null) throw new AppError("用法: task show <id>", EXIT.USAGE);
        const task = getTask(ctx.rt!, id);
        if (!task) throw new AppError(`任务不存在: ${id}`, EXIT.NOT_FOUND, { id });
        const log = taskLogFiles(ctx.rt!.paths.logDir).find((file) =>
          file.includes(String(id).padStart(6, "0")),
        );
        return { task, log: log ?? null };
      }

      if (action === "delete") {
        if (id === null) throw new AppError("用法: task delete <id>", EXIT.USAGE);
        const removed = deleteTask(ctx.rt!, id);
        if (!removed) throw new AppError(`任务不存在: ${id}`, EXIT.NOT_FOUND, { id });
        return { deleted: id, note: "任务记录与它的日志一起删了 (不动任何媒体文件)" };
      }

      if (action === "retry") {
        if (id === null) throw new AppError("用法: task retry <id>", EXIT.USAGE);
        const task = retryTask(ctx.rt!, id);
        return { task, note: "已重新入队; 用对应的命令再跑一次即可继续 (例如 scrape --pending)" };
      }

      if (action === "cancel") {
        if (id === null) throw new AppError("用法: task cancel <id>", EXIT.USAGE);
        const cancelled = cancelTask(ctx.rt!, id);
        return { id, cancelled, note: cancelled ? "已取消" : "只有排队中的任务可以取消; 运行中的请用 Ctrl-C / 停止按钮" };
      }

      throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });
    },
    render(data: Record<string, unknown>) {
      if (Array.isArray(data.tasks)) {
        const tasks = data.tasks as TaskRow[];
        if (tasks.length === 0) return "没有任务。";
        return tasks
          .map(
            (task) =>
              `#${task.id} ${task.status.padEnd(12)} ${task.type.padEnd(16)} ${task.processed}/${task.total} 失败${task.failed}`,
          )
          .join("\n");
      }
      const task = (data.task ?? data) as TaskRow;
      return [
        `#${task.id} ${task.type} — ${task.status}`,
        `  进度  ${task.processed}/${task.total}  失败 ${task.failed}`,
        task.error ? `  错误  ${task.error}` : "",
        data.log ? `  日志  ${data.log}` : "",
        data.note ? `  ${data.note}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },

  {
    name: "config",
    summary: "配置: get (脱敏) | set --llm-base-url / --tmdb-api-key / --no-suggest-aliases ... | test-llm (真发一次模型请求) | path",
    needsDb: true,
    args: [
      { name: "action", type: "string", description: "get | set | test-llm | path", positional: true, default: "get" },
      { name: "dmm-api-id", type: "string", description: "set: DMM API ID" },
      { name: "dmm-affiliate-id", type: "string", description: "set: DMM affiliate ID" },
      { name: "proxy", type: "string", description: "set: 代理地址, auto 表示运行时探测, 空串清除" },
      { name: "llm-base-url", type: "string", description: "set: OpenAI 兼容端点, 如 https://api.deepseek.com/v1" },
      { name: "llm-api-key", type: "string", description: "set: 模型 API Key" },
      { name: "llm-model", type: "string", description: "set: 模型名, 如 deepseek-chat" },
      { name: "tmdb-api-key", type: "string", description: "set: TMDB API key (v3), 影视域来源凭据" },
      { name: "translate", type: "boolean", description: "set: 刮削后自动翻译" },
      { name: "no-translate", type: "boolean", description: "set: 关闭翻译开关", default: false },
      { name: "no-save-images", type: "boolean", description: "set: 图片只存缓存, 不复制到视频旁边", default: false },
      { name: "save-images", type: "boolean", description: "set: 图片同时复制一份到视频旁边 (默认开)", default: false },
      {
        name: "suggest-aliases",
        type: "boolean",
        description: "set: 找建议时让模型补别名(默认开); --no-suggest-aliases 关掉, 只靠正则抽的名字搜",
        default: true,
      },
    ],
    async run(ctx, args) {
      const action = args.positionals.action ?? "get";
      const paths = ctx.rt!.paths;

      if (action === "path") return { path: settingsPath(paths) };

      if (action === "get") {
        const dmm = resolveDmmEnv(ctx.rt!.settings);
        return {
          path: settingsPath(paths),
          settings: maskSettings(ctx.rt!.settings),
          dmmConfigured: isDmmConfigured(dmm),
          /** 环境变量优先于文件, 这里说明当前值实际来自哪。 */
          dmmFromEnv: Boolean(process.env.KURA_DMM_API_ID || process.env.KURA_DMM_AFFILIATE_ID),
          /** auto 需要探测才有真实地址, 这里只回显原始配置。 */
          proxy: resolveProxy(ctx.rt!.settings) ?? "",
          proxyFromEnv: Boolean(process.env.KURA_PROXY),
          llm: resolveLlm(ctx.rt!.settings) ? "已配置" : "未配置",
          translate: translateEnabled(ctx.rt!.settings),
          suggestAliases: ctx.rt!.settings.suggestAliases !== false,
          tmdb: resolveTmdbEnv(ctx.rt!.settings).apiKey ? "已配置" : "未配置",
          tmdbFromEnv: Boolean(process.env.KURA_TMDB_API_KEY),
        };
      }

      if (action === "test-llm") {
        const config = resolveLlm(ctx.rt!.settings);
        if (!config) {
          throw new AppError("未配置 LLM", EXIT.NEEDS_INPUT, {
            hint: "kura config set --llm-base-url https://api.deepseek.com/v1 --llm-api-key ... --llm-model deepseek-chat",
          });
        }
        const http = new HttpClient({ proxy: await resolveProxyUrl(ctx.rt!.settings) });
        const translated = await probeTranslator(http, config);
        return {
          ok: true,
          endpoint: `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
          model: config.model,
          sample: translated,
          translateEnabled: translateEnabled(ctx.rt!.settings),
        };
      }

      if (action === "set") {
        const patch: {
          dmm: { apiId?: string; affiliateId?: string };
          proxy?: string;
          tmdbApiKey?: string;
          llm: { baseUrl?: string; apiKey?: string; model?: string };
          translate?: boolean;
          saveImages?: boolean;
          suggestAliases?: boolean;
        } = { dmm: {}, llm: {} };
        if (typeof args.options["dmm-api-id"] === "string") patch.dmm.apiId = args.options["dmm-api-id"];
        if (typeof args.options["dmm-affiliate-id"] === "string") patch.dmm.affiliateId = args.options["dmm-affiliate-id"];
        if (typeof args.options.proxy === "string") patch.proxy = args.options.proxy;
        if (typeof args.options["tmdb-api-key"] === "string") patch.tmdbApiKey = args.options["tmdb-api-key"];
        if (typeof args.options["llm-base-url"] === "string") patch.llm.baseUrl = args.options["llm-base-url"];
        if (typeof args.options["llm-api-key"] === "string") patch.llm.apiKey = args.options["llm-api-key"];
        if (typeof args.options["llm-model"] === "string") patch.llm.model = args.options["llm-model"];
        if (typeof args.options.translate === "boolean") patch.translate = args.options.translate;
        if (args.options["no-translate"] === true) patch.translate = false;
        if (args.options["no-save-images"] === true) patch.saveImages = false;
        if (args.options["save-images"] === true) patch.saveImages = true;
        if (typeof args.options["suggest-aliases"] === "boolean") patch.suggestAliases = args.options["suggest-aliases"];

        const touched =
          Object.keys(patch.dmm).length > 0 ||
          Object.keys(patch.llm).length > 0 ||
          patch.proxy !== undefined ||
          patch.tmdbApiKey !== undefined ||
          patch.translate !== undefined ||
          patch.saveImages !== undefined ||
          patch.suggestAliases !== undefined;
        if (!touched) {
          throw new AppError(
            "用法: config set --dmm-api-id ... | --tmdb-api-key <key> | --proxy auto | --llm-base-url ... --llm-model ... | --translate | --save-images/--no-save-images | --suggest-aliases/--no-suggest-aliases",
            EXIT.USAGE,
          );
        }
        const saved = saveSettings(paths, patch);
        return {
          path: settingsPath(paths),
          settings: maskSettings(saved),
          dmmConfigured: isDmmConfigured(resolveDmmEnv(saved)),
          tmdbConfigured: Boolean(resolveTmdbEnv(saved).apiKey),
          proxy: resolveProxy(saved) ?? "",
          llm: resolveLlm(saved) ? "已配置" : "未配置",
          translate: translateEnabled(saved),
          saveImages: saved.saveImages ?? true,
        };
      }

      throw new AppError(`未知动作: ${action}`, EXIT.USAGE, { action });
    },
    render(data: Record<string, unknown>) {
      const settings = data.settings as { dmm: { apiId: string; affiliateId: string } } | undefined;
      return [
        `配置文件 ${data.path}`,
        settings ? `  dmm.api-id       ${settings.dmm.apiId || "(未设置)"}` : "",
        settings ? `  dmm.affiliate-id ${settings.dmm.affiliateId || "(未设置)"}` : "",
        settings ? `  DMM ${data.dmmConfigured ? "已配置" : "未配置"}` : "",
        `  proxy           ${String(data.proxy || "(未设置)")}`,
        `  LLM             ${String(data.llm ?? "-")}`,
        `  自动翻译        ${data.translate ? "开" : "关"}`,
      ]
        .filter(Boolean)
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
        // 永远该是 0。非 0 说明有代码路径绕过 setItemActors 直接写了 items.actors,
        // 结果是那批演员"点不进去" —— 这种结构性漂移不该静默留在库里。
        actorDrift: actorIndexDrift(ctx.rt!.db),
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
        `  演员漂移   ${data.actorDrift}`,
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
