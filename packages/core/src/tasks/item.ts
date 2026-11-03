import { AppError, EXIT } from "../exit";
import { CONTENT_TYPES, FIELD_KEYS, type FieldKey } from "../domain/types";
import { detectContentType } from "../domain/identify";
import { metadataColumns, parseJson, rowToMetadata, stringify, type ItemRow } from "../db/rows";
import { setItemActors } from "../db/actors";
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
    // 手工填的字段也要记来源: `field_sources` 只看 `nfo` 之外的来源来判"刮过没有",
    // 不记的话人手写的标题会被当成"还没刮", 下次批量刮削直接从头上盖掉。
    metadata.fieldSources[field] = "manual";
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
  // 走 setItemActors: 写 JSON 与建索引绑死, 不许分头做。
  if (options.patch?.actors !== undefined) {
    // patch 的值是 IPC 来的宽类型, 这里收窄成演员名数组
    const actors = Array.isArray(options.patch.actors)
      ? options.patch.actors.filter((name): name is string => typeof name === "string")
      : [];
    setItemActors(rt.db, options.key, actors);
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

/**
 * 手动改内容类型。
 *
 * 类型按设计是"建条目时落定、之后不可改"(它决定刮削路由与 `{content_type}`
 * 目录模板), 所以这个入口只给**人**用, 上面不挂任何自动流程 ——
 * 自动改类型只在 `scan` 里对"从没刮过网络"的条目做。
 */
export function retypeItem(rt: Runtime, number: string, contentType: string): { from: string; to: string } {
  if (!CONTENT_TYPES.includes(contentType as (typeof CONTENT_TYPES)[number])) {
    throw new AppError(`未知内容类型: ${contentType}`, EXIT.USAGE, { contentType, allowed: CONTENT_TYPES });
  }
  const row = rt.db.get<{ content_type: string }>("select content_type from items where number = ?", [number]);
  if (!row) throw new AppError(`没有这个条目: ${number}`, EXIT.NOT_FOUND, { number });
  if (row.content_type !== contentType) {
    rt.db.run("update items set content_type = ?, updated_at = unixepoch() where number = ?", [contentType, number]);
  }
  return { from: row.content_type, to: contentType };
}

export interface RetypeCandidate {
  number: string;
  from: string;
  to: string;
  /** 有标题 = 已经刮到过东西, 改类型会换来源线, 必须人确认。 */
  hasTitle: boolean;
}

/**
 * 按当前解析器重新判定所有条目的内容类型。
 *
 * 用途: 解析器修好了 bug (比如把 SSIS-915 判成国产), 但那些条目早已落库、
 * 类型不可自动改。默认只**列清单**, `apply` 才真的改 —— 因为类型还决定
 * `{content_type}` 目录模板, 改了之后下次整理会把文件挪到别的目录。
 */
export function detectRetypes(rt: Runtime, options: { apply?: boolean } = {}): RetypeCandidate[] {
  const rows = rt.db.all<{ number: string; content_type: string; title: string | null; path: string | null }>(
    `select i.number, i.content_type, i.title, (select path from media_files m where m.number = i.number limit 1) path
     from items i`,
  );
  const out: RetypeCandidate[] = [];
  for (const row of rows) {
    // 有文件路径就用路径当线索 (国产/素人线索常在目录名里), 没有就只看番号。
    const detected = detectContentType(row.number, row.path ?? "");
    if (!detected || detected === row.content_type) continue;
    out.push({ number: row.number, from: row.content_type, to: detected, hasTitle: Boolean(row.title) });
  }
  if (options.apply) {
    rt.db.exec("begin");
    try {
      for (const change of out) {
        rt.db.run("update items set content_type = ?, updated_at = unixepoch() where number = ?", [change.to, change.number]);
      }
      rt.db.exec("commit");
    } catch (err) {
      rt.db.exec("rollback");
      throw err;
    }
  }
  return out;
}
