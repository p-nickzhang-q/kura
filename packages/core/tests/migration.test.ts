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
      expect(version).toBe(4);

      const columns = db.all<{ name: string }>("pragma table_info(libraries)").map((row) => row.name);
      expect(columns).toContain("organize_enabled");

      db.run("insert into libraries (name, root) values ('主库', '/media')");
      const row = db.get<{ organize_enabled: number }>("select organize_enabled from libraries");
      expect(row?.organize_enabled).toBe(1);
    } finally {
      db.close();
    }
  });

  test("从 v3 升级: 补列且不丢数据", async () => {
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
      `);
      db.run("insert into libraries (name, root) values ('老库', '/old')");
      db.exec("pragma user_version = 3");

      expect(migrate(db)).toBe(4);
      const row = db.get<{ name: string; organize_enabled: number }>(
        "select name, organize_enabled from libraries",
      );
      expect(row?.name).toBe("老库");
      expect(row?.organize_enabled).toBe(1);
    } finally {
      db.close();
    }
  });

  test("重复 migrate 是幂等的", async () => {
    const { db } = await openDb(dbFile);
    try {
      migrate(db);
      expect(migrate(db)).toBe(4);
      expect(migrate(db)).toBe(4);
    } finally {
      db.close();
    }
  });
});
