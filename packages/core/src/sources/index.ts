import type { ContentType } from "../domain/types";
import { dmmSource, fixtureSource, javbusSource, javdbSource } from "./builtin";
import { createRegistry, type Registry, type Source } from "./types";

export { createRegistry } from "./types";
export type { Registry, Source, SourceContext } from "./types";
export { fixtureSource } from "./builtin";

/** 每个内容类型的站点名单。既是抓取名单, 也是逐字段择优的默认顺序。 */
export const DEFAULT_ROUTES: Record<ContentType, string[]> = {
  censored: ["javdb", "javbus", "dmm"],
  uncensored: ["javdb", "javbus"],
  fc2: ["javdb"],
  chinese: ["javdb"],
  amateur: ["javdb", "javbus"],
  western: ["javdb"],
  anime: ["dmm", "javdb"],
};

export function defaultSources(): Registry {
  return createRegistry([javdbSource, javbusSource, dmmSource, fixtureSource]);
}

/** `--source fixture` 之类的显式覆盖: 只跑指定源, 顺序即优先级。 */
export function routeFor(
  registry: Registry,
  contentType: ContentType,
  override?: string[],
): Source[] {
  const ids = override ?? DEFAULT_ROUTES[contentType];
  return ids
    .map((id) => registry.get(id))
    .filter((source): source is Source => Boolean(source));
}
