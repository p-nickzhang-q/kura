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
  // 裸的介质标记: 截断后常剩下一个 `BD` / `DVD` 这样的尾巴
  /^(?:bd|hd|dvd|br|web|hdtc|tc|ts)$/i,
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
  /\b(?:x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|10bit|8bit)\b/gi,
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

/**
 * 文件名里的发布标记 —— 中文资源站常把它们**直接粘在片名后面**, 没有分隔符:
 * `卑劣的街头BD1024高清中字.rmvb`、`101次求婚.HD1280高清国语中字.mkv`。
 *
 * token 级的 NOISE 表对这种情况无能为力(整段是一个 token), 只能按位置截断。
 */
const GLUED_MARKERS = [
  /(?:BD|HD|DVD|WEB|BR|BluRay|Blu-?ray|HDRip|BDRip|DVDRip)\s*\d{3,4}/i,
  /\d{3,4}\s*(?:高清|超清|标清|高码)/,
  /\d{3,4}[pPiI](?![a-z])/,
  /(?:x264|x265|h\.?264|h\.?265|hevc|xvid|divx|10bit|8bit|aac|ac3|ddp)/i,
  /(?:中字|中英|双字|双语|国粤|国语|粤语|韩语|日语|英语|简中|繁中|简体|繁体|中文字幕|无字|生肉)/,
  /(?:高清|超清|标清|蓝光|未删减|未删|无删|完整版|修复版|国配|中配|加长版|导演剪辑)/,
  /(?:CD|Disc|Part)\s?\d{1,2}(?![0-9])/i,
];

/**
 * 裸介质标记**不带数字**直接粘在片名后面: `开心鬼上身HD`、`逍遥法外DVD`、`教父1BD`。
 *
 * 上面第一条要求标记后面跟 3-4 位数字, 而很多站压根不写分辨率 —— 剩下一个 `HD` 粘在
 * 片名上, 整串拿去搜 TMDB 就是 0 命中。要求前一个字符是汉字或数字, 免得误伤英文词尾。
 * 单独一条是因为它要把"前一个字符"当锚点, 截断位置得 +1。
 */
const BARE_MEDIUM = /[\p{Script=Han}\d](?:HD|BD|DVD|WEB|BR|TS|TC)(?=$|[^0-9A-Za-z])/u;

/**
 * 文件名 → {片名, 年份}。
 *
 * 电影候选是按**文件**给的, 文件名比目录名脏得多: 前面挂发布站(`[迅雷下载www.2tu.cc]`)、
 * 后面粘画质与语言标记。直接拿整串去搜 TMDB 是 0 命中 —— 而 0 命中看起来像"库里没这片"。
 */
export function guessTitleFromFile(fileName: string): TitleGuess {
  const base = fileName.replace(/\.[^.]+$/, "");
  // 发布组/站点前缀先剥, 它里面常带数字, 会干扰年份判定
  let text = base.replace(/^\s*(?:[[【][^\]】]{1,60}[\]】]\s*)+/, " ");

  let cut = text.length;
  for (const pattern of GLUED_MARKERS) {
    const match = pattern.exec(text);
    // 位置 0 说明整段就是标记(比如文件名就叫 `BD1024高清`), 那种不该截
    if (match && match.index > 0 && match.index < cut) cut = match.index;
  }
  const bare = BARE_MEDIUM.exec(text);
  // 匹配到的是"最后一个汉字 + 标记", 截断点要跳过那个汉字
  if (bare && bare.index > 0) cut = Math.min(cut, bare.index + 1);

  // 截断点常落在一个方括号标记里面(`疯狂初恋[高清版]`), 会留下半个 `[`
  text = text.slice(0, cut).replace(/[\s._\-–—[【(《〈〖]+$/, "");
  // 中文资源站常写成 `〖韩国〗喜剧爱情影片《一番街的奇迹》；又名：…` ——
  // 真正的片名在书名号里, 外面的都是分类与说明。
  const bookTitle = /《([^》]{2,40})》/.exec(text);
  const guess = guessTitleFromDir(bookTitle ? bookTitle[1]! : text);
  if (normalizeTitle(guess.title).length >= 2) return guess;

  // 整个名字都是方括号分组时(`[站名][2011韩国最新爱情喜剧][攒钱罗曼史][DVD][韩语中字]`),
  // 上面那套剥完什么都不剩。这时从分组里挑一个最像片名的: 含汉字、不含网址/语种/年份。
  const groups = [...base.matchAll(/[[【]([^\]】]{2,24})[\]】]/g)].map((match) => match[1]!.trim());
  const picked = groups.find(
    (group) =>
      /\p{Script=Han}/u.test(group) &&
      normalizeTitle(group).length >= 2 &&
      !/(?:www|https?|com|net|cc|下载|迅雷|影视|影院|天堂|字幕|中字|国语|粤语|韩语|日语|英语|双语)/i.test(group) &&
      !/^(?:19|20)\d{2}/.test(group) &&
      // `[2011韩国最新爱情喜剧]` 这种是分类说明, 不是片名
      !/(?:喜剧|爱情|动作|剧情|恐怖|惊悚|悬疑|科幻|犯罪|伦理|纪实|记录|最新|合集|系列|高清)/.test(group) &&
      !/^(?:韩国|日本|美国|欧美|泰国|印度|香港|台湾|国产)$/.test(group),
  );
  // 再不行就退回原名再猜一次: 宁可搜不准, 也别一个词都不发
  return guessTitleFromDir(picked ?? base);
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
  hit: { title: string; year: string | null; originalTitle?: string | null },
): MatchConfidence {
  const left = normalizeTitle(guess.title);
  if (!left) return "low";
  const yearMatches = !guess.year || !hit.year || guess.year === hit.year;

  const score = (candidate: string | null | undefined): MatchConfidence => {
    const right = normalizeTitle(candidate ?? "");
    if (!right) return "low";
    if (left === right) return yearMatches ? "high" : "medium";
    if (left.length >= 2 && (right.startsWith(left) || left.startsWith(right))) {
      return yearMatches ? "medium" : "low";
    }
    if (left.length >= 4 && (right.includes(left) || left.includes(right))) return "low";
    return "low";
  };

  // 双语条目: 别名常常只和**原名**对得上(`Beneath Hill 60` vs 中文「60号高地之下」)
  return rank(score(hit.title)) >= rank(score(hit.originalTitle)) ? score(hit.title) : score(hit.originalTitle);
}

function rankOf(confidence: MatchConfidence): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : confidence === "low" ? 1 : 0;
}

function rank(confidence: MatchConfidence): number {
  return rankOf(confidence);
}

/** 搜索时用哪个关键词: 片名叫不出来就不搜(交给人工)。 */
export function searchableGuess(guess: TitleGuess): boolean {
  return normalizeTitle(guess.title).length >= 2;
}
