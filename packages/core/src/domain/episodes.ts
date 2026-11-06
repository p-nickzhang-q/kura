/**
 * 影视域的集号解析。纯函数: 不读盘、不读配置 —— 这样能用几十个真实文件名穷举测试。
 *
 * 影视没有番号那种"文件名自带唯一 key"，识别只能靠目录结构与命名约定。
 * v1 只认 `docs/dev/tv-domain.md` 里那张白名单，别的进未识别页人工绑定:
 * 宁可认不出，也不要认错 —— 认错 TMDB id 等于整季集名全错。
 */
import { basename, dirname, sep } from "node:path";

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文数字 (一 … 九百九十九) → 数字。认不出返回 null。 */
export function chineseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  let total = 0;
  let current = 0;
  let sawAny = false;
  for (const ch of trimmed) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch]!;
      sawAny = true;
      continue;
    }
    if (ch === "十") {
      total += (current === 0 ? 1 : current) * 10;
      current = 0;
      sawAny = true;
      continue;
    }
    if (ch === "百") {
      total += (current === 0 ? 1 : current) * 100;
      current = 0;
      sawAny = true;
      continue;
    }
    return null;
  }
  if (!sawAny) return null;
  return total + current;
}

const NUM = String.raw`(\d{1,4}|[零一二三四五六七八九十百]{1,4})`;

/** `Season 01` / `S01` / `第1季` / `第一季` → 季号; 认不出返回 null。 */
export function seasonFromDir(dirName: string): number | null {
  const name = dirName.trim();
  const season = new RegExp(String.raw`^season[\s._-]*${NUM}$`, "i").exec(name);
  if (season) return chineseNumber(season[1]!);
  const short = new RegExp(String.raw`^s${NUM}$`, "i").exec(name);
  if (short) return chineseNumber(short[1]!);
  const cn = new RegExp(String.raw`^第[\s]*${NUM}[\s]*季$`).exec(name);
  if (cn) return chineseNumber(cn[1]!);
  return null;
}

export interface EpisodeInfo {
  /** 文件名里显式写出的季号; 没写是 null (由目录决定, 再不行当第 1 季)。 */
  season: number | null;
  episode: number;
}

/**
 * 从文件名解析集号。返回 `season: null` 表示"文件名没说季, 去目录里找"。
 *
 * 认的写法 (见 docs/dev/tv-domain.md):
 *  - `S01E02` / `s1e2` / `S01.E02` / `S01_E02`
 *  - `第02集` / `第十二话` / `第3回` / `第8期`
 *  - `EP05` / `E05`
 *  - 结尾纯数字 `Show - 07` / `Show 07`
 *
 * 不认 (故意): 日期型 `20240115`、罗马数字、`Part 2`、`CD1`。它们进未识别页人工指定。
 */
export function parseEpisode(fileName: string): EpisodeInfo | null {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");

  // `[BLEACH][13].rmvb` —— 字幕组把集号单独放在方括号里, 而方括号整体是要剥掉的
  // (否则 `[Group]` 里的数字会被当成集号)。剥之前先把"纯数字的方括号"记下来当兜底。
  // 排除分辨率: `[720]` / `[1080]` / `[2160]` 这类。
  const RESOLUTIONS = new Set([360, 480, 540, 576, 720, 1080, 1440, 2160]);
  const bracketNumbers = [...withoutExtension.matchAll(/[[【[]\s*(\d{1,3})\s*[\]】\]]/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value > 0 && !RESOLUTIONS.has(value));

  // 合并集 `[BLEACH][52-53].rmvb`(两集合成一个文件)。
  // 只有"跨 1 集"才认, 记起始集号 —— 第 53 集也在同一个文件里, 缺集名单会照实说它缺。
  // 跨多集(如 `[01-12]`)是整季合集包, 认成第 1 集等于骗人, 交给人。
  const range = /[[【[]?\s*(\d{1,3})\s*[-~～]\s*(\d{1,3})\s*[\]】\]]?/.exec(withoutExtension);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > 0 && end === start + 1) return { season: null, episode: start };
  }

  // 去掉扩展名与方括号包裹的发布组标记, 免得 `[Group]` 里的数字被当成集号
  const name = withoutExtension.replace(/[[(（【][^\])）】]*[\])）】]/g, " ").trim();

  const sxxexx = new RegExp(String.raw`(?:^|[^A-Za-z0-9])S(\d{1,2})[\s._-]*E(\d{1,4})(?![0-9])`, "i").exec(name);
  if (sxxexx) {
    const episode = Number(sxxexx[2]);
    if (episode > 0) return { season: Number(sxxexx[1]), episode };
  }

  // `第12集` 与 `001集` 都算 —— 国内资源站大量写成「剧名 001集」, 没有「第」
  const cn = new RegExp(String.raw`第?[\s]*${NUM}[\s]*[集话話回期]`).exec(name);
  if (cn) {
    const episode = chineseNumber(cn[1]!);
    if (episode && episode > 0) return { season: null, episode };
  }

  // `EP01` / `E05`; 允许前面紧贴数字 (`庆余年2EP01` 的 2 是季号, 不是集号的一部分)
  const ep = /(?<![A-Za-z])EP?[\s._-]?(\d{1,4})(?![0-9])/i.exec(name);
  if (ep) {
    const episode = Number(ep[1]);
    if (episode > 0) return { season: null, episode };
  }

  // `Part 2` / `Disc 1` / `CD1` 里的数字盘号不是集号
  if (/(?:^|[\s._-])(?:part|pt|disc|disk|cd|dvd|vol)[\s._-]*\d{1,2}$/i.test(name)) return null;

  // 小数不是集号: `进击的巨人 - 13.5.MP4` 是特别篇(13.5), 认成第 13 集会跟真正的
  // 第 13 集抢同一个目标位置 —— 整理时一个搬走、一个被跳过, 谁也说不清哪个是哪个。
  if (/(?:^|[\s._-])\d{1,3}\.\d{1,2}(?:$|[\s._-])/.test(name)) return null;

  // 被分隔符包住的数字: `Show - 07` / `Show 07` / `Show 07_高清` / `Show_07`
  const bracketed = /(?:^|[\s._-])(\d{1,4})(?=[\s._-]|$)/.exec(name);
  if (bracketed) {
    const episode = Number(bracketed[1]);
    // 1080p/2160p 这类分辨率不是集号; 1900-2099 更像年份
    if (episode > 0 && episode < 1000) return { season: null, episode };
  }

  // 兜底: 只有一个候选时就认 (`[BLEACH][13].rmvb`)。两个以上说明有歧义, 交给人。
  if (bracketNumbers.length === 1) return { season: null, episode: bracketNumbers[0]! };

  return null;
}

/**
 * 剧目录: 文件所在的目录; 如果它的父目录是 `Season 01` / `第1季` 这种, 再上一层。
 *
 * 「一个目录 = 一部剧」是 Kodi/Jellyfin/Emby 的通行约定, 也是唯一能让"绑定"只做一次的粒度。
 */
export function showDirOf(filePath: string): string {
  const parent = dirname(filePath);
  return isSeasonDir(basename(parent)) ? dirname(parent) : parent;
}

export function isSeasonDir(dirName: string): boolean {
  return seasonFromDir(dirName) !== null;
}

export interface EpisodeLocation {
  /** 剧目录 (一个目录 = 一部剧的候选)。 */
  showDir: string;
  /** 已解析出来的季号 (文件名 > 季目录 > 1)。 */
  season: number;
  episode: number;
  /**
   * 季号是**文件名显式写的**吗 (`S02E07`)。
   *
   * 扫描要用它区分"文件自己声明的季"与"兜底猜的 1" —— 后者不该覆盖人工指定的季。
   */
  seasonExplicit: boolean;
}

/**
 * 文件 → (剧目录, 季, 集)。纯函数, 但需要 root 来防止往上走出库根。
 *
 * 季的优先级: 文件名里显式写的 > 季目录 > 1。
 */
export function locateEpisode(filePath: string, root: string): EpisodeLocation | null {
  const info = parseEpisode(basename(filePath));
  if (!info) return null;

  const parent = dirname(filePath);
  const dirSeason = seasonFromDir(basename(parent));
  const showDir = isSeasonDir(basename(parent)) ? dirname(parent) : parent;

  // 不允许走出库根: 库根本身若叫 `Season 1`(有人真这么干), 剧目录就是库根。
  const bounded = atOrInside(showDir, root) ? showDir : root;

  return {
    showDir: bounded,
    season: info.season ?? dirSeason ?? 1,
    episode: info.episode,
    seasonExplicit: info.season !== null,
  };
}

/** 电影没有集: 一个文件就是一部片子, 它的"剧目录"就是它自己所在的目录。 */
export function locateMovie(filePath: string, root: string): { showDir: string } {
  const parent = dirname(filePath);
  return { showDir: atOrInside(parent, root) ? parent : root };
}

function atOrInside(path: string, root: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root.slice(0, -1) : root;
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}${sep}`);
}
