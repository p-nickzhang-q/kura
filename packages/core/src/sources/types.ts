import type { ContentType, ItemKey, RawFields } from "../domain/types";

export interface SourceContext {
  /** 离线样本目录; 只有 fixture 源使用。 */
  fixturesDir: string | null;
  /** 外部取消信号, 供会发请求的来源透传给 HttpClient。 */
  signal?: AbortSignal;
}

/**
 * 一个来源 = 一个纯数据获取器。无状态, HTTP 客户端从 context 注入。
 * 返回 null 表示"这个源没有这条", 与"源出错"区分开(后者抛异常)。
 */
export interface Source {
  id: string;
  label: string;
  /** todo 的源不参与刮削, 也不该被调用 —— 避免把未实现的代码伪装成可用。 */
  status: "ready" | "todo";
  contentTypes: ContentType[] | "all";
  /** 缺哪些配置就无法工作(环境变量名), 供 `source list` 与 NEEDS_INPUT 报错共用。 */
  requirements(): string[];
  fetch(key: ItemKey, ctx: SourceContext): Promise<RawFields | null>;
}

export interface Registry {
  list(): Source[];
  get(id: string): Source | undefined;
}

export function createRegistry(sources: Source[]): Registry {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return {
    list: () => sources,
    get: (id) => byId.get(id),
  };
}
