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
    if (hit) (fields as Record<string, unknown>)[key] = dedupe((hit.fields[key] as string[]).map(clean));
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

/** 重新聚合时保留用户锁定字段(见 CONTEXT.md 字段锁定)。 */
export function mergeWithPinned(
  incoming: AggregateResult,
  existing: RawFields,
  pinned: FieldKey[],
): AggregateResult {
  const fields: RawFields = { ...incoming.fields };
  const fieldSources = { ...incoming.fieldSources };

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
