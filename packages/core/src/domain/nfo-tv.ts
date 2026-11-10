import { load } from "cheerio";
import { escapeXml, unescapeXml } from "./materialize";
import type { NfoUpdate } from "./nfo";

/**
 * 影视域的 NFO(Kodi / Jellyfin 约定)。
 *
 * 与 av 域的 `nfo.ts` 分开, 因为**标签词表不同**:
 *  - 剧级 `tvshow.nfo`: 根 `<tvshow>`, 题材用 `<genre>`, 演员 `<actor><name>`
 *  - 集级 `<视频名>.nfo`: 根 `<episodedetails>`, 有 `<season>` `<episode>` `<aired>`
 *  - 身份用 `<uniqueid type="tmdb">`, av 用的 `type="kura"`
 *
 * 规矩与 av 域一致: **字段级改写, 不整份重写**。用户的 nfo 多半是 Emby / tinyMediaManager
 * 生成的, 里面有 `<art>` `<mpaa>` `<rating>` `<thumb>` 这些我们不认识的元素 —— 整份覆盖
 * 等于删掉不可逆。
 */
export type TvNfoRoot = "tvshow" | "episodedetails" | "movie";

export interface TvShowNfoFields {
  title?: string | null;
  originalTitle?: string | null;
  plot?: string | null;
  premiered?: string | null;
  studio?: string | null;
  genres?: string[];
  actors?: string[];
  /** `tmdb:tv:1399` → 写 `<uniqueid type="tmdb">1399</uniqueid>`。 */
  tmdbId?: string | null;
}

/** 电影: 根 `<movie>`, 与剧不是同一份词表(没有 `<season>`, 有 `<runtime>`)。 */
export interface MovieNfoFields {
  title?: string | null;
  originalTitle?: string | null;
  plot?: string | null;
  premiered?: string | null;
  studio?: string | null;
  runtimeMin?: number | null;
  genres?: string[];
  actors?: string[];
  tmdbId?: string | null;
}

export interface EpisodeNfoFields {
  title?: string | null;
  plot?: string | null;
  aired?: string | null;
  runtimeMin?: number | null;
  season: number;
  episode: number;
  tmdbId?: string | null;
}

/** 从零生成一份剧级 nfo。只在旁边没有 nfo 时用。 */
export function renderTvShowNfo(fields: TvShowNfoFields): string {
  const lines: string[] = ["<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\" ?>", "<tvshow>"];
  push(lines, "title", fields.title);
  push(lines, "originaltitle", fields.originalTitle);
  push(lines, "plot", fields.plot);
  push(lines, "premiered", fields.premiered);
  push(lines, "studio", fields.studio);
  for (const genre of dedupe(fields.genres ?? [])) push(lines, "genre", genre);
  pushUniqueId(lines, fields.tmdbId);
  for (const actor of dedupe(fields.actors ?? [])) lines.push("  <actor>", `    <name>${escapeXml(actor)}</name>`, "  </actor>");
  lines.push("</tvshow>");
  return `${lines.join("\n")}\n`;
}

/** 从零生成一份电影 nfo。 */
export function renderMovieNfo(fields: MovieNfoFields): string {
  const lines: string[] = ["<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\" ?>", "<movie>"];
  push(lines, "title", fields.title);
  push(lines, "originaltitle", fields.originalTitle);
  push(lines, "plot", fields.plot);
  push(lines, "premiered", fields.premiered);
  push(lines, "studio", fields.studio);
  if (fields.runtimeMin && fields.runtimeMin > 0) push(lines, "runtime", String(fields.runtimeMin));
  for (const genre of dedupe(fields.genres ?? [])) push(lines, "genre", genre);
  pushUniqueId(lines, fields.tmdbId);
  for (const actor of dedupe(fields.actors ?? [])) lines.push("  <actor>", `    <name>${escapeXml(actor)}</name>`, "  </actor>");
  lines.push("</movie>");
  return `${lines.join("\n")}\n`;
}

/** 从零生成一份集级 nfo。 */
export function renderEpisodeNfo(fields: EpisodeNfoFields): string {
  const lines: string[] = ["<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\" ?>", "<episodedetails>"];
  push(lines, "title", fields.title);
  push(lines, "season", String(fields.season));
  push(lines, "episode", String(fields.episode));
  push(lines, "plot", fields.plot);
  push(lines, "aired", fields.aired);
  if (fields.runtimeMin && fields.runtimeMin > 0) push(lines, "runtime", String(fields.runtimeMin));
  pushUniqueId(lines, fields.tmdbId);
  lines.push("</episodedetails>");
  return `${lines.join("\n")}\n`;
}

/**
 * 在已有 nfo 上做字段级合并。
 *
 * 根元素不对(比如用户在剧目录里放了一份 `<movie>`)时返回 `changed: []` —— 不写,
 * 由调用方报"跳过": 猜错了根元素会写出一份 Emby 读不懂的文件。
 */
export function mergeTvNfo(original: string, expected: TvNfoRoot, fields: TvShowNfoFields | EpisodeNfoFields): NfoUpdate {
  // decodeEntities: false —— 否则中文会被写成 &#x767d; 这种实体
  const $ = load(original, { xmlMode: true, decodeEntities: false } as Parameters<typeof load>[1]);
  const root = $(expected).first();
  const changed: string[] = [];
  if (root.length === 0) return { content: original, changed };

  /** 文件里的文本 → 原始值(文件里是转义过的, 库里是原始值)。 */
  const plain = (text: string): string => unescapeXml(text).trim();

  const setSingle = (tag: string, value: string | null | undefined, label: string): void => {
    if (value === null || value === undefined || value === "") return;
    const nodes = root.children(tag);
    if (nodes.length === 0) {
      root.append($(`<${tag}/>`).text(escapeXml(value)));
      changed.push(`${label} 新增 ${value}`);
      return;
    }
    const current = plain(nodes.first().text());
    if (current === value.trim()) {
      if (nodes.length === 1) return;
      nodes.slice(1).remove();
      changed.push(`${label} 去掉重复 ${nodes.length - 1} 个`);
      return;
    }
    nodes.first().text(escapeXml(value));
    nodes.slice(1).remove();
    changed.push(`${label} ${current || "(空)"} → ${value}`);
  };

  const unionAppend = (tag: string, values: string[] | undefined, label: string): void => {
    const items = dedupe((values ?? []).map((value) => value.trim()).filter(Boolean));
    if (items.length === 0) return;
    const nodes = root.children(tag);
    const existing = nodes
      .map((_index, element) => plain($(element).text()))
      .get();

    // 旧版比较形态不一致时已经堆重复, 顺手删掉
    const seen = new Set<string>();
    let duplicates = 0;
    nodes.each((_index, element) => {
      const value = plain($(element).text());
      if (seen.has(value)) {
        $(element).remove();
        duplicates++;
        return;
      }
      seen.add(value);
    });

    const missing = items.filter((item) => !seen.has(item));
    for (const item of missing) root.append($(`<${tag}/>`).text(escapeXml(item)));
    if (missing.length > 0) changed.push(`${label} 新增 ${missing.length} 个`);
    if (duplicates > 0) changed.push(`${label} 去掉重复 ${duplicates} 个`);
  };

  mergeUniqueId($, root, changed, "tmdbId" in fields ? fields.tmdbId : null);

  if (expected === "tvshow") {
    const show = fields as TvShowNfoFields;
    setSingle("title", show.title, "标题");
    setSingle("originaltitle", show.originalTitle, "原名");
    setSingle("plot", show.plot, "简介");
    setSingle("premiered", show.premiered, "首播日");
    setSingle("studio", show.studio, "电视台");
    unionAppend("genre", show.genres, "题材");
    mergeActors($, root, changed, show.actors ?? []);
  } else {
    const episode = fields as EpisodeNfoFields;
    setSingle("title", episode.title, "集名");
    setSingle("season", String(episode.season), "季");
    setSingle("episode", String(episode.episode), "集");
    setSingle("plot", episode.plot, "简介");
    setSingle("aired", episode.aired, "播出日");
    setSingle("runtime", episode.runtimeMin ? String(episode.runtimeMin) : null, "时长");
  }

  // 没差异就原样返回: 调用方据此跳过写盘, 免得只是格式化就把 mtime 抖一遍
  if (changed.length === 0) return { content: original, changed: [] };
  return { content: `${$.xml().trimEnd()}\n`, changed };
}

type Cheerio = ReturnType<typeof load>;
type Node = ReturnType<Cheerio>;

/** `<uniqueid type="tmdb">` 就地改值;没有就追加。 */
function mergeUniqueId($: Cheerio, root: Node, changed: string[], tmdbId: string | null | undefined): void {
  if (!tmdbId) return;
  const ids = root.children("uniqueid").filter((_index, element) => ($(element).attr("type") ?? "").toLowerCase() === "tmdb");
  if (ids.length === 0) {
    root.append($('<uniqueid type="tmdb"/>').text(escapeXml(tmdbId)));
    changed.push(`TMDB id 新增 ${tmdbId}`);
    return;
  }
  if (ids.first().text().trim() === tmdbId) return;
  ids.first().text(escapeXml(tmdbId));
  changed.push(`TMDB id → ${tmdbId}`);
}

/** 演员按序号就地改名, 保住 `<role>` `<thumb>` 这些 Kura 不认识的子元素。 */
function mergeActors($: Cheerio, root: Node, changed: string[], actors: string[]): void {
  const names = dedupe(actors.map((name) => name.trim()).filter(Boolean));
  if (names.length === 0) return;
  const blocks = root.children("actor");
  blocks.each((index, element) => {
    if (index >= names.length) return;
    const block = $(element);
    const name = block.children("name");
    const current = name.length > 0 ? unescapeXml(name.first().text()).trim() : "";
    if (current === names[index]) return;
    if (name.length > 0) name.first().text(escapeXml(names[index]!));
    else block.prepend($("<name/>").text(escapeXml(names[index]!)));
    changed.push(`演员 ${current || "(无)"} → ${names[index]}`);
  });
  for (let index = blocks.length; index < names.length; index++) {
    root.append($("<actor/>").append($("<name/>").text(escapeXml(names[index]!))));
    changed.push(`演员 新增 ${names[index]}`);
  }
}

function push(lines: string[], tag: string, value: string | null | undefined): void {
  if (value === null || value === undefined || value === "") return;
  lines.push(`  <${tag}>${escapeXml(value)}</${tag}>`);
}

function pushUniqueId(lines: string[], tmdbId: string | null | undefined): void {
  if (!tmdbId) return;
  const id = escapeXml(tmdbId);
  // 两种写法都给: Emby / Jellyfin 认 `uniqueid`(要 default="true" 才当主 id),
  // Kodi 老版本只认 `<tmdbid>`。少写一个, 对方的刮削器就会自作主张按文件名重搜。
  lines.push(`  <tmdbid>${id}</tmdbid>`);
  lines.push(`  <uniqueid type="tmdb" default="true">${id}</uniqueid>`);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
