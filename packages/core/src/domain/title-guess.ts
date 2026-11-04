/**
 * 从目录名猜片名与年份。**只用于生成搜索建议**, 不用于决定绑定。
 *
 * 影视目录名长这样:`进击的巨人 (2013)`、`[Lilith-Raws] 无职转生 S01 1080p`、
 * `Chernobyl.2019.1080p.BluRay`。直接拿去搜 TMDB 命中率不高(年份括号、发布组、
 * 分辨率都是噪声), 剥干净再搜能把"搜不到"变成"搜得到"。
 *
 * 猜错的代价只是"建议不准", 因为建议永远要人确认 (ADR 0008 决策 4)。
 */

export interface TitleGuess {
  /** 剥掉年份/季/发布标记后的片名。可能为空(这时不该发搜索)。 */
  title: string;
  /** 目录名里出现的年份, 用来缩小搜索范围。 */
  year: string | null;
}

/** 常见的发布/画质标记, 不是片名的一部分。 */
const NOISE = [
  /^(?:1080p|2160p|720p|480p|4k|uhd)$/i,
  /^(?:web[-_.]?dl|webrip|bluray|blu[-_.]?ray|bdrip|dvdrip|hdtv|remux)$/i,
  /^(?:x264|x265|h\.?264|h\.?265|hevc|avc|10bit|8bit)$/i,
  /^(?:aac|ac3|ddp?5\.?1|dd5\.?1|flac|truehd|atmos|dts)$/i,
  /^(?:hdr|hdr10|dovi|sdr)$/i,
  /^(?:中字|简中|繁中|简繁|国语|日语|双语|内嵌|外挂|字幕)$/,
  /^(?:complete|repack|proper|remastered|extended|uncut)$/i,
  /^(?:第\s*\d+\s*[季集话期]|season\s*\d+|s\d{1,2}|s\d{1,2}e\d{1,4})$/i,
];

const SEASON_PATTERNS = [
  /\bseason[\s._-]*\d{1,2}\b/gi,
  /\bs\d{1,2}\b/gi,
  /第\s*\d{1,2}\s*季/g,
  /第\s*[一二三四五六七八九十]+\s*季/g,
];

const EDITION_PATTERNS = [
  /\b(?:director'?s|theatrical|extended|unrated)\s+cut\b/gi,
  /\b\d{3,4}p\b/gi,
  /\b(?:web[-_.]?dl|webrip|bluray|blu[-_.]?ray|bdrip|dvdrip|hdtv|remux)\b/gi,
  /\b(?:x264|x265|h\.?264|h\.?265|hevc|avc|10bit|8bit)\b/gi,
  /\b(?:aac|ac3|ddp?5\.?1|dd5\.?1|flac|truehd|atmos|dts)\b/gi,
  /\b(?:hdr10|hdr|dovi|sdr)\b/gi,
];

/** 目录名 → {片名, 年份}。纯函数。 */
export function guessTitleFromDir(dirName: string): TitleGuess {
  let text = dirName.trim();

  // 年份: 优先取括号里的 (2019) / [2019], 其次取独立的 19xx/20xx
  let year: string | null = null;
  const bracketed = /[[(（【]\s*(19\d{2}|20\d{2})\s*[\])）】]/.exec(text);
  if (bracketed) {
    year = bracketed[1]!;
    text = text.replace(bracketed[0], " ");
  } else {
    // 必须被分隔符包住: `请回答1988` 里的 1988 是片名的一部分, 不是年份
    const loose = /(?:^|[\s._\-])((?:19|20)\d{2})(?=$|[\s._\-])/.exec(text);
    if (loose) {
      year = loose[1]!;
      text = text.replace(loose[1]!, " ");
    }
  }

  // 发布组前缀 [Group] / 【字幕组】 —— 只在开头, 别把片名里的方括号一起吃掉
  text = text.replace(/^\s*[[【][^\]】]{1,40}[\]】]\s*/, " ");
  // 其它方括号标记(字幕组/版本)整段去掉
  text = text.replace(/[[【][^\]】]{1,40}[\]】]/g, " ");

  for (const pattern of SEASON_PATTERNS) text = text.replace(pattern, " ");
  for (const pattern of EDITION_PATTERNS) text = text.replace(pattern, " ");

  // 分隔符统一成空格; `.`/`_` 在影视命名里就是空格
  text = text.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();

  // 逐个 token 去掉纯噪声词
  const tokens = text
    .split(" ")
    .map((token) => token.replace(/^[-–—]+|[-–—]+$/g, ""))
    .filter((token) => token.length > 0)
    .filter((token) => !NOISE.some((pattern) => pattern.test(token)));

  const title = tokens.join(" ").trim();
  return { title, year };
}

export type MatchConfidence = "high" | "medium" | "low";

/** 归一化: 小写、去空白标点, 只留字母数字与汉字。 */
export function normalizeTitle(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 建议的把握有多大。**只是排序与提示**, 不参与"自动决定绑哪个"。
 *
 * 判定用"包含"而不是编辑距离: 目录名常常是 `进击的巨人 最终季` 这种带副标题的写法,
 * 编辑距离会把它们判成不同作品, 而包含关系恰好对。
 */
export function matchConfidence(
  guess: TitleGuess,
  hit: { title: string; year: string | null },
): MatchConfidence {
  const left = normalizeTitle(guess.title);
  const right = normalizeTitle(hit.title);
  if (!left || !right) return "low";

  const yearMatches = !guess.year || !hit.year || guess.year === hit.year;

  if (left === right) return yearMatches ? "high" : "medium";
  if (left.length >= 2 && (right.startsWith(left) || left.startsWith(right))) {
    return yearMatches ? "medium" : "low";
  }
  if (left.length >= 4 && (right.includes(left) || left.includes(right))) return "low";
  return "low";
}

/** 搜索时用哪个关键词: 片名叫不出来就不搜(交给人工)。 */
export function searchableGuess(guess: TitleGuess): boolean {
  return normalizeTitle(guess.title).length >= 2;
}
