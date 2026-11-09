/**
 * **库**的域 (ADR 0008 + ADR 0009): 决定识别方式、来源与默认模板。
 *
 * 只有两个: 番号制与影视。影视库里的条目再分电影/剧集, 但那是**条目类型**,
 * 从身份键 (`tmdb:movie:` / `tmdb:tv:`) 推导 —— 不需要用户在建库时选第二遍,
 * 也不会出现"同一个文件被两个库争抢" (media_files.path 是主键, 一个文件只能属于一个库)。
 */
export const LIBRARY_DOMAINS = ["av", "video"] as const;
export type LibraryDomain = (typeof LIBRARY_DOMAINS)[number];

export const LIBRARY_DOMAIN_LABEL: Record<LibraryDomain, string> = {
  av: "番号制",
  video: "影视",
};

export function isLibraryDomain(value: unknown): value is LibraryDomain {
  return typeof value === "string" && (LIBRARY_DOMAINS as readonly string[]).includes(value);
}

/**
 * **条目**的域(类型)。内容类型是 `av` 内部更细的分类, 两者不是一个轴。
 * 影视条目的 movie / tv 由身份键推导, 永不跨类型转换。
 */
export const DOMAINS = ["av", "movie", "tv"] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABEL: Record<Domain, string> = {
  av: "番号制",
  movie: "电影",
  tv: "剧集",
};

export function isDomain(value: unknown): value is Domain {
  return typeof value === "string" && (DOMAINS as readonly string[]).includes(value);
}

/**
 * `ugc` 不是番号制的分类, 是**影视域本地条目**的标记: 手动加入、没有任何网络来源。
 * 放进同一列是因为 `content_type` 是 NOT NULL 且改造它要重建表, 不值得 ——
 * 但它的含义明确: 看到 `ugc` 就当"没有来源可刮、整理也不动它"。
 */
export const CONTENT_TYPES = ["censored", "uncensored", "fc2", "chinese", "amateur", "western", "anime", "ugc"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  censored: "有码",
  uncensored: "无码",
  fc2: "FC2",
  chinese: "国产",
  amateur: "素人",
  western: "欧美",
  anime: "动漫",
  ugc: "UGC（本地）",
};

/** 单源字段: 逐字段取路由里第一个非空值。 */
export const SINGLE_FIELDS = [
  "title",
  "plot",
  "release_date",
  "duration_min",
  "studio",
  "label",
  "series",
] as const;

/** 列表字段: 取路由里第一个非空列表, 不做并集。 */
export const LIST_FIELDS = ["directors", "actors", "tags"] as const;

/** URL 字段: 按路由顺序拼接去重 —— 多一张图是收益, 不是噪声。 */
export const URL_FIELDS = ["poster_urls", "cover_urls", "thumb_urls"] as const;

export const FIELD_KEYS = [...SINGLE_FIELDS, ...LIST_FIELDS, ...URL_FIELDS] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export interface RawFields {
  title?: string;
  plot?: string;
  release_date?: string;
  duration_min?: number;
  studio?: string;
  label?: string;
  series?: string;
  directors?: string[];
  actors?: string[];
  tags?: string[];
  poster_urls?: string[];
  cover_urls?: string[];
  thumb_urls?: string[];
}

/** 一个来源对一条目的返回。site 是来源 id, 与 Source.id 一致。 */
export interface SourceRecord {
  site: string;
  fields: RawFields;
}

export interface ItemKey {
  /** 条目身份: 规范番号 (`ABC-123`) 或站点键 (`javdb:2x9k1`)。 */
  value: string;
  contentType: ContentType;
  /** 真番号; 无番号条目为 null。 */
  number: string | null;
}

export interface Metadata extends RawFields {
  /** 翻译前的原文; 没有翻译时为空。NFO 的 originaltitle 与 {title} 占位符用它。 */
  titleOriginal?: string;
  plotOriginal?: string;
  key: string;
  number: string | null;
  contentType: ContentType;
  /** 域: av / movie / tv。av 条目没有内容类型的场合会看到空串, 域永远是确定的。 */
  domain?: Domain;
  /** 只记单源字段的来源; 列表/URL 字段自带顺序。 */
  fieldSources: Record<string, string>;
}

/** 文件相位: 从路径推导, 不是条目属性 (见 CONTEXT.md)。 */
export interface FileInfo {
  cd: number | null;
  part: string | null;
  hasSubtitle: boolean;
  mosaic: "uncensored" | "cracked" | "leaked" | null;
  definition: string | null;
}
