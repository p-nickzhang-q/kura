import type { ContentType } from "../domain/types";
import { HttpClient } from "../net/http";
import { createSources, fixtureSource, type SourceConfig } from "./builtin";
import { createRegistry, type Registry, type Source } from "./types";

export { createRegistry } from "./types";
export type { Registry, Source, SourceContext } from "./types";
export { fixtureSource } from "./builtin";
export type { SourceConfig } from "./builtin";
export { buildUrl, matchDmmItem, normalizeCode, toRawFields, type DmmEnv, type DmmItem, type DmmResponse } from "./dmm";

/** 每个内容类型的站点名单。既是抓取名单, 也是逐字段择优的默认顺序。 */
export const DEFAULT_ROUTES: Record<ContentType, string[]> = {
  censored: ["dmm", "javdb", "javbus"],
  uncensored: ["javdb", "javbus"],
  fc2: ["javdb"],
  chinese: ["javdb"],
  amateur: ["javdb", "javbus"],
  western: ["javdb"],
  anime: ["dmm", "javdb"],
};

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
  const ids = override ?? DEFAULT_ROUTES[contentType];
  return ids.map((id) => registry.get(id)).filter((source): source is Source => Boolean(source));
}
