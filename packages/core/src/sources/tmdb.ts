import { AppError, EXIT } from "../exit";
import type { RawFields } from "../domain/types";
import type { HttpClient } from "../net/http";

/**
 * TMDB (The Movie Database) —— 影视域的唯一来源。
 *
 * 与 av 域的来源不同: 它不是"输番号取字段", 而是"输 TMDB id 取字段 + 整季集列表"。
 * 身份 (`tmdb:tv:1399`) 是绑定时人确认的, 不是这里猜的 —— 猜错等于整季集名全错。
 *
 * 三条硬规矩 (ADR 0008):
 *  1. 一律 `language=zh-CN`; 中文缺失回落 `en-US` 再取一次, **不机翻**。
 *  2. 限速: TMDB 免费额度约 50 req/s, 我们按 per-host 漏桶串行, 远低于上限。
 *  3. key 不进日志: 只出现在 URL 里, 出错信息只留 URL 的路径部分。
 */
export const TMDB_BASE = "https://api.themoviedb.org/3";

export interface TmdbEnv {
  apiKey?: string;
}

export interface TmdbEpisode {
  season: number;
  episode: number;
  title: string | null;
  plot: string | null;
  airDate: string | null;
  runtimeMin: number | null;
}

export interface TmdbSeason {
  season: number;
  name: string | null;
  /** 来源声明的集数 —— "缺集"判据的分子。 */
  declaredEpisodes: number;
  episodes: TmdbEpisode[];
}

export interface TmdbShow {
  id: number;
  fields: RawFields;
  /**
   * 原文名 (`original_name`)。
   *
   * 不走 `RawFields`: 那是"逐字段择优"的输入, 而原文名与译文是一对, 不该被别的来源
   * 顶掉 (av 域的 title_original 由翻译层维护, 影视的由来源直接给)。
   */
  originalTitle: string | null;
  seasons: TmdbSeason[];
}

export interface TmdbSearchHit {
  id: number;
  /** `tmdb:tv:1399` 这种, 直接就是条目的身份。 */
  key: string;
  title: string;
  /**
   * TMDB 的原文名。**别名补搜靠它**: 拿 `Beneath Hill 60` 搜回来的条目,
   * `title` 是中文「60号高地之下」, 只有 `originalTitle` 能和别名对上。
   */
  originalTitle: string | null;
  year: string | null;
  overview: string | null;
  /** 0–10, 用于排序建议; 不参与自动决策。 */
  score: number;
}

/** TMDB 的原始结构只取用到的字段, 避免把整份响应带进类型里。 */
interface TmdbTvResponse {
  id?: number;
  name?: string;
  original_name?: string;
  overview?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  episode_run_time?: number[];
  genres?: { name?: string }[];
  networks?: { name?: string }[];
  seasons?: { season_number?: number; name?: string; episode_count?: number }[];
  credits?: { cast?: { name?: string }[] };
}

interface TmdbMovieResponse {
  id?: number;
  title?: string;
  original_title?: string;
  overview?: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  runtime?: number;
  genres?: { name?: string }[];
  production_companies?: { name?: string }[];
  credits?: { cast?: { name?: string }[] };
}

interface TmdbSeasonResponse {
  season_number?: number;
  name?: string;
  episodes?: {
    episode_number?: number;
    name?: string;
    overview?: string;
    air_date?: string;
    runtime?: number;
  }[];
}

interface TmdbSearchResponse {
  results?: {
    id?: number;
    name?: string;
    title?: string;
    original_name?: string;
    original_title?: string;
    first_air_date?: string;
    release_date?: string;
    overview?: string;
    vote_average?: number;
  }[];
}

/** 剧级字段映射。纯函数, 便于用一份录制的真实响应做穷举测试。 */
/**
 * TMDB 的图片地址是**拼出来的**: 元数据里只有 `poster_path`(`/abc.jpg`), 域名与尺寸在
 * `https://image.tmdb.org/t/p/<size><path>`。这个 CDN 不需要 key, 也不占 API 额度。
 *
 * 之前漏了这一步, 于是影视条目入库后没有 `poster_urls` —— 点"下载图片"直接报
 * 「该条目没有图片 URL」(av 域的 javdb/dmm 是直接给整条 URL 的, 照那边抄就漏了)。
 */
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

/** 给一个 `poster_path` 出多个尺寸的候选地址, 由下载器逐个试。 */
export function imageUrls(path: string | null | undefined, sizes: string[]): string[] | undefined {
  const clean = path?.trim();
  if (!clean) return undefined;
  const suffix = clean.startsWith("/") ? clean : `/${clean}`;
  return sizes.map((size) => `${TMDB_IMAGE_BASE}/${size}${suffix}`);
}

const POSTER_SIZES = ["w500", "original"];
const BACKDROP_SIZES = ["w780", "original"];

export function toShowFields(payload: TmdbTvResponse): RawFields {
  const fields: RawFields = {};
  if (payload.name) fields.title = payload.name;
  if (payload.overview) fields.plot = payload.overview;
  if (payload.first_air_date) fields.release_date = payload.first_air_date;
  const network = payload.networks?.find((item) => item.name)?.name;
  if (network) fields.studio = network;
  const genres = (payload.genres ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  if (genres.length > 0) fields.tags = genres;
  const runtime = payload.episode_run_time?.find((value) => value > 0);
  if (runtime) fields.duration_min = runtime;
  const cast = (payload.credits?.cast ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  // 剧级 cast 已经按 TMDB 的排序归一 —— 前几位就是主演, 集级客串不进索引 (ADR 0008 决策 8)
  if (cast.length > 0) fields.actors = cast;
  const posters = imageUrls(payload.poster_path, POSTER_SIZES);
  if (posters) fields.poster_urls = posters;
  // 剧照(横版)当 thumb —— 媒体服务器把它当 fanart/背景图
  const backdrops = imageUrls(payload.backdrop_path, BACKDROP_SIZES);
  if (backdrops) fields.thumb_urls = backdrops;
  return fields;
}

export function toMovieFields(payload: TmdbMovieResponse): RawFields {
  const fields: RawFields = {};
  if (payload.title) fields.title = payload.title;
  if (payload.overview) fields.plot = payload.overview;
  if (payload.release_date) fields.release_date = payload.release_date;
  const company = payload.production_companies?.find((item) => item.name)?.name;
  if (company) fields.studio = company;
  const genres = (payload.genres ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  if (genres.length > 0) fields.tags = genres;
  if (payload.runtime && payload.runtime > 0) fields.duration_min = payload.runtime;
  const cast = (payload.credits?.cast ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  if (cast.length > 0) fields.actors = cast;
  const posters = imageUrls(payload.poster_path, POSTER_SIZES);
  if (posters) fields.poster_urls = posters;
  const backdrops = imageUrls(payload.backdrop_path, BACKDROP_SIZES);
  if (backdrops) fields.thumb_urls = backdrops;
  return fields;
}

export function toSeason(payload: TmdbSeasonResponse, fallbackSeason: number): TmdbSeason {
  const season = payload.season_number ?? fallbackSeason;
  const episodes: TmdbEpisode[] = [];
  for (const raw of payload.episodes ?? []) {
    const episode = raw.episode_number;
    if (!episode || episode <= 0) continue;
    episodes.push({
      season,
      episode,
      title: raw.name ?? null,
      plot: raw.overview ?? null,
      airDate: raw.air_date ?? null,
      runtimeMin: raw.runtime && raw.runtime > 0 ? raw.runtime : null,
    });
  }
  return {
    season,
    name: payload.name ?? null,
    // 声明集数取"响应里真正给出集数"与 episode_count 的较大者, 但没有 episode_count 时就用实际条数
    declaredEpisodes: episodes.length,
    episodes: episodes.sort((a, b) => a.episode - b.episode),
  };
}

/** 搜索候选: 只给"你可能要的是哪一部", 选哪一部由人决定 (ADR 0008 决策 4)。 */
export function toSearchHits(payload: TmdbSearchResponse, kind: "tv" | "movie"): TmdbSearchHit[] {
  const hits: TmdbSearchHit[] = [];
  for (const raw of payload.results ?? []) {
    const id = raw.id;
    const title = kind === "tv" ? raw.name : raw.title;
    if (!id || !title) continue;
    const date = kind === "tv" ? raw.first_air_date : raw.release_date;
    hits.push({
      id,
      key: `tmdb:${kind}:${id}`,
      title,
      originalTitle: (kind === "tv" ? raw.original_name : raw.original_title)?.trim() || null,
      year: date ? date.slice(0, 4) : null,
      overview: raw.overview ?? null,
      score: typeof raw.vote_average === "number" ? raw.vote_average : 0,
    });
  }
  return hits;
}

/** 从身份键里取 TMDB id。`tmdb:tv:1399` → { kind: "tv", id: 1399 }。 */
export function parseTmdbKey(key: string): { kind: "tv" | "movie"; id: number } | null {
  const match = /^tmdb:(tv|movie):(\d+)$/i.exec(key.trim());
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { kind: match[1]!.toLowerCase() as "tv" | "movie", id };
}

export interface TmdbClientOptions {
  http: HttpClient;
  env: TmdbEnv;
}

export interface TmdbClient {
  requirements(): string[];
  /** 剧 + 各季集列表。一次拿全, 因为"缺集"要用声明集数, 而那是季级信息。 */
  show(id: number, options?: { seasons?: number[]; signal?: AbortSignal }): Promise<TmdbShow | null>;
  movie(
    id: number,
    options?: { signal?: AbortSignal },
  ): Promise<{ id: number; fields: RawFields; originalTitle: string | null } | null>;
  season(id: number, season: number, options?: { signal?: AbortSignal }): Promise<TmdbSeason | null>;
  search(
    kind: "tv" | "movie",
    query: string,
    options?: { year?: string; signal?: AbortSignal },
  ): Promise<TmdbSearchHit[]>;
}

export function createTmdbClient(options: TmdbClientOptions): TmdbClient {
  const { http, env } = options;

  function requireKey(): string {
    const key = env.apiKey?.trim();
    if (!key) {
      throw new AppError("未配置 TMDB API key", EXIT.NEEDS_INPUT, {
        hint: "到 https://www.themoviedb.org/settings/api 申请 (个人用途免费), 然后 kura config set --tmdb-api-key <key>",
        env: "KURA_TMDB_API_KEY",
      });
    }
    return key;
  }

  /**
   * 一次请求: 先 zh-CN, 中文里缺的字段用 en-US 补。
   *
   * 补的方式是**逐字段**的: 中文条目常常有剧名但没有简介, 整份回落会把已有中文覆盖成英文。
   */
  async function getJson<T>(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const key = requireKey();
    const url = new URL(`${TMDB_BASE}${path}`);
    url.searchParams.set("api_key", key);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);

    try {
      return await http.getJson<T>(url.toString(), { signal });
    } catch (raw) {
      // key 在 query 里, 而 HttpClient 会把 url 放进错误详情 —— 直接往外抛等于把 key
      // 写进日志与 JSON 输出。所有出口都必须过一遍脱敏。
      const err = redactKey(raw);
      // 401/404 是"配置或 id 不对", 不该被当成网络抖动重试
      const status = statusOf(err);
      if (status === 401) {
        throw new AppError("TMDB 拒绝了这个 API key", EXIT.NEEDS_INPUT, {
          hint: "检查 key 是否复制完整; 到 https://www.themoviedb.org/settings/api 重新取一次",
        });
      }
      if (status === 404) throw new AppError(`TMDB 没有这个 id: ${path}`, EXIT.NOT_FOUND, { path });
      throw err;
    }
  }

  /** 中文优先、英文兜底的合并: 只补空字段, 不覆盖已有的中文。 */
  async function getJsonMerged<T extends object>(
    path: string,
    query: Record<string, string>,
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<T> {
    const zh = await getJson<T>(path, { ...query, language: "zh-CN" }, signal);
    const read = (source: object, field: string): unknown => (source as Record<string, unknown>)[field];
    const missing = fields.filter((field) => isEmpty(read(zh, field)));
    if (missing.length === 0) return zh;
    const en = await getJson<T>(path, { ...query, language: "en-US" }, signal).catch(() => null);
    if (!en) return zh;
    const merged: Record<string, unknown> = { ...(zh as Record<string, unknown>) };
    for (const field of missing) {
      const value = read(en, field);
      if (!isEmpty(value)) merged[field] = value;
    }
    return merged as T;
  }

  return {
    requirements: () => (env.apiKey?.trim() ? [] : ["KURA_TMDB_API_KEY"]),

    async season(id, season, opts = {}) {
      // 季不走英文回落: 我们只用集级的 name/overview, 而逐集回落等于把请求数翻倍。
      // 集简介缺中文就留着空 —— 那是可以接受的缺失, 不值得双倍请求。
      const payload = await getJson<TmdbSeasonResponse>(`/tv/${id}/season/${season}`, { language: "zh-CN" }, opts.signal);
      return toSeason(payload, season);
    },

    async show(id, opts = {}) {
      const payload = await getJsonMerged<TmdbTvResponse>(
        `/tv/${id}`,
        { append_to_response: "credits" },
        LOCALIZED_TV,
        opts.signal,
      );
      if (!payload.id) return null;
      const seasons: TmdbSeason[] = [];
      const wanted = opts.seasons ?? (payload.seasons ?? []).map((item) => item.season_number ?? 0).filter((n) => n > 0);
      for (const seasonNumber of wanted) {
        const season = await this.season(id, seasonNumber, opts);
        if (season) seasons.push(season);
      }
      return {
        id: payload.id,
        fields: toShowFields(payload),
        originalTitle: payload.original_name?.trim() || null,
        seasons,
      };
    },

    async movie(id, opts = {}) {
      const payload = await getJsonMerged<TmdbMovieResponse>(
        `/movie/${id}`,
        { append_to_response: "credits" },
        LOCALIZED_MOVIE,
        opts.signal,
      );
      if (!payload.id) return null;
      return { id: payload.id, fields: toMovieFields(payload), originalTitle: payload.original_title?.trim() || null };
    },

    async search(kind, query, opts = {}) {
      const params: Record<string, string> = { query };
      if (opts.year) params[kind === "tv" ? "first_air_date_year" : "year"] = opts.year;
      const payload = await getJsonMerged<TmdbSearchResponse>(
        `/search/${kind}`,
        params,
        kind === "tv" ? LOCALIZED_TV : LOCALIZED_MOVIE,
        opts.signal,
      );
      return toSearchHits(payload, kind);
    },
  };
}

/**
 * 中文缺失时需要英文兜底的字段 —— 按端点分开: 剧用 `name`, 电影用 `title`。
 * 混在一起的后果是"剧永远缺 title", 每次请求都白跑一次英文回落。
 */
const LOCALIZED_TV = ["name", "overview"] as const;
const LOCALIZED_MOVIE = ["title", "overview"] as const;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * 把 AppError 里 URL 的 `api_key` 换成 `***`。
 *
 * 不是为了好看: `kura source test tmdb --json` 会把 error.details 原样打到 stdout,
 * 而 agent 和人都会把它贴进 issue —— key 就这么泄了。
 */
export function redactKey(err: unknown): unknown {
  if (!(err instanceof AppError) || !err.details) return err;
  const details: Record<string, unknown> = { ...err.details };
  if (typeof details.url === "string") details.url = redactUrl(details.url);
  return new AppError(err.message, err.exitCode, details);
}

export function redactUrl(url: string): string {
  return url.replace(/([?&]api_key=)[^&]*/i, "$1***");
}

/** HttpClient 把状态码放在 AppError.details.status 里, 这里只读不改。 */
function statusOf(err: unknown): number | null {
  if (!(err instanceof AppError)) return null;
  const status = err.details?.status;
  return typeof status === "number" ? status : null;
}
