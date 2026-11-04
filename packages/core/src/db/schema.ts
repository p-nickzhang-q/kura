import type { Db } from "./driver";
import { backfillActors, repairActorData } from "./actors";
import { AppError, EXIT } from "../exit";

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

  // v6 — 持久化任务: 关掉软件后仍能看到"上次跑到 37/200, 中断了"
  `
  create table tasks (
    id          integer primary key autoincrement,
    type        text not null,
    status      text not null,
    payload     text not null default '{}',
    total       integer not null default 0,
    processed   integer not null default 0,
    failed      integer not null default 0,
    error       text,
    created_at  integer not null default (unixepoch()),
    started_at  integer,
    finished_at integer,
    owner_pid   integer
  );
  create index if not exists tasks_status on tasks(status, id);
  `,

  // v7 — 失败重试计数: 没抓到标题的条目不能永远躺在待刮队列里被反复重试
  `
  alter table items add column scrape_attempts integer not null default 0;
  alter table items add column last_error text;
  `,

  // v8 — 演员一等实体: items.actors 仍是快照(JSON), 这里是它派生出的索引
  `
  create table actors (
    id         integer primary key autoincrement,
    name       text not null,
    normalized text not null unique
  );

  create table item_actors (
    number   text not null references items(number) on delete cascade,
    actor_id integer not null references actors(id) on delete cascade,
    position integer not null default 0,
    primary key (number, actor_id)
  );
  create index if not exists item_actors_actor on item_actors(actor_id);
  `,

  // v9 — 影视域 (ADR 0008): 域挂在库上, 条目冗余一列省 join; 剧的集自成一表;
  // 演员按域标记(同一个演员两边都会出现, 但 [演员] 维度只对 av 有意义)。
  // 纯加法: 老库升级后所有行 domain 都是 'av', av 域行为逐字不变。
  `
  alter table libraries add column domain text not null default 'av';
  alter table items add column domain text not null default 'av';
  alter table actors add column domain text not null default 'av';
  alter table media_files add column season integer;
  alter table media_files add column episode integer;

  create table episodes (
    number       text not null references items(number) on delete cascade,
    season       integer not null default 1,
    episode      integer not null,
    title        text,
    plot         text,
    air_date     text,
    duration_min integer,
    field_sources text,
    primary key (number, season, episode)
  );
  `,

  // v10 — 修演员索引的两处历史漂移 (纯数据修复, 不改表结构):
  //  1. 占位文本 (未知演员 / N/A) 被当成演员存进了 items.actors
  //  2. 0.6.11 从 nfo 读演员时只写了 JSON 没建索引, 那些条目的演员在筛选里不存在
  // 升级即自愈, 不需要用户跑任何命令。
  // 纯数据修复, 没有 SQL: 具体动作在 AFTER_MIGRATIONS[10]
  ``,

  // v11 — 库域合并 (ADR 0009): 电影与剧集合成一个 video 域。
  // 条目类型(电影/剧集)已经在身份键里(tmdb:movie: / tmdb:tv:), 库不必再分两种 ——
  // 而且 media_files.path 是主键, 一个文件只能属于一个库, 同根两库本来就做不到。
  `
  update libraries set domain = 'video' where domain in ('movie', 'tv');
  `,
];

/**
 * 迁移之后需要跑代码的步骤 (SQL 做不了的: NFKC 规范化)。
 * 键是**目标版本号**, 只在该版本刚被应用时执行一次。
 */
const AFTER_MIGRATIONS: Record<number, (db: Db) => void> = {
  8: (db) => backfillActors(db),
  10: (db) => repairActorData(db),
};

export function migrate(db: Db): number {
  const row = db.get<{ user_version: number }>("pragma user_version");
  const from = row?.user_version ?? 0;

  // 降级: 装了旧版去开新版建的库。旧代码不认识新列, 继续跑会写出半残数据 —— 宁可拒绝。
  if (from > MIGRATIONS.length) {
    throw new AppError(
      `数据库是这个程序更新的版本建的 (schema v${from}, 当前支持到 v${MIGRATIONS.length})。请装回新版, 不要用旧版打开。`,
      EXIT.NEEDS_INPUT,
      { schemaVersion: from, supported: MIGRATIONS.length },
    );
  }

  for (let v = from; v < MIGRATIONS.length; v++) {
    db.exec("begin");
    try {
      // 只有代码动作的版本 (纯数据修复) 没有 SQL, 空串不能丢给 exec
      const sql = MIGRATIONS[v] ?? "";
      if (sql.trim() !== "") db.exec(sql);
      AFTER_MIGRATIONS[v + 1]?.(db);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }
  return MIGRATIONS.length;
}