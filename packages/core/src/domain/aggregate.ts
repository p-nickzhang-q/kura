import {
  LIST_FIELDS,
  SINGLE_FIELDS,
  URL_FIELDS,
  type FieldKey,
  type RawFields,
  type SourceRecord,
} from "./types";

export interface AggregateResult {
  fields: RawFields;
  fieldSources: Record<string, string>;
}

/**
 * 逐字段择优。三个规则, 没有例外:
 *  - 单源字段: 路由里第一个非空值
 *  - 列表字段: 路由里第一个非空列表(不做并集, 并集会让演员表越长越脏)
 *  - URL 字段:  按路由顺序拼接去重
 * `routing` 是来源 id 的有序名单; 不在名单里的记录直接丢弃。
 */
export function aggregate(records: SourceRecord[], routing: string[]): AggregateResult {
  const ordered = routing
    .map((site) => records.find((record) => record.site === site))
    .filter((record): record is SourceRecord => Boolean(record));

  const fields: RawFields = {};
  const fieldSources: Record<string, string> = {};

  for (const key of SINGLE_FIELDS) {
    const hit = ordered.find((record) => isPresent(record.fields[key]));
    if (hit) {
      (fields as Record<string, unknown>)[key] = hit.fields[key];
      fieldSources[key] = hit.site;
    }
  }

  for (const key of LIST_FIELDS) {
    const hit = ordered.find((record) => Array.isArray(record.fields[key]) && (record.fields[key] as string[]).length > 0);
    if (hit) {
      (fields as Record<string, unknown>)[key] = dedupe((hit.fields[key] as string[]).map(clean));
      // 多值字段也要记来源: 否则"演员是刮来的还是 NFO 种下的"分不清,
      // 兜底规则就会拿旧值盖掉新值。
      fieldSources[key] = hit.site;
    }
  }

  for (const key of URL_FIELDS) {
    const urls: string[] = [];
    for (const record of ordered) {
      for (const url of record.fields[key] ?? []) {
        if (url && !urls.includes(url)) urls.push(url);
      }
    }
    if (urls.length > 0) fields[key] = urls;
  }

  return { fields, fieldSources };
}

/**
 * 重新聚合时的覆盖规则, 依次是:
 *  1. 网络来源永远覆盖已有值 —— 包括 NFO 种下的值;
 *  2. 用户锁定的字段保留原值(见 CONTEXT.md 字段锁定);
 *  3. 网络这次没给的字段, 用 NFO 种下的值兜底。
 *
 * 第 3 条是必需的: 有的来源不给演员, 若只按"incoming 有什么就写什么",
 * 重刮一次就会把 NFO 里对得上的演员抹掉, 条目看起来"越刮越空"。
 */
export function mergeWithPinned(
  incoming: AggregateResult,
  existing: RawFields,
  pinned: FieldKey[],
  existingSources: Record<string, string> = {},
): AggregateResult {
  const fields: RawFields = { ...incoming.fields };
  const fieldSources = { ...incoming.fieldSources };

  for (const [key, source] of Object.entries(existingSources)) {
    if (source !== "nfo") continue;
    if (isPresent((fields as Record<string, unknown>)[key])) continue;
    if (Array.isArray((fields as Record<string, unknown>)[key])) continue;
    const value = (existing as Record<string, unknown>)[key];
    if (value === undefined) continue;
    (fields as Record<string, unknown>)[key] = value;
    fieldSources[key] = "nfo";
  }

  for (const key of pinned) {
    const value = existing[key];
    if (value === undefined) continue;
    (fields as Record<string, unknown>)[key] = value;
  }
  return { fields, fieldSources };
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return false;
}

function clean(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
