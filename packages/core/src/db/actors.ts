/**
 * 演员索引的落库层。
 *
 * `items.actors` 仍是**快照**的一部分 (JSON 数组), 这里维护的是从它派生的实体索引:
 * 同样的演员名在多个条目里出现时只占一行 actors 记录, 于是"点演员看全部作品"是一次 join。
 *
 * 派生关系是单向的: 索引永远由 `items.actors` 重建, 反向不写回。
 * 这样快照仍是唯一真源, 索引坏了重扫一次就自愈。
 */
import type { Db } from "./driver";
import { normalizeActorName, isPlaceholderActor, sanitizeActorNames } from "../domain/actors";

/** 从 `items.actors` 重建该条目的演员关联。 */
export function syncItemActors(db: Db, number: string): void {
  const row = db.get<{ actors: string | null }>("select actors from items where number = ?", [number]);

  db.run("delete from item_actors where number = ?", [number]);
  if (!row?.actors) return;

  let names: unknown;
  try {
    names = JSON.parse(row.actors);
  } catch {
    return;
  }
  if (!Array.isArray(names)) return;

  const linked = new Set<number>();
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    // 占位文本 (未知演员 / N/A / ---) 不是演员: 老数据里混进来的在这里挡住。
    if (isPlaceholderActor(name)) continue;
    const normalized = normalizeActorName(name);
    if (!normalized) continue;

    // 首次出现的写法作为显示名; 之后只补关联, 不改名 —— 显示名漂移会让列表看起来在随机变化。
    db.run("insert or ignore into actors (name, normalized) values (?, ?)", [name, normalized]);
    const actor = db.get<{ id: number }>("select id from actors where normalized = ?", [normalized]);
    if (!actor || linked.has(actor.id)) continue;
    linked.add(actor.id);
    db.run("insert or ignore into item_actors (number, actor_id, position) values (?, ?, ?)", [
      number,
      actor.id,
      linked.size - 1,
    ]);
  }
}

/** 上一次重建留下的孤儿演员 (条目改了演员后就没人指向它)。 */
export function pruneActors(db: Db): void {
  db.run("delete from actors where id not in (select actor_id from item_actors)");
}

/**
 * 写 `items.actors` 的唯一入口: 写 JSON 与重建索引是**一件事**, 不许分头做。
 *
 * 分头的后果是真实的: 0.6.11 从 nfo 读演员时只写了 JSON, 索引没建, 于是那 76 条条目的
 * 演员在"点演员看全部"里根本不存在 (搜「真琴」搜不到)。所以写值只准走这里。
 */
export function setItemActors(db: Db, number: string, names: readonly string[]): void {
  db.run("update items set actors = ?, updated_at = unixepoch() where number = ?", [
    JSON.stringify(sanitizeActorNames(names)),
    number,
  ]);
  syncItemActors(db, number);
  pruneActors(db);
}

/**
 * 索引漂移自检: 有条目的 `items.actors` 里存在、但索引里没有关联的演员名个数。
 *
 * 正常情况下永远是 0。非 0 说明有代码路径绕过了 `setItemActors` / `syncItemActors`,
 * 这是"数据结构被绕开"的信号, 不该静默留在库里。
 */
export function actorIndexDrift(db: Db): number {
  // 比较必须在**规范化后**做: 同一个人的两种写法 (HITOMI / Hitomi) 只占一行 actors,
  // 按显示名逐字比会把正常的关联误报成漂移。
  const linked = new Map<string, Set<string>>();
  for (const row of db.all<{ number: string; normalized: string }>(
    "select ia.number as number, a.normalized as normalized from item_actors ia join actors a on a.id = ia.actor_id",
  )) {
    const set = linked.get(row.number) ?? new Set<string>();
    set.add(row.normalized);
    linked.set(row.number, set);
  }

  let drift = 0;
  for (const row of db.all<{ number: string; actors: string | null }>(
    "select number, actors from items where actors is not null and actors <> ''",
  )) {
    let names: unknown;
    try {
      names = JSON.parse(row.actors ?? "");
    } catch {
      continue;
    }
    if (!Array.isArray(names)) continue;
    const have = linked.get(row.number);
    for (const raw of names) {
      if (typeof raw !== "string") continue;
      const name = raw.trim();
      if (isPlaceholderActor(name)) continue;
      const normalized = normalizeActorName(name);
      if (!normalized) continue;
      if (!have?.has(normalized)) drift++;
    }
  }
  return drift;
}

/**
 * 迁移用: 把历史条目的 `items.actors` JSON 一次性拆进索引。
 *
 * 放在迁移里而不是懒回填, 是因为懒回填会让"同一份数据两种来源"长期并存:
 * 有的条目靠索引、有的靠 JSON, 查询就得写两套。条目只有几百条, 一次拆完最省心。
 */
export function backfillActors(db: Db): void {
  // 手造的/残缺的老库可能连 actors 列都没有, 迁移不该因此崩掉。
  const columns = db.all<{ name: string }>("pragma table_info(items)");
  if (!columns.some((column) => column.name === "actors")) return;

  const rows = db.all<{ number: string; actors: string | null }>(
    "select number, actors from items where actors is not null and actors <> ''",
  );
  for (const row of rows) syncItemActors(db, row.number);
  pruneActors(db);
}

/**
 * 迁移 v10 用: 清掉历史数据里的占位演员名, 再全量重建索引。
 *
 * 只跑一次, 但必须能重复跑 —— 迁移就是会被重放的东西。
 */
export function repairActorData(db: Db): void {
  const columns = db.all<{ name: string }>("pragma table_info(items)");
  if (!columns.some((column) => column.name === "actors")) return;

  const rows = db.all<{ number: string; actors: string }>(
    "select number, actors from items where actors is not null and actors <> ''",
  );
  for (const row of rows) {
    let names: unknown;
    try {
      names = JSON.parse(row.actors);
    } catch {
      continue;
    }
    if (!Array.isArray(names)) continue;
    const cleaned = sanitizeActorNames(names.filter((name): name is string => typeof name === "string"));
    const next = JSON.stringify(cleaned);
    if (next !== row.actors) db.run("update items set actors = ? where number = ?", [next, row.number]);
  }

  backfillActors(db);
}
