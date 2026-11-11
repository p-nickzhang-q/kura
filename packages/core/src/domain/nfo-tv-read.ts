import { load } from "cheerio";

/**
 * 读回影视域的 nfo（我们写出去的那套 Kodi/Jellyfin 约定）。
 *
 * 为什么 av 域能读回、影视域当初不能（ADR 0008 §6）: 影视的 nfo 是 Emby/Jellyfin **也会写**
 * 的，回读等于把播放器的内部状态当元数据吸进库里。那个顾虑针对的是 `<playcount>`
 * `<watched>` `<resume>` `<lastplayed>` `<userrating>` 这些**播放状态**。
 *
 * 这里只解析两样东西，别的一概不看:
 *  1. **身份**: `<uniqueid type="tmdb">` / `<tmdbid>` —— 有了它就能建条目, 不用联网
 *  2. **内容字段**: 标题 / 原名 / 简介 / 首播日 / 电视台·片商 / 时长 / 题材 / 演员 / 季集
 *
 * 用户把刮削好的盘接到另一台电脑, 靠这两样就能把库恢复成原样(见 tasks/nfo-recover.ts)。
 */
export type TvNfoRootKind = "tvshow" | "episodedetails" | "movie";

export interface ParsedTvNfo {
  root: TvNfoRootKind | null;
  /** 纯数字的 TMDB id; 没有就是 null(那是"旁边的 nfo 不是 Kura/Emby 生成的"这种情况)。 */
  tmdbId: string | null;
  /** 本地条目(UGC)的身份, 形如 `local:食贫道充电视频`; 不是本地条目时为 null。 */
  kuraId: string | null;
  title?: string;
  originalTitle?: string;
  plot?: string;
  /** tvshow 的 `<premiered>` / movie 的 `<premiered>` */
  premiered?: string;
  studio?: string;
  runtimeMin?: number;
  genres: string[];
  actors: string[];
  /** 只有 episodedetails 有。 */
  season?: number;
  episode?: number;
}

const ROOTS: TvNfoRootKind[] = ["tvshow", "episodedetails", "movie"];

export function parseTvNfo(xml: string): ParsedTvNfo | null {
  let $: ReturnType<typeof load>;
  try {
    $ = load(xml, { xmlMode: true });
  } catch {
    return null;
  }

  const root = ROOTS.find((name) => $(name).length > 0) ?? null;
  if (!root) return null;
  const node = $(root).first();

  const first = (selector: string): string | undefined => {
    const value = node.find(selector).first().text().trim();
    return value ? value : undefined;
  };
  const all = (selector: string): string[] => {
    const values: string[] = [];
    node.find(selector).each((_index, element) => {
      const value = $(element).text().trim();
      if (value) values.push(value);
    });
    return values;
  };
  const int = (selector: string): number | undefined => {
    const raw = first(selector);
    if (!raw) return undefined;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : undefined;
  };

  // 身份: `<uniqueid type="tmdb">` 是 Kodi 约定, `<tmdbid>` 是 Emby/tMM 的写法, 两个都认。
  let tmdbId: string | null = null;
  node.find("uniqueid").each((_index, element) => {
    if (tmdbId) return;
    const type = ($(element).attr("type") ?? "").toLowerCase();
    const value = $(element).text().trim();
    if (type === "tmdb" && /^\d+$/.test(value)) tmdbId = value;
  });
  if (!tmdbId) {
    const legacy = node.find("tmdbid").first().text().trim();
    if (/^\d+$/.test(legacy)) tmdbId = legacy;
  }

  // 本地条目(UGC)没有 TMDB id —— 身份在 `<uniqueid type="kura">local:xxx</uniqueid>` 里。
  // 只认 `local:` 前缀: av 域的 `type="kura"` 存的是番号, 走的是另一套恢复路径。
  let kuraId: string | null = null;
  node.find("uniqueid").each((_index, element) => {
    if (kuraId) return;
    const type = ($(element).attr("type") ?? "").toLowerCase();
    const value = $(element).text().trim();
    if (type === "kura" && value.toLowerCase().startsWith("local:")) kuraId = value;
  });

  const parsed: ParsedTvNfo = {
    root,
    tmdbId,
    kuraId,
    title: first("title"),
    originalTitle: first("originaltitle"),
    plot: first("plot"),
    premiered: first("premiered") ?? first("aired") ?? first("releasedate"),
    studio: first("studio"),
    runtimeMin: int("runtime"),
    genres: [...all("genre"), ...all("tag")],
    actors: all("actor > name"),
  };

  if (root === "episodedetails") {
    const season = int("season");
    const episode = int("episode");
    if (season !== undefined) parsed.season = season;
    if (episode !== undefined) parsed.episode = episode;
  }

  return parsed;
}
