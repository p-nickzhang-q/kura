import { load, type CheerioAPI } from "cheerio";
import { AppError, EXIT } from "../exit";
import type { RawFields } from "../domain/types";
import type { HttpClient } from "../net/http";
import type { Source } from "./types";

/**
 * Jav321 (一木道) 网页解析。字段对齐 Amane 的 `crawlers/sites/jav321.py`。
 *
 * **它存在的唯一理由是简介**。JavBus 与 JavDB 的详情页结构里根本没有简介栏
 * (看起来像"解析漏了", 实际是页面上没有), DMM 的 あらすじ 只在商品页且被地域封锁,
 * r18.dev 的 `comment_ja` 只在官方 PostgreSQL dump 里、HTTP 接口返回是空的。
 * 一木道的详情页有整段日语 あらすじ, 不挂 Cloudflare, 大陆直连可达。
 *
 * 两个与别站不同的坑:
 *  - 地址用 DMM 的 content_id (**小写厂牌 + 集号补零到 5 位**): `SSIS-001` → `ssis00001`。
 *    补零位数各时期不一致, 老片可能只有 3 位, 所以按候选逐个试, 不猜一个。
 *  - 字段是 `<b>标签</b>: 值 <a>…</a> &nbsp; <a>…</a>` 平铺在一个 div 里,
 *    **没有独立的行容器** —— `parent().find("a")` 会把演员和厂牌的链接一起捞进来,
 *    必须按 `nextUntil("b")` 取到下一个标签之前的那几个兄弟节点。
 */
export const JAV321_BASE = "https://www.jav321.com";

const SITE_HEADERS: Record<string, string> = {
  "accept-language": "ja,en;q=0.8",
};

export function createJav321Source(http: HttpClient): Source {
  return {
    id: "jav321",
    label: "Jav321 (一木道)",
    status: "ready",
    contentTypes: ["censored", "uncensored", "amateur"],
    requirements: () => [],
    async fetch(key, ctx) {
      for (const id of contentIdCandidates(key.value)) {
        const url = `${JAV321_BASE}/video/${id}`;
        let html: string;
        try {
          html = await http.getText(url, { headers: SITE_HEADERS, signal: ctx.signal });
        } catch (err) {
          // 只有"这个地址没这条"(404)才是预期结果, 继续试下一个补零位数。
          // 网络错误必须抛上去 —— 吞掉的话「连不上」会显示成「站里没有这条」,
          // 用户就会以为这个站不收录他的片子, 而实际上只是没代理/超时。
          const notFound = err instanceof AppError && err.exitCode === EXIT.NOT_FOUND;
          if (!notFound) throw err;
          continue;
        }
        const fields = parseDetail(html);
        if (fields) return fields;
      }
      return null;
    },
  };
}

/**
 * `SSIS-001` → `["ssis00001", "ssis001", "ssis0001"]`。
 * 顺序是命中概率从高到低; 全都不中就当作这个站没有这条。
 */
export function contentIdCandidates(number: string): string[] {
  const compact = number.toLowerCase().replace(/[^a-z0-9]/g, "");
  const match = /^([a-z]+)(\d+)$/.exec(compact);
  if (!match) return [compact];

  const label = match[1]!;
  const digits = match[2]!;
  return [
    ...new Set([`${label}${digits.padStart(5, "0")}`, `${label}${digits.padStart(3, "0")}`, `${label}${digits}`]),
  ];
}

export function parseDetail(html: string): RawFields | null {
  const $ = load(html);

  const heading = $("div.panel-heading h3").first();
  if (heading.length === 0) return null;
  // h3 里还挂着 <small>女优名</small>, 直接 .text() 会把演员拼进标题
  const headingClone = heading.clone();
  headingClone.find("small").remove();
  const rawTitle = headingClone.text().replace(/\s+/g, " ").trim();
  if (!rawTitle) return null;

  const actors = rowLinks($, "出演者");
  // h3 里演员名是**裸文本**接在标题后面(`<h3>标题 女优A 女优B <small>番号 …</small></h3>`),
  // 不去掉的话标题永远带着两个女优名, 而详情页下方已经把演员单列出来了。
  const titleText = stripTrailingActors(rawTitle, actors);
  const tags = rowLinks($, "ジャンル");
  const studio = rowLinks($, "メーカー")[0];
  const label = rowLinks($, "レーベル")[0];
  const series = rowLinks($, "シリーズ")[0];

  const meta = $("div.col-md-9").first().text();
  const release = /配信開始日[:：]?\s*(\d{4}-\d{2}-\d{2})/.exec(meta)?.[1];
  const runtime = /収録時間[:：]?\s*(\d+)/.exec(meta)?.[1];

  // 封面是 pics.dmm.co.jp 的 ps(=small); DMM 的命名里 pl 才是大图
  const thumb = $("div.panel-body img").first().attr("src")?.replace(/^http:/, "https:");

  const fields: RawFields = {
    title: titleText,
    plot: pickPlot($),
    release_date: release,
    duration_min: runtime ? Number(runtime) : undefined,
    studio,
    label,
    series,
    actors: actors.length > 0 ? actors : undefined,
    tags: tags.length > 0 ? tags : undefined,
    poster_urls: thumb ? [thumb.replace(/ps\.jpg$/i, "pl.jpg")] : undefined,
    thumb_urls: thumb ? [thumb] : undefined,
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete (fields as Record<string, unknown>)[key];
  }
  return fields;
}

export function stripTrailingActors(title: string, actors: string[]): string {
  let out = title;
  // 多个演员依次出现, 所以反复扫到不再变化为止
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of actors) {
      const trimmed = out.replace(/\s+$/, "");
      if (name && trimmed.endsWith(name)) {
        out = trimmed.slice(0, -name.length).trim();
        changed = true;
      }
    }
  }
  return out;
}

/** `<b>标签</b>: <a>…</a> &nbsp; <a>…</a><br>` 里属于这个标签的那几个链接。 */
export function rowLinks($: CheerioAPI, label: string): string[] {
  const marker = $("b")
    .filter((_index, element) => $(element).text().trim() === label)
    .first();
  if (marker.length === 0) return [];

  const out: string[] = [];
  marker.nextUntil("b").each((_index, element) => {
    const node = $(element);
    const anchors = node.is("a") ? node : node.find("a");
    anchors.each((_anchorIndex, anchor) => {
      const value = $(anchor).text().trim();
      if (value) out.push(value);
    });
  });
  return [...new Set(out)];
}

/**
 * 简介: `col-md-12` 里**以长文本开头**的那个容器, 取开头那几段文本。
 *
 * 不能按"没有子元素"筛 —— 简介容器后面还挂着 DMM 直播广告(`<a><img></a>`)与
 * `※ 配信方法により…` 免责声明(`<p class="mg-t6 tx10">`), 有子元素是常态。
 * 也不能整块 `.text()` —— 会把广告文案和"※ 配信方法"一起拼进简介。
 *
 * 判据: 第一个节点是长度 ≥20 的文本节点; 取值: 从头收文本节点, 遇到 `<br>` 换行,
 * 遇到别的元素就停(广告/免责声明都在那之后)。
 * 演员面板里的推荐位以 `<div class="col-xs-6">` 开头, 天然被这条判据排除。
 */
function pickPlot($: CheerioAPI): string | undefined {
  let found: string | undefined;
  $("div.panel-body div.col-md-12").each((_index, element) => {
    if (found) return;

    const nodes = $(element).contents().toArray();
    if (nodes.length === 0) return;

    const first = nodes[0]!;
    if (!isText(first)) return;
    if ($(first).text().replace(/\s+/g, " ").trim().length < 20) return;

    const parts: string[] = [];
    for (const node of nodes) {
      if (isText(node)) {
        const value = $(node).text().replace(/\s+/g, " ").trim();
        if (value) parts.push(value);
        continue;
      }
      // <br> 是段落分隔, 继续; 别的元素是广告/免责声明, 到这儿就结束
      if ("tagName" in node && String(node.tagName).toLowerCase() === "br") continue;
      break;
    }

    const value = parts.join(" ").replace(/\s+/g, " ").trim();
    if (value.length >= 20) found = value;
  });
  return found;
}

function isText(node: { type?: string }): boolean {
  return node.type === "text";
}
