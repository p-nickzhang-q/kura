import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/driver";
import { migrate } from "../src/db/schema";

let root: string;
let dbFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-mig-"));
  dbFile = join(root, "kura.db");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("迁移", () => {
  test("新库直接到最新版本, 且 libraries 带 organize_enabled", async () => {
    const { db } = await openDb(dbFile);
    try {
      const version = migrate(db);
      expect(version).toBe(10);

      const columns = db.all<{ name: string }>("pragma table_info(libraries)").map((row) => row.name);
      expect(columns).toContain("organize_enabled");

      const itemColumns = db.all<{ name: string }>("pragma table_info(items)").map((row) => row.name);
      expect(itemColumns).toContain("title_original");
      const taskColumns = db.all<{ name: string }>("pragma table_info(tasks)").map((row) => row.name);
      expect(taskColumns).toContain("owner_pid");
      expect(itemColumns).toContain("plot_original");

      db.run("insert into libraries (name, root) values ('主库', '/media')");
      const row = db.get<{ organize_enabled: number }>("select organize_enabled from libraries");
      expect(row?.organize_enabled).toBe(1);
    } finally {
      db.close();
    }
  });

  test("从 v3 升级: 补齐 v4/v5 的列且不丢数据", async () => {
    const { db } = await openDb(dbFile);
    try {
      // 手工造一个 v3 形态的库(只有 libraries 表, 没有 organize_enabled)
      db.exec(`
        create table libraries (
          id integer primary key autoincrement,
          name text not null unique,
          root text not null,
          template text not null default '{content_type}/{studio}/{number}',
          created_at integer not null default (unixepoch())
        );
        -- v5 会 alter items, 这里给个最小的 items 表
        create table items (number text primary key, content_type text not null);
        -- v9 会 alter media_files: 真实 v3 库一定有这张表(v2 建的)
        create table media_files (
          path text primary key,
          library_id integer not null,
          number text,
          size integer not null,
          mtime_ms integer not null,
          sha256 text,
          phase text,
          seen_at integer not null default (unixepoch())
        );
      `);
      db.run("insert into libraries (name, root) values ('老库', '/old')");
      db.exec("pragma user_version = 3");

      expect(migrate(db)).toBe(10);
      const row = db.get<{ name: string; organize_enabled: number }>(
        "select name, organize_enabled from libraries",
      );
      expect(row?.name).toBe("老库");
      expect(row?.organize_enabled).toBe(1);
    } finally {
      db.close();
    }
  });

  test("拒绝用旧版打开新版建的库 (降级保护)", async () => {
    const { db } = await openDb(dbFile);
    try {
      migrate(db);
      db.exec("pragma user_version = 99");
      expect(() => migrate(db)).toThrow(/更新的版本建的/);
    } finally {
      db.close();
    }
  });

  test("重复 migrate 是幂等的", async () => {
    const { db } = await openDb(dbFile);
    try {
      migrate(db);
      expect(migrate(db)).toBe(10);
      expect(migrate(db)).toBe(10);
    } finally {
      db.close();
    }
  });

  test("v9 影视域: 列与新表就位, 老库所有行默认 av (纯加法)", async () => {
    const { db } = await openDb(dbFile);
    try {
      // 造一个 v8 形态的库并放一条真实条目, 再升到 9 —— 模拟真机 3883 条的老库
      db.exec(`
        create table libraries (
          id integer primary key autoincrement,
          name text not null unique,
          root text not null,
          template text not null default '',
          created_at integer not null default (unixepoch()),
          organize_enabled integer not null default 1
        );
        create table items (
          number text primary key,
          content_type text not null,
          title text,
          title_original text,
          plot_original text,
          scrape_attempts integer not null default 0,
          last_error text
        );
        create table media_files (
          path text primary key,
          library_id integer not null,
          number text,
          size integer not null,
          mtime_ms integer not null,
          sha256 text,
          phase text,
          seen_at integer not null default (unixepoch())
        );
        create table actors (
          id integer primary key autoincrement,
          name text not null,
          normalized text not null unique
        );
      `);
      db.run("insert into libraries (name, root) values ('老库', '/old')");
      db.run("insert into items (number, content_type, title) values ('SSIS-915', 'censored', '旧标题')");
      db.run("insert into actors (name, normalized) values ('三上悠亜', '三上悠亜')");
      db.run("insert into media_files (path, library_id, number, size, mtime_ms) values ('/old/a.mp4', 1, 'SSIS-915', 1, 1)");
      db.exec("pragma user_version = 8");

      expect(migrate(db)).toBe(10);

      // 域列: 老数据全部落在 av 域
      expect(db.get<{ domain: string }>("select domain from libraries")?.domain).toBe("av");
      expect(db.get<{ domain: string }>("select domain from items where number = 'SSIS-915'")?.domain).toBe("av");
      expect(db.get<{ domain: string }>("select domain from actors")?.domain).toBe("av");

      // 老行一个不丢, 字段原样
      const item = db.get<{ title: string; content_type: string }>("select title, content_type from items where number = 'SSIS-915'");
      expect(item?.title).toBe("旧标题");
      expect(item?.content_type).toBe("censored");

      // 集的两个列默认 null (av 域没有集)
      const file = db.get<{ season: number | null; episode: number | null }>("select season, episode from media_files");
      expect(file?.season).toBeNull();
      expect(file?.episode).toBeNull();

      // 集表可用, 且级联删除跟着条目走
      db.run("insert into episodes (number, season, episode, title) values ('SSIS-915', 1, 1, '第一集')");
      expect(db.get<{ title: string }>("select title from episodes")?.title).toBe("第一集");
      db.run("delete from items where number = 'SSIS-915'");
      expect(db.get<{ n: number }>("select count(*) as n from episodes")?.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
