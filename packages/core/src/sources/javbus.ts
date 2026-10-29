import { load, type CheerioAPI } from "cheerio";
import { EXIT } from "../exit";
import type { RawFields } from "../domain/types";
import type { HttpClient } from "../net/http";
import type { Source } from "./types";

/**
 * JavBus 网页解析。选择器对齐 Amane 的 `crawlers/sites/javbus.py`:
 * 同样的站点结构, 换成 cheerio 之后逐条对应, 便于两边互相验证。
 *
 * 两个站点行为上的坑:
 *  - 不带 `dv=1` cookie 会被 302 到 /doc/driver-verify, 跟随一跳也能拿到页面, 但多一次往返;
 *  - 直达 `/番号` 未必命中, 站内检索是模糊匹配, 会返回番号相近的条目 —— 必须逐条比对, 不能取首条。
 */
export const JAVBUS_BASE = "https://www.javbus.com";

const SITE_HEADERS: Record<string, string> = {
  cookie: "dv=1",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export function createJavbusSource(http: HttpClient): Source {
  return {
    id: "javbus",
    label: "JavBus",
    status: "ready",
    contentTypes: ["censored", "uncensored", "fc2", "amateur"],
    requirements: () => [],
    async fetch(key) {
      const url = await resolveDetailUrl(http, key.value);
      if (!url) return null;
      const html = await http.getText(url, { headers: SITE_HEADERS });
      return parseDetail(html, url);
    },
  };
}

/** 站内地址只认"去掉开头纯数字段"的写法, 因此逐个形态尝试, 原样写法优先。 */
export function numberVariants(number: string): string[] {
  const variants = [number];

  const fc2 = /^FC2-PPV-(\d+)$/i.exec(number);
  if (fc2) {
    variants.push(`FC2-${fc2[1]}`);
  } else if (/^\d{2,}(?=[A-Z])/.test(number)) {
    variants.push(number.replace(/^\d+/, ""));
  }

  return [...new Set(variants)];
}

function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function withoutLeadingDigits(value: string): string {
  return value.replace(/^\d+/, "");
}

export type NumberMatch = "exact" | "without-leading-digits" | "none";

export function numberMatch(found: string, query: string): NumberMatch {
  const a = normalizeCode(found);
  const b = normalizeCode(query);
  if (!a || !b) return "none";
  if (a === b) return "exact";
  return withoutLeadingDigits(a) === withoutLeadingDigits(b) ? "without-leading-digits" : "none";
}

/**
 * 精确优先; 退而只在"仅差数字段"的候选**唯一**时取它。
 * 出现两个及以上说明站点上确有同名不同系列号的条目, 猜一个会返回无关影片, 宁可不匹配。
 */
export function selectCandidateIndex(found: string[], query: string): number | null {
  let exact: number | null = null;
  const loose: number[] = [];

  found.forEach((item, index) => {
    const match = numberMatch(item, query);
    if (match === "exact" && exact === null) exact = index;
    if (match === "without-leading-digits") loose.push(index);
  });

  if (exact !== null) return exact;
  return loose.length === 1 ? loose[0]! : null;
}

async function resolveDetailUrl(http: HttpClient, number: string): Promise<string | null> {
  for (const variant of numberVariants(number)) {
    // 1) 直达详情页
    const direct = `${JAVBUS_BASE}/${encodeURIComponent(variant)}`;
    try {
      const html = await http.getText(direct, { headers: SITE_HEADERS });
      if (isDetailPage(html)) return direct;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }

    // 2) 回退站内检索, 并按番号逐条比对
    const searchUrl = `${JAVBUS_BASE}/search/${encodeURIComponent(variant)}&type=&parent=ce`;
    try {
      const html = await http.getText(searchUrl, { headers: SITE_HEADERS });
      const candidates = parseSearch(html);
      const index = selectCandidateIndex(
        candidates.map((candidate) => candidate.number),
        number,
      );
      if (index !== null) return candidates[index]!.url;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  return null;
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { exitCode?: number }).exitCode === EXIT.NOT_FOUND);
}

export interface SearchCandidate {
  url: string;
  number: string;
}

export function parseSearch(html: string): SearchCandidate[] {
  const $ = load(html);
  const candidates: SearchCandidate[] = [];

  $("a.movie-box").each((_index, element) => {
    const href = $(element).attr("href");
    const number = $(element).find("div.photo-info date").first().text().trim();
    if (!href || !number) return;
    candidates.push({ url: new URL(href, JAVBUS_BASE).toString(), number });
  });

  return candidates;
}

function isDetailPage(html: string): boolean {
  return html.includes("movie-box") && /<h3[\s>]/i.test(html);
}

/** 详情页里"标签 + 值"的两种排布: 值在紧邻的 span 里, 或直接在父元素文本里。 */
function headerValue($: CheerioAPI, label: string): string {
  let value = "";
  $("span.header").each((_index, element) => {
    if (value) return;
    const text = $(element).text();
    if (!text.includes(label)) return;

    const sibling = $(element).next("span").text().trim();
    if (sibling) {
      value = sibling;
      return;
    }
    value = $(element).parent().text().replace(text, "").trim();
  });
  return value;
}

function firstText($: CheerioAPI, selector: string): string {
  return $(selector).first().text().trim();
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

export function parseDetail(html: string, url: string = JAVBUS_BASE): RawFields | null {
  const $ = load(html);

  const title = firstText($, "h3");
  if (!title) return null;

  const number = headerValue($, "識別碼");
  if (!number) return null;

  const actors: string[] = [];
  $("div.star-name a").each((_index, element) => {
    const name = $(element).text().trim();
    if (name) actors.push(name);
  });

  const tags: string[] = [];
  $('span.genre a[href*="/genre/"]').each((_index, element) => {
    const tag = $(element).text().trim();
    if (tag) tags.push(tag);
  });

  // 大图是 /cover/xxx_b.jpg, 缩略图是 /thumb/xxx.jpg。
  // 域模型里 poster 指"竖版大图"(给 Emby 当封面), thumb 指小图, 所以这里 poster 用 cover。
  const cover = absolute($("a.bigImage").attr("href"), url);
  const thumb = cover?.replace("/cover/", "/thumb/").replace(/_b\.jpg$/i, ".jpg");

  const releaseRaw = headerValue($, "發行日期");
  const release = /\d{4}-\d{2}-\d{2}/.exec(releaseRaw)?.[0];

  const runtimeRaw = headerValue($, "長度");
  const runtime = /\d+/.exec(runtimeRaw)?.[0];

  const studio = firstText($, 'a[href*="/studio/"]');
  const label = firstText($, 'a[href*="/label/"]');
  const director = firstText($, 'a[href*="/director/"]');
  const series = firstText($, 'a[href*="/series/"]');

  const fields: RawFields = {
    title,
    release_date: release,
    duration_min: runtime ? Number(runtime) : undefined,
    studio: studio || undefined,
    label: label || undefined,
    series: series || undefined,
    actors: actors.length > 0 ? actors : undefined,
    directors: director ? [director] : undefined,
    tags: tags.length > 0 ? tags : undefined,
    poster_urls: cover ? [cover] : undefined,
    cover_urls: cover ? [cover] : undefined,
    thumb_urls: thumb ? [thumb] : undefined,
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete (fields as Record<string, unknown>)[key];
  }
  return fields;
}
