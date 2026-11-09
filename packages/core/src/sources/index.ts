import type { ContentType } from "../domain/types";
import { HttpClient } from "../net/http";
import { createSources, fixtureSource, type SourceConfig } from "./builtin";
import { createRegistry, type Registry, type Source } from "./types";

export { createRegistry } from "./types";
export type { Registry, Source, SourceContext } from "./types";
export { fixtureSource } from "./builtin";
export type { SourceConfig } from "./builtin";
export { buildUrl, matchDmmItem, normalizeCode, toRawFields, type DmmEnv, type DmmItem, type DmmResponse } from "./dmm";
export { createJavdbSource, parseDetail as parseJavdbDetail, parseSearch as parseJavdbSearch, assertNotLoginPage, type JavdbCandidate } from "./javdb";
export { contentIdCandidates, createJav321Source, parseDetail as parseJav321Detail, rowLinks as jav321RowLinks, stripTrailingActors } from "./jav321";
export { createJavbusSource, numberMatch, numberVariants, parseDetail, parseSearch, selectCandidateIndex, type SearchCandidate } from "./javbus";

/** 每个内容类型的站点名单。既是抓取名单, 也是逐字段择优的默认顺序。 */
export const DEFAULT_ROUTES: Record<ContentType, string[]> = {
  censored: ["dmm", "javbus", "javdb"],
  uncensored: ["javbus", "javdb"],
  fc2: ["javbus", "javdb"],
  chinese: ["javdb"],
  amateur: ["javbus", "javdb"],
  western: ["javdb"],
  anime: ["dmm", "javdb"],
  // 本地条目(手动加入的 UGC): 没有任何来源能刮到它, 路由为空是**结论**不是遗漏。
  ugc: [],
};

/**
 * 简介补缺来源: 只在聚合完 **plot 还是空** 时才请求。
 *
 * javbus / javdb 的详情页没有简介栏, 所以「没简介」是常态而不是解析失败;
 * 每次刮削都无脑多打一次 jav321 只会让批量刮削白白慢一倍, 所以按需补。
 */
export const PLOT_FALLBACK_SOURCES = ["jav321"] as const;

export interface DefaultSourcesOptions extends Partial<SourceConfig> {
  http?: HttpClient;
  /** 用于测试注入; 默认读环境变量。 */
  env?: Record<string, string | undefined>;
}

export function defaultSources(options: DefaultSourcesOptions = {}): Registry {
  const env = options.env ?? process.env;
  const dmm = options.dmm ?? {
    apiId: env.KURA_DMM_API_ID,
    affiliateId: env.KURA_DMM_AFFILIATE_ID,
  };
  return createRegistry(createSources(options.http ?? new HttpClient(), { dmm }));
}

/** `--source fixture` 之类的显式覆盖: 只跑指定源, 顺序即优先级。 */
export function routeFor(registry: Registry, contentType: ContentType, override?: string[]): Source[] {
  // 影视条目的 content_type 是空串(列 NOT NULL, 影视没有内容类型), 没有默认路由。
  // 这里不能直接 `.map` —— 曾经就是这样抛 "Cannot read properties of undefined (reading 'map')"。
  const ids = override ?? DEFAULT_ROUTES[contentType] ?? [];
  return ids.map((id) => registry.get(id)).filter((source): source is Source => Boolean(source));
}
