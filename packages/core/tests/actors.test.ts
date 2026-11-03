import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/driver";
import { migrate } from "../src/db/schema";
import { backfillActors, pruneActors, syncItemActors } from "../src/db/actors";
import { normalizeActorName } from "../src/domain/actors";

describe("normalizeActorName", () => {
  test("空白不影响身份", () => {
    expect(normalizeActorName("吉沢 明歩")).toBe(normalizeActorName("吉沢明歩"));
    expect(normalizeActorName("吉沢　明歩")).toBe("吉沢明歩"); // 全角空格
  });

  test("全半角与大小写归一", () => {
    expect(normalizeActorName("ＡＫＩＲＡ")).toBe("akira");
    expect(normalizeActorName("ｱｷﾗ")).toBe("アキラ"); // 半角片假名
    expect(normalizeActorName("Yua Mikami")).toBe("yuamikami");
  });

  test("繁简/异体字**不**归并 —— 这是有意的", () => {
    expect(normalizeActorName("吉沢明歩")).not.toBe(normalizeActorName("吉澤明歩"));
  });
});

describe("演员索引", () => {
  let dir: string;

  async function freshDb() {
    dir = await mkdtemp(join(tmpdir(), "kura-actors-"));
    const { db } = await openDb(join(dir, "kura.db"));
    migrate(db);
    return db;
  }

  test("同一个人出现在多个条目里只占一行, 派生自 items.actors", async () => {
    const db = await freshDb();
    try {
      db.run("insert into items (number, content_type, actors) values ('AAA-001', 'censored', ?)", [
        JSON.stringify(["吉沢 明歩", "乙"]),
      ]);
      db.run("insert into items (number, content_type, actors) values ('AAA-002', 'censored', ?)", [
        JSON.stringify(["吉沢明歩"]),
      ]);
      syncItemActors(db, "AAA-001");
      syncItemActors(db, "AAA-002");

      const actors = db.all<{ name: string }>("select name from actors order by id");
      expect(actors.map((row) => row.name)).toEqual(["吉沢 明歩", "乙"]);

      // 两次出现都指向同一个演员
      const links = db.get<{ c: number }>("select count(*) c from item_actors");
      expect(links?.c).toBe(3);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("条目改了演员: 旧关联消失, 孤儿演员被清掉", async () => {
    const db = await freshDb();
    try {
      db.run("insert into items (number, content_type, actors) values ('AAA-001', 'censored', ?)", [
        JSON.stringify(["甲", "乙"]),
      ]);
      syncItemActors(db, "AAA-001");
      pruneActors(db);

      db.run("update items set actors = ? where number = 'AAA-001'", [JSON.stringify(["乙", "丙"])]);
      syncItemActors(db, "AAA-001");
      pruneActors(db);

      const names = db.all<{ name: string }>("select name from actors order by name");
      expect(names.map((row) => row.name)).toEqual(["丙", "乙"]);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("迁移会把历史条目的 actors JSON 回填进索引", async () => {
    dir = await mkdtemp(join(tmpdir(), "kura-actors-"));
    const { db } = await openDb(join(dir, "kura.db"));
    try {
      // 造一个 v7 形态的库: 有 items.actors, 但没有 actors / item_actors 表。
      // libraries / media_files 也要给: 真实 v7 库一定有 (v2/v3 建的), 而 v9 会 alter 它们。
      db.exec(`
        create table items (number text primary key, content_type text not null, actors text);
        create table libraries (
          id integer primary key autoincrement,
          name text not null unique,
          root text not null,
          template text not null default '',
          created_at integer not null default (unixepoch()),
          organize_enabled integer not null default 1
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
      `);
      db.run("insert into items (number, content_type, actors) values ('OLD-001', 'censored', ?)", [
        JSON.stringify(["甲", "乙"]),
      ]);
      db.exec("pragma user_version = 7");

      expect(migrate(db)).toBe(9);

      const actors = db.all<{ name: string }>("select name from actors order by name");
      expect(actors.map((row) => row.name)).toEqual(["乙", "甲"]);
      expect(db.get<{ c: number }>("select count(*) c from item_actors")?.c).toBe(2);

      // 幂等: 再跑一次不重复插
      backfillActors(db);
      expect(db.get<{ c: number }>("select count(*) c from actors")?.c).toBe(2);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
