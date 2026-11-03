import type { ContentType, FileInfo, ItemKey } from "./types";

/**
 * 识别 = 纯函数。无 IO、无配置依赖 —— 这样它可以用几十个文件名样本穷举测试,
 * 而不需要起数据库或打网络。
 */

/** 全角 → 半角, 统一大小写与分隔符。 */
export function normalizeText(input: string): string {
  return input
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .toUpperCase()
    .replace(/[_]+/g, "-")
    // "ABC 123" 与 "ABC-123" 视为同一番号
    .replace(/([A-Z])\s+(\d)/g, "$1-$2")
    .replace(/\s*-\s*/g, "-")
    .trim();
}

// FC2 的 PPV 段经常被省略: 老片子/中转站常写成 "FC2-1122370"。
const FC2_RE = /FC2[-_ ]?(?:PPV[-_ ]?)?(\d{5,8})/;
const UNCENSORED_RE = /(?:^|\D)(\d{6})-(\d{3})(?:\D|$)/;
/**
 * 前缀里带数字的番号 (T28-642、FC2-...)。**必须**有连字符, 否则 "MOVIE2019" 这种会被误认。
 */
const ALNUM_NUM_RE = /(?:^|[^A-Z])([A-Z][A-Z0-9]{1,11})-(\d{2,7})(?:\W|$)/;
/**
 * 纯字母前缀。前面的字符只排除大写字母 —— 因为中转站常给番号加数字前缀
 * (104DANDY-574、261MARA-029、300MIUM-949 里的 104/261/300 是站点编号, 不是番号的一部分)。
 */
const CENSORED_RE = /(?:^|[^A-Z])([A-Z]{2,10})-?(\d{2,7})(?:\W|$)/;

/** 从任意文本(通常是文件名)里抽出规范番号; 抽不到返回 null。 */
export function extractNumber(text: string): string | null {
  const normalized = normalizeText(text);

  const fc2 = FC2_RE.exec(normalized);
  if (fc2) return `FC2-PPV-${fc2[1]}`;

  const uncensored = UNCENSORED_RE.exec(normalized);
  if (uncensored) return `${uncensored[1]}-${uncensored[2]}`;

  const alnum = ALNUM_NUM_RE.exec(normalized);
  if (alnum) return `${alnum[1]}-${alnum[2]}`;

  const censored = CENSORED_RE.exec(normalized);
  if (censored) return `${censored[1]}-${censored[2]}`;

  return null;
}

/** 无番号条目的站点键是另一个命名空间, 不允许和真番号混用。 */
export function siteKey(site: string, id: string): string {
  return `${site}:${id.toLowerCase()}`;
}

export function isSiteKey(value: string): boolean {
  return value.includes(":");
}

const AMATEUR_HINTS = /\b(SIRO|LUXU|GACHI|PACOPACOMAMA|10MUSUME|HEYZO|TOKYO-HOT)\b/;
/**
 * 国产/中文厂牌线索。
 *
 * 这里**只能放不会被番号撞上的写法**: 早期版本写的是裸 `MD` 与 `91`, 于是
 * `SNIS-191`、`IPX-191`、`MDON-027` 全被判成国产, 而国产只路由到 javdb ——
 * javdb 一被 Cloudflare 拦, 这些条目就一条源都拿不到, 报错还只提 javdb,
 * 看起来像"站点挂了", 实际是类型判错了、压根没试 javbus。
 */
const CHINESE_HINTS =
  /(国产|国产精品|麻豆|天美|果冻传媒|星空传媒|麻豆传媒|SWAG|CHINESE|91CM|91KZ|91PORN|\bMD[XLT]?-\d|\bMDX\d)/i;
const WESTERN_HINTS = /\b(XXX|PORN|BRAZZERS|BLACKED|VIXEN|PASSION)\b/;

/**
 * 类型判定顺序固定: fc2 → uncensored → amateur → chinese → western → censored。
 * 只在建条目时跑一次, 落库后不可改 (见 ADR 0002)。
 */
export function detectContentType(number: string, hintText = ""): ContentType | null {
  const text = `${number} ${normalizeText(hintText)}`;

  if (number.startsWith("FC2-PPV-")) return "fc2";
  if (/^\d{6}-\d{3}$/.test(number)) return "uncensored";
  if (AMATEUR_HINTS.test(text)) return "amateur";
  if (CHINESE_HINTS.test(text)) return "chinese";
  if (WESTERN_HINTS.test(text)) return "western";
  if (CENSORED_RE.test(normalizeText(number)) || ALNUM_NUM_RE.test(normalizeText(number))) return "censored";
  return null;
}

/** 站内 ID 形式的输入 (素人/国产), 需要调用方给 site。 */
export function identify(input: { text: string; site?: string; siteId?: string }): ItemKey | null {
  if (input.site && input.siteId) {
    const contentType = detectContentType("", input.text) ?? "amateur";
    return { value: siteKey(input.site, input.siteId), contentType, number: null };
  }

  const number = extractNumber(input.text);
  if (!number) return null;
  const contentType = detectContentType(number, input.text);
  if (!contentType) return null;
  return { value: number, contentType, number };
}

/**
 * 相位从路径推导, 不是条目属性。
 * JAV 命名约定: `-C` 中字, `-U` 无码, `-UC` 无码+中字, `-CD1` 分集。
 */
export function parseFileInfo(fileName: string): FileInfo {
  const base = normalizeText(fileName.replace(/\.[^.]+$/, ""));

  const cd = /(?:^|-)(?:CD|DISC)(\d{1,2})(?:\W|$)/.exec(base);
  const part = /(?:^|-)(?:PT|PART)(\d{1,2})(?:\W|$)/.exec(base);

  // `-C` = 中字, `-U` = 无码, `-UC` = 无码 + 中字; `-CD1` 是分集, 不算中字。
  const hasSubtitle = /(?:^|-)(?:U?C)(?:\W|$)/.test(base);
  const uncensored = /(?:^|-)(?:U|UC)(?:\W|$)/.test(base);
  const leaked = /(流出|LEAKED)/.test(base);
  const cracked = /(破解|CRACKED)/.test(base);

  // 同时命中时优先级: 破解 > 流出 > 无码 (与 Amane 一致)
  const mosaic = cracked ? "cracked" : leaked ? "leaked" : uncensored ? "uncensored" : null;

  const definition = /\b(?:8K|4K|2160P)\b/.test(base)
    ? "4k"
    : /\b(?:1440P|2K)\b/.test(base)
      ? "1440p"
      : /\b1080P?\b/.test(base)
        ? "1080p"
        : /\b720P\b/.test(base)
          ? "720p"
          : null;

  return {
    cd: cd ? Number(cd[1]) : null,
    part: part ? part[1]! : null,
    hasSubtitle,
    mosaic,
    definition,
  };
}

/** Emby / Jellyfin / Kodi 放"辅助媒体"的目录: 里面是主题视频、预告片、样片, 不是影片。 */
const AUXILIARY_DIRS = new Set(["backdrops", "trailers", "trailer", "extras", "featurettes", "sample", "samples", "behind the scenes", "deleted scenes", "interviews", "scenes"]);

/** 这类文件名固定是辅助媒体, 与番号无关。 */
const AUXILIARY_NAMES = /^(?:theme_video|theme|trailer|movie-trailer|sample|trailer-[a-z0-9]+|-[a-z0-9]+-trailer)$/i;

/**
 * 这个文件是不是媒体库的"辅助媒体"(Emby/Jellyfin 的主题视频、预告片、样片)。
 *
 * 必须排除, 否则会闯祸: 影片目录里常有 `backdrops\theme_video.mp4` 与
 * `trailers\trailer.mp4`, 番号从**目录名**解析出来, 于是它们被当成同一部片的文件;
 * 同步 NFO 时按"视频名.nfo"去写, 就会去改写 Emby 自己的 `theme_video.nfo` / `trailer.nfo`,
 * 把影片元数据塞进辅助媒体的元数据里。
 */
export function isAuxiliaryMedia(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return false;
  const fileName = parts[parts.length - 1]!;
  if (AUXILIARY_NAMES.test(fileName.replace(/\.[^.]+$/, ""))) return true;
  // 目录判断不含文件名本身: 影片也可能叫 sample 之类的, 那是目录约定才可信。
  return parts.slice(0, -1).some((part) => AUXILIARY_DIRS.has(part.toLowerCase()));
}
