import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { load } from "cheerio";
import type { Metadata } from "./types";

/**
 * 读回我们自己写的 (或 Kodi/Emby 写的) movie nfo。
 *
 * 存在的理由: 一个移动硬盘插到新电脑上, 库是空的, 但每部片旁边都有 `.nfo` +
 * 海报。重扫一遍就能把元数据捞回来, 不用再联网刮一次。
 *
 * 只读**同名** `.nfo` (片名.nfo), 与写出去的位置一一对应 —— 目录里别的 nfo 不是这部片的。
 */
export interface NfoFields {
  title?: string;
  titleOriginal?: string;
  plot?: string;
  releaseDate?: string;
  durationMin?: number;
  studio?: string;
  label?: string;
  series?: string;
  actors: string[];
  directors: string[];
  tags: string[];
}

export function nfoPathFor(videoPath: string): string {
  // 去掉扩展名后直接接 .nfo —— 不能用 join(), 那会把 ".nfo" 当成目录里的一项。
  return `${videoPath.slice(0, videoPath.length - extname(videoPath).length)}.nfo`;
}

function text($: ReturnType<typeof load>, selector: string): string | undefined {
  const value = $(selector).first().text().trim();
  return value ? value : undefined;
}

function texts($: ReturnType<typeof load>, selector: string): string[] {
  const values: string[] = [];
  $(selector).each((_index, element) => {
    const value = $(element).text().trim();
    if (value) values.push(value);
  });
  return values;
}

export function parseNfo(xml: string): NfoFields | null {
  let $: ReturnType<typeof load>;
  try {
    $ = load(xml, { xmlMode: true });
  } catch {
    return null;
  }
  const root = $("movie").length > 0 ? $("movie").first() : $("episodedetails").first();
  if (root.length === 0) return null;

  const runtime = text($, "movie > runtime, episodedetails > runtime");
  const fields: NfoFields = {
    title: text($, "movie > title, episodedetails > title"),
    titleOriginal: text($, "movie > originaltitle, episodedetails > originaltitle"),
    plot: text($, "movie > plot, episodedetails > plot"),
    releaseDate: text($, "movie > premiered, episodedetails > premiered") ?? text($, "movie > releasedate"),
    durationMin: runtime && Number.isFinite(Number(runtime)) ? Number(runtime) : undefined,
    studio: text($, "movie > studio, episodedetails > studio"),
    label: text($, "movie > label"),
    series: text($, "movie > set > name"),
    actors: texts($, "movie > actor > name, episodedetails > actor > name"),
    directors: texts($, "movie > director, episodedetails > director"),
    tags: texts($, "movie > tag, episodedetails > tag"),
  };

  const empty =
    !fields.title &&
    !fields.titleOriginal &&
    !fields.plot &&
    !fields.releaseDate &&
    fields.actors.length === 0 &&
    fields.directors.length === 0;
  return empty ? null : fields;
}

/** 视频旁边有没有 nfo, 有就读出来。规矩: 只有同名 nfo 算这部片的。 */
export function readNfo(videoPath: string): NfoFields | null {
  const path = nfoPathFor(videoPath);
  if (!existsSync(path)) return null;
  try {
    return parseNfo(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** nfo 里的字段 → 元数据补丁 (只填库里还空着的字段)。 */
export function nfoToMetadata(fields: NfoFields, number: string): Metadata {
  return {
    key: number,
    number,
    contentType: "censored",
    title: fields.title ?? fields.titleOriginal,
    titleOriginal: fields.titleOriginal,
    plot: fields.plot,
    release_date: fields.releaseDate,
    duration_min: fields.durationMin,
    studio: fields.studio,
    label: fields.label,
    series: fields.series,
    actors: fields.actors,
    directors: fields.directors,
    tags: fields.tags,
    fieldSources: { title: "nfo", plot: "nfo" },
  };
}

/** 只是为了导出给测试/调试用。 */
export function nfoBaseName(videoPath: string): string {
  return basename(videoPath, extname(videoPath));
}
