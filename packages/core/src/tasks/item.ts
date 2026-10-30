import { AppError, EXIT } from "../exit";
import { FIELD_KEYS, type FieldKey } from "../domain/types";
import { metadataColumns, parseJson, rowToMetadata, stringify, type ItemRow } from "../db/rows";
import { pruneActors, syncItemActors } from "../db/actors";
import type { Runtime } from "../runtime";
import { getItem, type ItemView } from "./scrape";

export interface UpdateItemOptions {
  key: string;
  /** 只接受 FIELD_KEYS 里的字段名, 杜绝"参数当列名"的注入面。 */
  patch?: Partial<Record<FieldKey, string | string[] | number>>;
  /** 写入后锁定的字段: 重新刮削不覆盖。 */
  pin?: FieldKey[];
  unpin?: FieldKey[];
}

/**
 * 手动改字段 + 锁定。
 *
 * 锁定是"重新刮削不覆盖"的唯一保障: 手工修过的标题如果不锁,
 * 下一次 SCRAPE 就会把它冲掉 —— 这是实际使用中最先咬人的问题。
 */
export function updateItem(rt: Runtime, options: UpdateItemOptions): ItemView {
  const row = rt.db.get<ItemRow>("select * from items where number = ?", [options.key]);
  if (!row) throw new AppError(`条目不存在: ${options.key}`, EXIT.NOT_FOUND, { number: options.key });

  const metadata = rowToMetadata(row);
  for (const [field, value] of Object.entries(options.patch ?? {})) {
    if (!(FIELD_KEYS as readonly string[]).includes(field)) {
      throw new AppError(`不可写的字段: ${field}`, EXIT.USAGE, { field, allowed: FIELD_KEYS as unknown as string[] });
    }
    (metadata as unknown as Record<string, unknown>)[field] = value;
  }

  const current = new Set(parseJson<FieldKey[]>(row.pinned) ?? []);
  for (const field of options.pin ?? []) current.add(field);
  for (const field of options.unpin ?? []) current.delete(field);

  const pinned = [...current].filter((field) => (FIELD_KEYS as readonly string[]).includes(field));
  const columns = metadataColumns(metadata);

  rt.db.run(
    `update items set ${Object.keys(columns)
      .map((name) => `${name} = ?`)
      .join(", ")}, pinned = ?, updated_at = unixepoch()
     where number = ?`,
    [...Object.values(columns), stringify(pinned), options.key],
  );

  // 手动改过演员也要重建索引, 否则"点演员看全部"会漏掉这条。
  if (options.patch?.actors !== undefined) {
    syncItemActors(rt.db, options.key);
    pruneActors(rt.db);
  }

  return getItem(rt, options.key)!;
}

/** 解析 `title,plot` 这种逗号分隔的字段名, 并校验合法性。 */
export function parseFieldList(value: string | undefined): FieldKey[] {
  if (!value) return [];
  const fields = value
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  for (const field of fields) {
    if (!(FIELD_KEYS as readonly string[]).includes(field)) {
      throw new AppError(`未知字段: ${field}`, EXIT.USAGE, { field, allowed: FIELD_KEYS as unknown as string[] });
    }
  }
  return fields as FieldKey[];
}

/** 逗号分隔值 → 列表字段。单个值也是列表, 保持类型一致。 */
export function parseListValue(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
