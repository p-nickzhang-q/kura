import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { load } from "cheerio";
import { escapeXml, unescapeXml } from "./materialize";
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
/**
 * NFO 只是一颗**种子**: 每个真填了的字段都记 `nfo` 来源, 网络来源可以随时盖掉它
 * (见 aggregate.ts 的 mergeWithPinned)。只记 title/plot 的话, 界面上分不清
 * "这条的演员是刮来的" 和 "这条的演员来自旧库的 nfo", 重刮时也判不出该不该兜底。
 */
export function nfoToMetadata(fields: NfoFields, number: string): Metadata {
  const metadata: Metadata = {
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
    fieldSources: {},
  };
  for (const key of ["title", "plot", "release_date", "duration_min", "studio", "label", "series", "actors", "directors", "tags"] as const) {
    const value = metadata[key];
    const filled = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
    if (filled) metadata.fieldSources[key] = "nfo";
  }
  return metadata;
}

/** 只是为了导出给测试/调试用。 */
export function nfoBaseName(videoPath: string): string {
  return basename(videoPath, extname(videoPath));
}

/**
 * 就地更新一份已有 nfo 里 **Kura 认识的那些字段**, 其余原样保留。
 *
 * 为什么不整份重写(`buildNfo`): 用户的 nfo 多半是别的工具生成的, 里面有 Kura 完全不
 * 认识的标签 —— `<outline>` `<originalplot>` `<sorttitle>` `<mpaa>` `<maker>`
 * `<publisher>` `<poster>` `<cover>` `<website>` `<javdbsearchid>`、actor 里的 `<type>`…
 * 整份重写会把这些统统删掉, 而 Emby 读的正是这些文件。所以这里的规矩是:
 *
 *  - 单值字段: Kura 有值才替换, Kura 没值就留着原样(别把对得上的抹掉);
 *  - 演员: 按顺序就地改 `<name>`, 保留同一个 `<actor>` 里的其它子元素;
 *  - 标签/导演: 取并集 —— 只追加 Kura 有、文件里没有的, 不删文件里多出来的;
 *  - 其它标签: 一个字都不碰。
 */
export interface NfoUpdate {
  content: string;
  /** 人话的差异清单, 例如 `演员 吉根柚莉爱 → 吉根ゆりあ`; 空数组表示内容没变。 */
  changed: string[];
}

function asText(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

export function updateNfoContent(original: string, metadata: Metadata): NfoUpdate {
  // decodeEntities: false —— 否则中文会被写成 &#x767d; 这种实体, 文件给人打开就没法看了。
  // 代价是写入时要自己转义(`escapeXml`), 读取比较也按转义后的形态比, 否则每次都判"变了"。
  const $ = load(original, { xmlMode: true, decodeEntities: false } as Parameters<typeof load>[1]);
  const root = $("movie").length > 0 ? $("movie").first() : $("episodedetails").first();
  const changed: string[] = [];
  if (root.length === 0) return { content: original, changed };

  const own = (tag: string) => root.children(tag);

  /**
   * 文件里的文本 → 原始值。
   *
   * 文件里是转义过的(`&amp;` `&apos;`), 库里是原始值。以前一处用 `escapeXml(value)` 兜、
   * 别处直接比, 于是带 `&` 或 `'` 的值永远"不一致": 标签每同步一次多一份(实测堆到 3 份),
   * 演员名带撇号的条目永远显示"待回写"。
   */
  const plain = (text: string): string => unescapeXml(text).trim();

  const setSingle = (tag: string, value: string | undefined, label: string): void => {
    if (!value) return;
    const nodes = own(tag);
    if (nodes.length === 0) {
      root.append($(`<${tag}/>`).text(escapeXml(value)));
      changed.push(`${label} 新增 ${value}`);
      return;
    }
    const current = plain(nodes.first().text());
    if (current === value.trim()) {
      if (nodes.length === 1) return;
    }
    nodes.first().text(escapeXml(value));
    nodes.slice(1).remove();
    changed.push(`${label} ${current || "(空)"} → ${value}`);
  };

  const series = asText(metadata.series);
  const setBlock = (): void => {
    if (!series) return;
    const sets = own("set");
    if (sets.length === 0) {
      const block = $("<set/>");
      block.append($("<name/>").text(escapeXml(series)));
      root.append(block);
      changed.push(`系列 (新增) ${series}`);
      return;
    }
    const name = sets.first().children("name");
    const current = name.length > 0 ? plain(name.first().text()) : "";
    if (current === series && sets.length === 1) return;
    if (name.length > 0) name.first().text(escapeXml(series));
    else sets.first().append($("<name/>").text(escapeXml(series)));
    sets.slice(1).remove();
    changed.push(`系列 ${current || "(无)"} → ${series}`);
  };

  /** 演员按序号就地改名: 保住 `<type>` `<role>` `<thumb>` 这些 Kura 不认识的子元素。 */
  const setActors = (): void => {
    const actors = (metadata.actors ?? []).map((name) => name.trim()).filter(Boolean);
    if (actors.length === 0) return;
    const blocks = own("actor");
    const diffs: string[] = [];
    blocks.each((index, element) => {
      if (index >= actors.length) return;
      const block = $(element);
      const name = block.children("name");
      const current = name.length > 0 ? plain(name.first().text()) : "";
      if (current !== actors[index]) diffs.push(`${current || "(无)"} → ${actors[index]!}`);
      if (name.length > 0) name.first().text(escapeXml(actors[index]!));
      else block.prepend($("<name/>").text(escapeXml(actors[index]!)));
    });
    if (blocks.length > actors.length) {
      blocks.slice(actors.length).remove();
      diffs.push(`删除多余演员 ${blocks.length - actors.length} 个`);
    }
    for (let index = blocks.length; index < actors.length; index++) {
      const block = $("<actor/>");
      block.append($("<name/>").text(escapeXml(actors[index]!)));
      root.append(block);
      diffs.push(`(新增) ${actors[index]!}`);
    }
    if (diffs.length > 0) changed.push(`演员 ${diffs.join("; ")}`);
  };

  /** 标签/导演取并集: 文件里多出来的(AVC1、480P、中文字幕…)是别的工具的产物, 不删。 */
  const unionAppend = (tag: string, values: string[] | undefined, label: string): void => {
    const items = (values ?? []).map((value) => value.trim()).filter(Boolean);
    if (items.length === 0) return;
    const nodes = own(tag);
    const existing = nodes
      .map((_index, element) => plain($(element).text()))
      .get();

    // 历史遗留: 旧版比较错形态, 同一个标签可能已经被追加过好几遍。顺手去重, 不留垃圾。
    const seen = new Set<string>();
    let duplicates = 0;
    nodes.each((index, element) => {
      const value = plain($(element).text());
      if (seen.has(value)) {
        $(element).remove();
        duplicates++;
        return;
      }
      seen.add(value);
      void index;
    });

    const missing = items.filter((item) => !seen.has(item));
    for (const item of missing) root.append($(`<${tag}/>`).text(escapeXml(item)));
    if (missing.length > 0) changed.push(`${label} 新增 ${missing.length} 个`);
    if (duplicates > 0) changed.push(`${label} 去掉重复 ${duplicates} 个`);
  };

  const title = asText(metadata.title);
  const originalTitle = asText(metadata.titleOriginal) ?? asText(metadata.number) ?? asText(metadata.key);
  setSingle("title", title, "标题");
  setSingle("originaltitle", originalTitle, "原名");
  setSingle("plot", asText(metadata.plot), "简介");
  setSingle("premiered", asText(metadata.release_date), "发行日期");
  setSingle("runtime", asText(metadata.duration_min), "时长");
  setSingle("num", asText(metadata.number), "番号");
  setSingle("studio", asText(metadata.studio), "片商");
  setSingle("label", asText(metadata.label), "厂牌");
  setSingle("series", series, "系列字段");
  setBlock();
  setActors();
  unionAppend("tag", metadata.tags, "标签");
  unionAppend("director", metadata.directors, "导演");

  // 自己的 id: Emby 不读, 但重扫时能认出这行是我们写的。
  const ids = own("uniqueid").filter((_index, element) => ($(element).attr("type") ?? "").toLowerCase() === "kura");
  if (ids.length === 0) {
    const node = $('<uniqueid type="kura" default="true"/>');
    root.append(node.text(escapeXml(metadata.key)));
  } else if (ids.first().text().trim() !== metadata.key) {
    ids.first().text(escapeXml(metadata.key));
  }

  // 没差异就原样返回: 调用方据此跳过写盘, 免得只是格式化就把文件的 mtime 抖一遍。
  if (changed.length === 0) return { content: original, changed: [] };

  const content = `${$.xml().trimEnd()}\n`;
  return { content, changed };
}
