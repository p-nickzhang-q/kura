import { sep } from "node:path";
import { AppError, EXIT } from "../exit";
import { parseTmdbKey, type TmdbClient, type TmdbShow } from "../sources/tmdb";
import type { Runtime } from "../runtime";
import type { Domain, FieldKey, RawFields } from "../domain/types";
import { stringify } from "../db/rows";
import { setItemActors } from "../db/actors";
import { createTask, runTask, type TaskRow } from "./queue";

/**
 * 影视域的刮削: 按 TMDB 身份取字段, 落剧级字段 + 集级行。
 *
 * 与 av 域最大的不同是**粒度为整部剧**: 一次请求拿剧, 再按季拿集列表。
 * 按集记账会让"点一次刮削"产生几百个任务项, 而失败是整部剧失败 (剧没找到, 集无从谈起)。
 */

export interface ScrapeShowReport {
  key: string;
  /** 条目字段是否写进了库。 */
  ok: boolean;
  /** 写进去的字段名 (给界面/CLI 显示"刮到了什么")。 */
  fields: FieldKey[];
  /** 落库的集数。 */
  episodes: number;
  /** 来源声明的集数 (缺集判据的分子)。 */
  declared: number;
  /** 盘上真正绑着的集数。 */
  bound: number;
  /** 声明有、盘上没有的集数;> 0 就是"缺集"。 */
  missing: number;
  error?: string;
}

export interface ScrapeShowOptions {
  key: string;
  tmdb: TmdbClient;
  /** 只刮这些季;默认全季 (跳过 0 = 特别篇, ADR 0008 不做特典)。 */
  seasons?: number[];
  signal?: AbortSignal;
}

/**
 * 刮一部剧或一部电影。
 *
 * 只写"来源给了的东西": 缺的字段保持原值, 不当成"清空"。这样重复刮削是幂等的,
 * 也不会因为 TMDB 某天少了简介就把库里的简介抹掉。
 */
export async function scrapeShow(rt: Runtime, options: ScrapeShowOptions): Promise<ScrapeShowReport> {
  const target = parseTmdbKey(options.key);
  if (!target) throw new AppError(`不是 TMDB 身份: ${options.key}`, EXIT.USAGE, { key: options.key });
  const key = options.key.toLowerCase();

  ensureItem(rt, key, target.kind);

  if (target.kind === "movie") {
    const movie = await options.tmdb.movie(target.id, { signal: options.signal });
    if (!movie) return { key, ok: false, fields: [], episodes: 0, declared: 0, bound: 0, missing: 0, error: "TMDB 没有这部片" };
    const fields = writeFields(rt, key, movie.fields, movie.originalTitle);
    const bound = boundEpisodes(rt, key);
    return { key, ok: true, fields, episodes: 0, declared: 0, bound, missing: 0 };
  }

  const show: TmdbShow | null = await options.tmdb.show(target.id, {
    ...(options.seasons ? { seasons: options.seasons } : {}),
    signal: options.signal,
  });
  if (!show) return { key, ok: false, fields: [], episodes: 0, declared: 0, bound: 0, missing: 0, error: "TMDB 没有这部剧" };

  const fields = writeFields(rt, key, show.fields, show.originalTitle);
  writeEpisodes(rt, key, show);
  // 剧级时长常常缺 (TMDB 的 episode_run_time 经常不给中文条目), 而集级每集都有。
  // 用集级里最常见的时长补上 —— 列表里"24 分钟"比空白有用。
  fillDurationFromEpisodes(rt, key);

  // 声明集数与落库集数都排除第 0 季(特别篇): 不落库的东西不该算进"缺集"
  const realSeasons = show.seasons.filter((season) => season.season > 0);
  const declared = realSeasons.reduce((sum, season) => sum + season.declaredEpisodes, 0);
  const bound = boundEpisodes(rt, key);
  return {
    key,
    ok: true,
    fields,
    episodes: realSeasons.reduce((sum, season) => sum + season.episodes.length, 0),
    declared,
    bound,
    missing: Math.max(0, declared - bound),
  };
}

/** 待刮的影视条目: 没标题, 或除 nfo 之外没有任何来源填过字段。 */
export function pendingShowKeys(rt: Runtime, options: { libraryId?: number; limit?: number } = {}): string[] {
  const where = ["items.domain <> 'av'"];
  const params: (number | string)[] = [];
  if (options.libraryId !== undefined) {
    where.push("exists (select 1 from media_files mf where mf.number = items.number and mf.library_id = ?)");
    params.push(options.libraryId);
  }
  // 与 av 域同一条判据: 标题空, 或者 field_sources 里除 nfo 再没别的
  where.push(`(
    items.title is null or items.title = ''
    or not exists (select 1 from json_each(items.field_sources) where json_each.value not in ('nfo'))
  )`);
  params.push(options.limit ?? 50);
  return rt.db
    .all<{ number: string }>(`select number from items where ${where.join(" and ")} order by number limit ?`, params)
    .map((row) => row.number);
}

export function countPendingShows(rt: Runtime, options: { libraryId?: number } = {}): number {
  return pendingShowKeys(rt, { ...options, limit: Number.MAX_SAFE_INTEGER }).length;
}

export interface EpisodeStats {
  /** 来源声明/已落库的集数。 */
  declared: number;
  /** 盘上真有的集数。 */
  bound: number;
}

/** 一批剧的集数统计(列表角标 `9/12` 与详情页都用它)。 */
export function episodeStats(rt: Runtime, keys: string[]): Record<string, EpisodeStats> {
  const out: Record<string, EpisodeStats> = {};
  if (keys.length === 0) return out;
  const placeholders = keys.map(() => "?").join(", ");
  // 声明 = episodes 表(来源给的集列表); 盘上 = media_files 里有季号的集。
  // 两者都不含对方的行 —— 混算过一次, 结果 165 集的剧报出 310 集。
  for (const row of rt.db.all<{ number: string; n: number }>(
    `select number, count(*) as n from episodes where number in (${placeholders}) group by number`,
    keys,
  )) {
    out[row.number] = { declared: row.n, bound: 0 };
  }
  for (const row of rt.db.all<{ number: string; n: number }>(
    `select number, count(*) as n from media_files
     where number in (${placeholders}) and season is not null and episode is not null
     group by number`,
    keys,
  )) {
    const current = out[row.number] ?? { declared: 0, bound: 0 };
    out[row.number] = { declared: current.declared, bound: row.n };
  }
  return out;
}

/** 一个剧的所有集(按季、集号排序), 详情页按季分组用。 */
export interface EpisodeView {
  season: number;
  episode: number;
  title: string | null;
  airDate: string | null;
  runtimeMin: number | null;
  hasFile: boolean;
  /** 盘上有这一集, 但来源的集列表里没有这个 (季,集) —— 集号可能对不上。 */
  undeclared?: boolean;
}

export function listEpisodes(rt: Runtime, key: string): EpisodeView[] {
  const rows = rt.db.all<{
    season: number;
    episode: number;
    title: string | null;
    air_date: string | null;
    duration_min: number | null;
    file_count: number;
  }>(
    `select e.season, e.episode, e.title, e.air_date, e.duration_min,
            (select count(*) from media_files mf
             where mf.number = e.number and mf.season = e.season and mf.episode = e.episode) as file_count
     from episodes e where e.number = ? order by e.season, e.episode`,
    [key],
  );
  const declared = rows.map((row) => ({
    season: row.season,
    episode: row.episode,
    title: row.title,
    airDate: row.air_date,
    runtimeMin: row.duration_min,
    hasFile: row.file_count > 0,
  }));

  // 盘上有、但声明里没有的 (季,集): 不显示的话这些文件在详情页里"消失"了,
  // 而这正是"集号对不上"最需要被看见的地方。
  const seen = new Set(declared.map((row) => `${row.season}-${row.episode}`));
  const extra = rt.db
    .all<{ season: number; episode: number; n: number }>(
      `select season, episode, count(*) as n from media_files
       where number = ? and season is not null and episode is not null
       group by season, episode`,
      [key],
    )
    .filter((row) => !seen.has(`${row.season}-${row.episode}`))
    .map((row) => ({
      season: row.season,
      episode: row.episode,
      title: null,
      airDate: null,
      runtimeMin: null,
      hasFile: true,
      undeclared: true,
    }));

  return [...declared, ...extra].sort((a, b) => a.season - b.season || a.episode - b.episode);
}

/**
 * 按"整部剧的绝对集号"把文件摊到各季。
 *
 * 国内资源站的合集常常是 `001集 … 165集` 这种**跨季连续编号**(成长的烦恼 7 季 166 集),
 * 文件名里没有季号, 于是全落在第 1 季、且集号与声明的第 1 季对不上。
 * 这里按播出顺序把第 i 个文件映射到声明的第 i 集 —— 只认 aired order, 不做别的排序。
 */
export function spreadAbsoluteEpisodes(
  rt: Runtime,
  options: { key: string; dir?: string },
): { key: string; files: number; declared: number; mapped: number; unmapped: number; from: string; to: string } {
  const key = options.key.toLowerCase();
  const declared = rt.db.all<{ season: number; episode: number }>(
    "select season, episode from episodes where number = ? order by season, episode",
    [key],
  );
  if (declared.length === 0) {
    throw new AppError("这个条目还没有声明的集列表, 先刮削一次", EXIT.NEEDS_INPUT, { key });
  }

  const where = ["number = ?", "episode is not null"];
  const params: (string | number)[] = [key];
  if (options.dir) {
    where.push("path like ?");
    params.push(`${options.dir.replace(/[\\/]+$/, "")}${sep}%`);
  }
  const files = rt.db.all<{ path: string; season: number | null; episode: number | null }>(
    `select path, season, episode from media_files where ${where.join(" and ")} order by season, episode, path`,
    params,
  );
  if (files.length === 0) throw new AppError("这个条目没有带集号的文件", EXIT.NOT_FOUND, { key });

  const limit = Math.min(files.length, declared.length);
  rt.db.exec("begin");
  try {
    for (let index = 0; index < limit; index++) {
      const file = files[index]!;
      const target = declared[index]!;
      rt.db.run("update media_files set season = ?, episode = ? where path = ?", [
        target.season,
        target.episode,
        file.path,
      ]);
    }
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  const first = declared[0]!;
  const last = declared[limit - 1]!;
  return {
    key,
    files: files.length,
    declared: declared.length,
    mapped: limit,
    unmapped: Math.max(0, files.length - limit),
    from: `S${first.season}E${first.episode}`,
    to: `S${last.season}E${last.episode}`,
  };
}

export interface ScrapeShowsResult {
  libraryId: number | null;
  reports: ScrapeShowReport[];
  taskId?: number;
}

export interface ScrapeShowsOptions {
  tmdb: TmdbClient;
  libraryId?: number;
  keys?: string[];
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { index: number; total: number; key: string; ok: boolean; missing: number }) => void;
}

/** 一批剧顺序刮。并发留给上层: TMDB 的 per-host 漏桶已经是串行的。 */
export async function scrapeShows(rt: Runtime, options: ScrapeShowsOptions): Promise<ScrapeShowsResult> {
  const keys = options.keys ?? pendingShowKeys(rt, { libraryId: options.libraryId, limit: options.limit ?? 50 });
  const reports: ScrapeShowReport[] = [];

  for (let index = 0; index < keys.length; index++) {
    if (options.signal?.aborted) break;
    const key = keys[index]!;
    let report: ScrapeShowReport;
    try {
      report = await scrapeShow(rt, { key, tmdb: options.tmdb, signal: options.signal });
    } catch (err) {
      // 一条失败不中断整批 —— 与 av 域一致
      report = {
        key,
        ok: false,
        fields: [],
        episodes: 0,
        declared: 0,
        bound: 0,
        missing: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    reports.push(report);
    options.onProgress?.({
      index: index + 1,
      total: keys.length,
      key,
      ok: report.ok,
      missing: report.missing,
    });
  }

  return { libraryId: options.libraryId ?? null, reports };
}

export async function scrapeShowsTask(
  rt: Runtime,
  options: ScrapeShowsOptions,
  signal: AbortSignal,
): Promise<{ task: TaskRow; result: ScrapeShowsResult | null }> {
  const keys = options.keys ?? pendingShowKeys(rt, { libraryId: options.libraryId, limit: options.limit ?? 50 });
  const task = createTask(rt, {
    type: "scrape.tv",
    payload: { libraryId: options.libraryId ?? null, keys: options.keys ? options.keys.length : null },
    total: keys.length,
  });

  return runTask(rt, task, signal, async (run) => {
    const result = await scrapeShows(rt, {
      ...options,
      keys,
      signal: run.signal,
      onProgress: (progress) => {
        run.progress(progress.index, progress.ok ? 0 : 1, progress.total);
        run.log.write("item", { ...progress });
        options.onProgress?.(progress);
      },
    });
    const failed = result.reports.filter((report) => !report.ok).length;
    return { result: { ...result, taskId: task.id }, processed: result.reports.length, failed };
  });
}

function ensureItem(rt: Runtime, key: string, kind: "tv" | "movie"): void {
  const domain: Domain = kind === "tv" ? "tv" : "movie";
  // content_type 对影视条目是空串: 它只在 av 域有意义, 而列是 not null
  rt.db.run("insert or ignore into items (number, content_type, domain) values (?, '', ?)", [key, domain]);
  // 万一条目的 domain 与身份种类不一致(手工改过库结构), 以身份为准纠正
  rt.db.run("update items set domain = ? where number = ? and (domain is null or domain <> ?)", [domain, key, domain]);
}

/**
 * 写剧级/电影字段, 返回真正写进去的字段名。
 *
 * 只写来源给了的东西:缺的字段保持原值, 不当成"清空" —— 重复刮削因此是幂等的,
 * 也不会因为 TMDB 某天少了简介就把库里的简介抹掉。
 */
function writeFields(
  rt: Runtime,
  key: string,
  fields: RawFields,
  originalTitle: string | null,
): FieldKey[] {
  const row = rt.db.get<{ field_sources: string | null }>("select field_sources from items where number = ?", [key]);
  const sources = parseSources(row?.field_sources);
  const sets: string[] = [];
  const params: unknown[] = [];
  const written: FieldKey[] = [];

  const put = (field: FieldKey, value: unknown): void => {
    sets.push(`${field} = ?`);
    params.push(value);
    sources[field] = "tmdb";
    written.push(field);
  };

  const raw = fields as Record<string, unknown>;
  // 演员单独处理: 它要同时写 JSON 和派生索引, 见下面 setItemActors
  const actorNames = Array.isArray(raw.actors) ? (raw.actors as string[]) : null;
  for (const field of SINGLE_FIELDS_OUT) {
    const value = raw[field];
    if (value === undefined || value === null || value === "") continue;
    put(field as FieldKey, value);
  }
  for (const field of LIST_FIELDS_OUT) {
    const value = raw[field];
    if (!Array.isArray(value) || value.length === 0) continue;
    put(field as FieldKey, stringify(value));
  }

  for (const field of URL_FIELDS_OUT) {
    const value = raw[field];
    if (!Array.isArray(value) || value.length === 0) continue;
    put(field as FieldKey, stringify(value));
  }
  if (originalTitle) {
    sets.push("title_original = ?");
    params.push(originalTitle);
    sources.title_original = "tmdb";
  }

  sets.push("field_sources = ?");
  params.push(stringify(sources));
  sets.push("updated_at = unixepoch()");
  rt.db.run(`update items set ${sets.join(", ")} where number = ?`, [...params, key]);

  // 演员必须走唯一入口: 它要同时写 items.actors 与 item_actors 索引。
  // 直接写 JSON 的后果是"演员筛选里搜不到这批剧的演员" —— 和 0.6.18 修的
  // 那个 nfo 漂移是同一个坑, 只是这次是自己踩的。
  if (actorNames && actorNames.length > 0) {
    setItemActors(rt.db, key, actorNames);
    written.push("actors");
  }

  return written;
}

/** 影视域真正会写到的列。av 的 content_type / pinned 之类绝不在这里出现。 */
const SINGLE_FIELDS_OUT = ["title", "plot", "release_date", "duration_min", "studio", "label", "series"] as const;
/** 演员不在里面: 它走 setItemActors (写 JSON + 建索引), 不能当普通列写 */
const LIST_FIELDS_OUT = ["directors", "tags"] as const;
const URL_FIELDS_OUT = ["poster_urls", "cover_urls", "thumb_urls"] as const;

function writeEpisodes(rt: Runtime, key: string, show: TmdbShow): void {
  rt.db.exec("begin");
  try {
    for (const season of show.seasons) {
      // 第 0 季是特别篇: ADR 0008 明确不做特典
      if (season.season <= 0) continue;
      for (const episode of season.episodes) {
        rt.db.run(
          `insert into episodes (number, season, episode, title, plot, air_date, duration_min, field_sources)
           values (?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(number, season, episode) do update set
             title = excluded.title, plot = excluded.plot, air_date = excluded.air_date,
             duration_min = excluded.duration_min, field_sources = excluded.field_sources`,
          [
            key,
            season.season,
            episode.episode,
            episode.title,
            episode.plot,
            episode.airDate,
            episode.runtimeMin,
            stringify({ title: "tmdb", plot: "tmdb", air_date: "tmdb", duration_min: "tmdb" }),
          ],
        );
      }
    }
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }
}

/** 剧级时长缺失时, 用集级里最常见的时长补 (只补空, 不覆盖已有值)。 */
function fillDurationFromEpisodes(rt: Runtime, key: string): void {
  const row = rt.db.get<{ duration_min: number | null }>("select duration_min from items where number = ?", [key]);
  if (row?.duration_min) return;
  const best = rt.db.get<{ duration_min: number; n: number }>(
    `select duration_min, count(*) as n from episodes
     where number = ? and duration_min is not null and duration_min > 0
     group by duration_min order by n desc, duration_min asc limit 1`,
    [key],
  );
  if (!best?.duration_min) return;
  rt.db.run("update items set duration_min = ? where number = ? and duration_min is null", [
    best.duration_min,
    key,
  ]);
}

/** 盘上真正绑了集的文件数 —— 缺集判据的分母。 */
function boundEpisodes(rt: Runtime, key: string): number {
  return (
    rt.db.get<{ n: number }>(
      "select count(*) as n from media_files where number = ? and season is not null and episode is not null",
      [key],
    )?.n ?? 0
  );
}

function parseSources(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
