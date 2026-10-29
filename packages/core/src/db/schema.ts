import type { Db } from "./driver";

/**
 * 迁移用 `pragma user_version` 递增, 不引入迁移框架。
 * 规则: 只追加、不改已发布条目; 每条必须在旧库上幂等。
 *
 * v1 是脚手架时期的占位(以文件路径为主键), 已被 v2 的域模型取代。
 * 保留 v1 而不是删掉, 是为了让 v1 时期建过库的人也能线性升上来。
 */
const MIGRATIONS: string[] = [
  // v1 — 占位, 勿改
  `
  create table if not exists items (
    path     text primary key,
    size     integer not null,
    mtime_ms integer not null,
    sha256   text not null,
    seen_at  integer not null default (unixepoch())
  );
  `,

  // v2 — 真正的域模型: 条目以番号为身份, 文件是索引, 快照按 (条目, 来源) 存
  `
  drop table if exists items;

  create table libraries (
    id         integer primary key autoincrement,
    name       text not null unique,
    root       text not null,
    template   text not null default '{content_type}/{studio}/{number}',
    created_at integer not null default (unixepoch())
  );

  create table items (
    number        text primary key,
    content_type  text not null,
    title         text,
    plot          text,
    release_date  text,
    duration_min  integer,
    studio        text,
    label         text,
    series        text,
    directors     text,
    actors        text,
    tags          text,
    poster_urls   text,
    cover_urls    text,
    thumb_urls    text,
    field_sources text,
    pinned        text,
    updated_at    integer not null default (unixepoch())
  );

  create table media_files (
    path       text primary key,
    library_id integer not null references libraries(id) on delete cascade,
    number     text references items(number) on delete set null,
    size       integer not null,
    mtime_ms   integer not null,
    sha256     text,
    phase      text,
    seen_at    integer not null default (unixepoch())
  );
  create index if not exists media_files_number on media_files(number);
  create index if not exists media_files_library on media_files(library_id);

  create table snapshots (
    number     text not null,
    site       text not null,
    fields     text not null,
    fetched_at integer not null default (unixepoch()),
    primary key (number, site)
  );
  `,

  // v3 — 图片资源的本地缓存 (URL → 文件)。DB 是源, 文件是产物, 与 NFO 同一方向。
  `
  create table resources (
    url          text primary key,
    path         text not null,
    content_type text,
    size         integer not null,
    fetched_at   integer not null default (unixepoch())
  );
  `,

  // v4 — 库级"不整理"开关: 旧成品库只索引, 不允许移动/改名/写 NFO
  `
  alter table libraries add column organize_enabled integer not null default 1;
  `,

  // v5 — 翻译: 覆盖 title/plot 前先把原文存下来 (NFO originaltitle 与目录名都要用)
  `
  alter table items add column title_original text;
  alter table items add column plot_original text;
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
