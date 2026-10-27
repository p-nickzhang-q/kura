import type { Db } from "./driver";

/**
 * 迁移用 `pragma user_version` 做版本号, 不引入迁移框架。
 * 规则: 只追加, 不修改已发布的条目; 每个条目必须在旧库上是幂等的。
 */
const MIGRATIONS: string[] = [
  // v1
  `
  create table if not exists items (
    path       text primary key,
    size       integer not null,
    mtime_ms   integer not null,
    sha256     text not null,
    seen_at    integer not null default (unixepoch())
  );
  create index if not exists items_sha256 on items(sha256);
  `,
];

export function migrate(db: Db): number {
  const row = db.get<{ user_version: number }>("pragma user_version");
  const from = row?.user_version ?? 0;

  for (let v = from; v < MIGRATIONS.length; v++) {
    db.exec("begin");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }
  return MIGRATIONS.length;
}
