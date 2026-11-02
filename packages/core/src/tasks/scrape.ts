import { AppError, EXIT, exitCodeName } from "../exit";
import { needsTranslation } from "../llm/translate";
import { aggregate, mergeWithPinned } from "../domain/aggregate";
import type { ItemKey, Metadata, SourceRecord } from "../domain/types";
import { metadataColumns, parseJson, pinnedFields, rowToMetadata, stringify, type ItemRow } from "../db/rows";
import { pruneActors, syncItemActors } from "../db/actors";
import { normalizeActorName } from "../domain/actors";
import type { Runtime } from "../runtime";
import { createTask, runTask, type TaskRow } from "./queue";
import { routeFor, type Registry } from "../sources";
import type { Translator } from "../llm/translate";

export interface ScrapeOptions {
  key: ItemKey;
  registry: Registry;
  fixturesDir?: string | null;
  /** 显式覆盖路由, 顺序即优先级。`--source fixture` 用它。 */
  sources?: string[];
  dryRun?: boolean;
  /** 传了就在落库前翻译 title/plot; 失败保留原值, 不影响刮削。 */
  translator?: Translator | null;
  /** 用户取消: 传给每个请求, 已发出的请求会立刻中断。 */
  signal?: AbortSignal;
  /**
   * 单条目的总预算(毫秒)。默认 20s。
   * 没有它时, 一个源卡住会走满 "15s 超时 × 3 次重试" ≈ 45s, 批量跑时就是灾难。
   */
  itemBudgetMs?: number;
}

export interface ScrapeReport {
  key: string;
  contentType: string;
  /** 实际参与的来源(按优先级)。 */
  route: string[];
  /** 路由里声明了但还没实现的来源。 */
  skipped: string[];
  filled: string[];
  empty: string[];
  failures: { site: string; error: string; code?: string }[];
  metadata: Metadata | null;
  dryRun: boolean;
  /** 翻译失败的原因 (模型不通/配置错)。刮削照常成功, 但这里必须有话说。 */
  translateErrors?: string[];
}

/**
 * SCRAPE: 只读网络, 不动文件。
 * 一个源失败不让整次刮削失败 —— 这是"站点是易碎品"的直接体现。
 */
export async function scrape(rt: Runtime, opts: ScrapeOptions): Promise<ScrapeReport> {
  try {
    const report = await scrapeOnce(rt, opts);
    return report;
  } catch (err) {
    // 取消不算一次失败尝试; dry-run 不动数据库。
    if (!opts.dryRun && !opts.signal?.aborted) {
      recordFailure(rt, opts.key.value, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

/** 默认重试上限: 到顶后不再自动进待刮队列, 需显式 --retry-failed。 */
export const MAX_SCRAPE_ATTEMPTS = 3;

function recordFailure(rt: Runtime, key: string, message: string): void {
  rt.db.run(
    "update items set scrape_attempts = scrape_attempts + 1, last_error = ? where number = ?",
    [message, key],
  );
}

async function scrapeOnce(rt: Runtime, opts: ScrapeOptions): Promise<ScrapeReport> {
  const dryRun = opts.dryRun ?? false;
  const declared = routeFor(opts.registry, opts.key.contentType, opts.sources);
  const usable = declared.filter((source) => source.status === "ready");
  const skipped = declared.filter((source) => source.status !== "ready").map((source) => source.id);

  if (usable.length === 0) {
    throw new AppError(
      `没有可用来源 (路由: ${declared.map((s) => s.id).join(" → ") || "空"})`,
      EXIT.NEEDS_INPUT,
      { contentType: opts.key.contentType, skipped },
    );
  }

  if (opts.signal?.aborted) throw new AppError("已取消", EXIT.RETRYABLE);

  // 单条目的总预算: 卡住的源不该拖住整批。
  const budget = AbortSignal.timeout(opts.itemBudgetMs ?? 20_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;

  const settled = await Promise.allSettled(
    usable.map((source) => source.fetch(opts.key, { fixturesDir: opts.fixturesDir ?? null, signal })),
  );

  const records: SourceRecord[] = [];
  const failures: { site: string; error: string; code?: string }[] = [];

  settled.forEach((result, index) => {
    const site = usable[index]!.id;
    if (result.status === "rejected") {
      const reason = result.reason;
      failures.push({
        site,
        error: reason instanceof Error ? reason.message : String(reason),
        code: reason instanceof AppError ? exitCodeName(reason.exitCode) : undefined,
      });
      return;
    }
    if (result.value) records.push({ site, fields: result.value });
  });

  // 一条记录都没拿到时不能落一个空条目: 那会让"缺凭据"看起来像"刮削成功但没字段"。
  if (records.length === 0) {
    const blocked = failures.find((failure) => failure.code === "NEEDS_INPUT");
    if (blocked) {
      throw new AppError(blocked.error, EXIT.NEEDS_INPUT, { source: blocked.site, failures });
    }
    if (failures.length > 0) {
      throw new AppError(`所有来源都失败: ${failures.map((failure) => `${failure.site}(${failure.error})`).join("; ")}`, EXIT.RETRYABLE, { failures });
    }
    throw new AppError(`来源里没有这个番号: ${opts.key.value}`, EXIT.NOT_FOUND, { key: opts.key.value });
  }

  const incoming = aggregate(records, usable.map((source) => source.id));

  const existingRow = rt.db.get<ItemRow>("select * from items where number = ?", [opts.key.value]);
  const existing = existingRow ? rowToMetadata(existingRow) : null;
  const pinned = existing ? pinnedFields(rt.db, opts.key.value) : [];
  const merged = mergeWithPinned(incoming, existing ?? {}, pinned);

  const metadata: Metadata = {
    key: opts.key.value,
    number: opts.key.number,
    contentType: opts.key.contentType,
    ...merged.fields,
    fieldSources: merged.fieldSources,
  };

  // 译文不是来源字段, 重新刮削不能把它冲掉。
  // 有 *_original 就说明 title/plot 是译文 —— 保留译文与原文, 让 translateMetadata
  // 从原文重新翻 (否则已翻过的条目会被打回"待翻译", 目录名也会跟着漂)。
  if (existing?.titleOriginal) {
    metadata.title = existing.title;
    metadata.titleOriginal = existing.titleOriginal;
  }
  if (existing?.plotOriginal) {
    metadata.plot = existing.plot;
    metadata.plotOriginal = existing.plotOriginal;
  }

  const errorsBefore = opts.translator?.errors.length ?? 0;
  if (opts.translator) await translateMetadata(metadata, opts.translator);
  const translateErrors = opts.translator?.errors.slice(errorsBefore) ?? [];
  if (!dryRun) persist(rt, metadata, records);

  const filled = Object.entries(merged.fields)
    .filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0))
    .map(([key]) => key);

  return {
    key: opts.key.value,
    contentType: opts.key.contentType,
    route: usable.map((source) => source.id),
    skipped,
    filled,
    empty: ["title", "plot", "release_date", "duration_min", "studio", "label", "series", "directors", "actors", "tags"].filter(
      (key) => !filled.includes(key),
    ),
    failures,
    metadata: dryRun ? null : metadata,
    dryRun,
    ...(translateErrors.length > 0 ? { translateErrors } : {}),
  };
}

/**
 * 覆盖显示值, 原文进 *_original; 任一字段失败只影响该字段。
 *
 * 翻译的输入永远是**原文**: 已经有了 *_original 就从它翻, 不是拿上次的译文再翻一遍
 * (那样会二次污染, 而且重复刮削时译文会越翻越偏)。
 */
async function translateMetadata(metadata: Metadata, translator: Translator): Promise<void> {
  const titleSource = metadata.titleOriginal ?? metadata.title;
  const plotSource = metadata.plotOriginal ?? metadata.plot;

  const title = titleSource && needsTranslation(titleSource) ? await translator.translate("title", titleSource) : null;
  const plot = plotSource && needsTranslation(plotSource) ? await translator.translate("plot", plotSource) : null;
  if (!title && !plot) return;

  metadata.titleOriginal = titleSource;
  metadata.plotOriginal = plotSource;
  if (title) metadata.title = title;
  if (plot) metadata.plot = plot;
}

function persist(rt: Runtime, metadata: Metadata, records: SourceRecord[]): void {
  // 成功即清零, 让"曾经失败过"不会永久留在条目上。
  rt.db.run("update items set scrape_attempts = 0, last_error = null where number = ?", [metadata.key]);
  const columns = metadataColumns(metadata);
  const names = Object.keys(columns);

  rt.db.exec("begin");
  try {
    rt.db.run(
      `insert into items (${names.join(", ")}, updated_at) values (${names.map(() => "?").join(", ")}, unixepoch())
       on conflict(number) do update set ${names
         .filter((name) => name !== "number")
         .map((name) => `${name} = excluded.${name}`)
         .join(", ")}, updated_at = unixepoch()`,
      names.map((name) => columns[name]),
    );

    for (const record of records) {
      rt.db.run(
        `insert into snapshots (number, site, fields, fetched_at) values (?, ?, ?, unixepoch())
         on conflict(number, site) do update set fields = excluded.fields, fetched_at = unixepoch()`,
        [metadata.key, record.site, JSON.stringify(record.fields)],
      );
    }

    // 演员索引是 items.actors 的派生物: 条目写完了就重建, 顺带清掉没人指向的演员。
    syncItemActors(rt.db, metadata.key);
    pruneActors(rt.db);

    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }
}

/** 待刮削 = 有番号但还没有标题的条目。 */
export interface ScrapeProgress {
  index: number;
  total: number;
  key: string;
  ok: boolean;
  filled: number;
  error?: string;
}

export interface ScrapePendingOptions extends Omit<ScrapeOptions, "key"> {
  limit?: number;
  /** 连已经到重试上限的条目一起重试 (--retry-failed)。 */
  includeFailed?: boolean;
  onProgress?: (progress: ScrapeProgress) => void;
}

export interface TaskScrapeResult extends ScrapePendingResult {
  taskId: number;
}

export interface TaskScrapeOptions extends ScrapePendingOptions {}

/**
 * 把批量刮削跑成一条可追溯的任务: 写 tasks 表 + 每任务日志, 退出后仍能看到进度。
 * 逐条逻辑仍复用 scrapePending, 不复制第二份循环。
 */
export async function scrapePendingTask(
  rt: Runtime,
  options: TaskScrapeOptions,
  signal: AbortSignal,
): Promise<{ task: TaskRow; result: TaskScrapeResult | null }> {
  const total = pendingKeys(rt, options.limit ?? 50, { includeFailed: options.includeFailed }).length;
  const task = createTask(rt, {
    type: "scrape.pending",
    payload: { limit: options.limit ?? 50, sources: options.sources ?? null, includeFailed: Boolean(options.includeFailed) },
    total,
  });

  return runTask(rt, task, signal, async (run) => {
    // 用外部 signal 时, run.signal 就是它
    const result = await scrapePending(rt, {
      ...options,
      signal: run.signal,
      onProgress: (progress) => {
        run.progress(progress.index, progress.ok ? 0 : 1, progress.total);
        run.log.write("item", progress as unknown as Record<string, unknown>);
        options.onProgress?.(progress);
      },
    });
    const failed = result.reports.filter((report) => !report.ok).length;
    return { result: { ...result, taskId: task.id }, processed: result.reports.length, failed };
  });
}

export interface ScrapePendingResult {
  total: number;
  reports: ScrapeProgress[];
  cancelled: boolean;
}

/**
 * 批量刮削。逐条落库、逐条回报进度, 并在每条之间检查取消信号。
 * CLI 与 GUI 都走这里 —— 之前两边各写一份循环, 进度与取消的语义必然会漂。
 */
export async function scrapePending(
  rt: Runtime,
  options: ScrapePendingOptions,
): Promise<ScrapePendingResult> {
  const keys = pendingKeys(rt, options.limit ?? 50, { includeFailed: options.includeFailed });
  const reports: ScrapeProgress[] = [];
  // 先报总数: 否则第一条请求的几秒里界面只能显示"准备中"。
  options.onProgress?.({ index: 0, total: keys.length, key: "", ok: true, filled: 0 });

  for (const [index, key] of keys.entries()) {
    if (options.signal?.aborted) return { total: keys.length, reports, cancelled: true };

    let progress: ScrapeProgress;
    try {
      const report = await scrape(rt, { ...options, key });
      progress = { index: index + 1, total: keys.length, key: key.value, ok: true, filled: report.filled.length };
    } catch (err) {
      progress = {
        index: index + 1,
        total: keys.length,
        key: key.value,
        ok: false,
        filled: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    reports.push(progress);
    options.onProgress?.(progress);
  }

  return { total: keys.length, reports, cancelled: false };
}
export function pendingKeys(
  rt: Runtime,
  limit = 50,
  options: { includeFailed?: boolean } = {},
): ItemKey[] {
  const exhausted = options.includeFailed ? "" : ` and scrape_attempts < ${MAX_SCRAPE_ATTEMPTS}`;
  const rows = rt.db.all<{ number: string; content_type: string }>(
    `select number, content_type from items where (title is null or title = '')${exhausted} order by number limit ?`,
    [limit],
  );
  return rows.map((row) => ({
    value: row.number,
    number: row.number,
    contentType: row.content_type as ItemKey["contentType"],
  }));
}

export interface ItemView extends Metadata {
  pinned: string[];
}

export function getItem(rt: Runtime, key: string): ItemView | null {
  const row = rt.db.get<ItemRow>("select * from items where number = ?", [key]);
  if (!row) return null;
  return { ...rowToMetadata(row), pinned: pinnedFields(rt.db, key) };
}

export interface ListItemOptions {
  limit?: number;
  offset?: number;
  type?: string;
  /** 按演员过滤。接受任意写法, 内部按 normalizeActorName 归一后匹配。 */
  actor?: string;
  /** 只看这个媒体库里的条目 (按 media_files 反查)。 */
  libraryId?: number;
  /** 关键词: 番号/标题/原名/片商/系列/演员/标签 都算命中。 */
  q?: string;
  /**
   * 刮削状态。`unscraped` 就是"有番号但还没标题" —— 界面上最常用的一个筛选,
   * 因为刮削失败、排队、抓不到源的条目都堆在这一堆里。
   */
  state?: "unscraped" | "scraped" | "exhausted";
  studio?: string;
  label?: string;
  series?: string;
  director?: string;
  tag?: string;
  /** 排序。不给就按更新时间倒序 (最近刮到的在最前)。 */
  sort?: ItemSort;
}

/**
 * 可排序字段的**白名单**。
 *
 * 字段名会拼进 SQL, 所以只能是这张表里的固定字符串 —— 不接受调用方传列名。
 */
export type ItemSortField = "updated" | "number" | "title" | "release" | "studio" | "duration";

export interface ItemSort {
  field: ItemSortField;
  /** true = 从大到小 / 从后到前。默认升序。 */
  desc?: boolean;
}

const SORT_COLUMNS: Record<ItemSortField, string> = {
  updated: "items.updated_at",
  number: "items.number",
  title: "items.title",
  release: "items.release_date",
  studio: "items.studio",
  duration: "items.duration_min",
};

/** 文本列排序时把空值排到最后: 否则"未刮削"的条目会占满第一页。 */
const SORT_TEXT_FIELDS = new Set<ItemSortField>(["number", "title", "studio", "release"]);

export function isItemSortField(value: string): value is ItemSortField {
  return value in SORT_COLUMNS;
}

function itemOrderBy(sort: ItemSort | undefined): string {
  if (!sort) return "order by items.updated_at desc";
  const column = SORT_COLUMNS[sort.field];
  const direction = sort.desc ? "desc" : "asc";
  if (!SORT_TEXT_FIELDS.has(sort.field)) return `order by ${column} ${direction}`;
  // 空值固定排最后, 与方向无关
  return `order by (${column} is null or ${column} = '') asc, ${column} collate nocase ${direction}`;
}

/**
 * 过滤条件集中在一处: listItems 与 countItems 必须用同一套 where,
 * 否则"共 N 条"和列表长度会对不上。
 */
function itemFilters(options: Omit<ListItemOptions, "limit" | "offset">): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.type) {
    where.push("items.content_type = ?");
    params.push(options.type);
  }

  if (options.libraryId !== undefined) {
    where.push("items.number in (select number from media_files where library_id = ? and number is not null)");
    params.push(options.libraryId);
  }

  if (options.actor) {
    // 演员是实体索引, 所以这里是 join 而不是 like —— 名字里的空白/全半角差异不该影响命中。
    where.push(
      "items.number in (select ia.number from item_actors ia join actors a on a.id = ia.actor_id where a.normalized = ?)",
    );
    params.push(normalizeActorName(options.actor));
  }

  for (const [field, column] of [
    ["studio", "studio"],
    ["label", "label"],
    ["series", "series"],
  ] as const) {
    const value = options[field];
    if (value) {
      where.push(`${column} = ? collate nocase`);
      params.push(value);
    }
  }

  // 多值字段是 JSON 数组, 用 json_each 拆开精确比对 (LIKE 会把 "甲" 匹配到 "甲乙")
  for (const [field, column] of [
    ["director", "directors"],
    ["tag", "tags"],
  ] as const) {
    const value = options[field];
    if (value) {
      where.push(`exists (select 1 from json_each(items.${column}) where value = ? collate nocase)`);
      params.push(value);
    }
  }

  if (options.state === "unscraped") {
    where.push("(items.title is null or items.title = '')");
  } else if (options.state === "scraped") {
    where.push("(items.title is not null and items.title <> '')");
  } else if (options.state === "exhausted") {
    where.push(`items.scrape_attempts >= ${MAX_SCRAPE_ATTEMPTS}`);
  }

  if (options.q) {
    const like = `%${options.q}%`;
    where.push(`(
      items.number like ? collate nocase
      or items.title like ?
      or items.title_original like ?
      or items.studio like ?
      or items.label like ?
      or items.series like ?
      or exists (select 1 from json_each(items.actors) where value like ?)
      or exists (select 1 from json_each(items.tags) where value like ?)
      or exists (select 1 from json_each(items.directors) where value like ?)
    )`);
    params.push(like, like, like, like, like, like, like, like, like);
  }

  return { where, params };
}

export function listItems(rt: Runtime, options: ListItemOptions = {}): ItemView[] {
  const { where, params } = itemFilters(options);
  const sql = `select items.* from items${where.length > 0 ? ` where ${where.join(" and ")}` : ""} ${itemOrderBy(options.sort)} limit ? offset ?`;
  const rows = rt.db.all<ItemRow>(sql, [...params, options.limit ?? 50, options.offset ?? 0]);
  return rows.map((row) => ({ ...rowToMetadata(row), pinned: parseJson<string[]>(row.pinned) ?? [] }));
}

/** 分页要显示"第 x/共 N 条", 所以总数得单独算一次。 */
export function countItems(rt: Runtime, options: Omit<ListItemOptions, "limit" | "offset"> = {}): number {
  const { where, params } = itemFilters(options);
  const row = rt.db.get<{ c: number }>(
    `select count(*) c from items${where.length > 0 ? ` where ${where.join(" and ")}` : ""}`,
    params,
  );
  return row?.c ?? 0;
}

export function countPending(rt: Runtime): number {
  const row = rt.db.get<{ c: number }>(
    `select count(*) c from items where (title is null or title = '') and scrape_attempts < ${MAX_SCRAPE_ATTEMPTS}`,
  );
  return row?.c ?? 0;
}

/** 已到重试上限、不再自动重试的条目数。 */
export function countExhausted(rt: Runtime): number {
  const row = rt.db.get<{ c: number }>(
    `select count(*) c from items where (title is null or title = '') and scrape_attempts >= ${MAX_SCRAPE_ATTEMPTS}`,
  );
  return row?.c ?? 0;
}
