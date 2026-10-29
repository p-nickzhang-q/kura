import { load, type CheerioAPI } from "cheerio";
import { AppError, EXIT } from "../exit";
import type { RawFields } from "../domain/types";
import type { HttpClient } from "../net/http";
import { selectCandidateIndex } from "./javbus";
import type { Source } from "./types";

/**
 * JavDB 网页解析。选择器对齐 Amane 的 `crawlers/sites/javdb.py`。
 *
 * 与 JavBus 的三处不同:
 *  - 番号来自详情页的 `data-clipboard-text`(按钮), 不是正文里的"識別碼";
 *  - 字段是 `<strong>标签:</strong><span class="value">值</span>` 的行式结构, 值可能是链接也可能是纯文本;
 *  - **无码条目要求登录**: 未登录时站点的登录页同样返回 200, 只能靠页面自身特征识别。
 */
export const JAVDB_BASE = "https://javdb.com";

const SITE_HEADERS: Record<string, string> = {
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export function createJavdbSource(http: HttpClient): Source {
  return {
    id: "javdb",
    label: "JavDB",
    status: "ready",
    contentTypes: "all",
    requirements: () => [],
    async fetch(key) {
      const url = await findDetailUrl(http, key.value);
      if (!url) return null;
      const html = await http.getText(url, { headers: SITE_HEADERS });
      return parseDetail(html, url);
    },
  };
}

async function findDetailUrl(http: HttpClient, number: string): Promise<string | null> {
  const searchUrl = `${JAVDB_BASE}/search?q=${encodeURIComponent(number)}&locale=zh`;
  const html = await http.getText(searchUrl, { headers: SITE_HEADERS });
  const candidates = parseSearch(html);
  const index = selectCandidateIndex(
    candidates.map((candidate) => candidate.number),
    number,
  );
  return index === null ? null : candidates[index]!.url;
}

export interface JavdbCandidate {
  url: string;
  number: string;
}

export function parseSearch(html: string): JavdbCandidate[] {
  const $ = load(html);
  assertNotLoginPage($);

  const candidates: JavdbCandidate[] = [];
  $("a.box").each((_index, element) => {
    const href = $(element).attr("href");
    const number = $(element).find("div.video-title strong").first().text().trim();
    if (!href || !number) return;
    candidates.push({ url: new URL(href, JAVDB_BASE).toString(), number });
  });
  return candidates;
}

/**
 * 登录页与正常页同为 200, 只能看页面自身:
 * 动作地址指向 user_sessions 的表单 + 密码框。光靠"登入"文案会误伤导航栏。
 */
export function assertNotLoginPage($: CheerioAPI): void {
  if ($('form[action*="user_sessions"] input[type="password"]').length > 0) {
    throw new AppError("JavDB 需要登录 (无码条目要求账号)", EXIT.NEEDS_INPUT, {
      source: "javdb",
      hint: "在浏览器登录后把 Cookie 提供给程序, 或改用其它来源",
    });
  }
}

/** 行式布局: `<strong>标签:</strong><span class="value">…</span>`。 */
function rowValue($: CheerioAPI, label: string) {
  const header = $("strong")
    .filter((_index, element) => $(element).text().includes(label))
    .first();
  return header.length > 0 ? header.next("span.value") : $("kura-empty");
}

function rowText($: CheerioAPI, label: string): string {
  return rowValue($, label).text().trim();
}

function rowLinks($: CheerioAPI, label: string): string[] {
  const names: string[] = [];
  rowValue($, label)
    .find("a")
    .each((_index, element) => {
      const name = $(element).text().trim();
      if (name) names.push(name);
    });
  return names;
}

export function parseDetail(html: string, url: string = JAVDB_BASE): RawFields | null {
  const $ = load(html);
  assertNotLoginPage($);

  const number = $("a[data-clipboard-text]").first().attr("data-clipboard-text")?.trim();
  if (!number) return null;

  const title = $("h2.title.is-4 strong.current-title").first().text().trim();
  if (!title) return null;

  const release = /\d{4}-\d{2}-\d{2}/.exec(rowText($, "日期"))?.[0];
  const runtime = /\d+/.exec(rowText($, "時長"))?.[0];

  // JavDB 只给一张封面; 海报与封面同源。
  const cover = $("img.video-cover").first().attr("src")?.trim();
  const coverUrl = cover ? safeAbsolute(cover, url) : undefined;

  const actors = rowLinks($, "演員");
  const directors = rowLinks($, "導演");
  const tags = rowLinks($, "類別");
  const studio = rowLinks($, "片商")[0];
  const label = rowLinks($, "發行")[0];
  const series = rowLinks($, "系列")[0];

  const fields: RawFields = {
    title,
    release_date: release,
    duration_min: runtime ? Number(runtime) : undefined,
    studio,
    label,
    series,
    actors: actors.length > 0 ? actors : undefined,
    directors: directors.length > 0 ? directors : undefined,
    tags: tags.length > 0 ? tags : undefined,
    poster_urls: coverUrl ? [coverUrl] : undefined,
    cover_urls: coverUrl ? [coverUrl] : undefined,
  };

  // 评分(`span.score-stars` 后面的文本)目前不进域模型, 见 ADR 0002 的字段取舍。
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete (fields as Record<string, unknown>)[key];
  }
  return fields;
}

function safeAbsolute(value: string, base: string): string | undefined {
  try {
    return new URL(value, base).toString();
  } catch {
    return undefined;
  }
}
