import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";
import { countExhausted, countPending } from "../src/tasks/scrape";

/**
 * 守住"按库限定条目"那条查询的复杂度。
 *
 * 已知问题 #1 (B 站反馈"上万条目翻页假死") 的真因: `exists (… m.number = items.number
 * and m.library_id = ?)` 被优化器挑中只有 library_id 的索引, 于是 items 的每一行都要
 * 扫一遍这个库的全部 media_files —— 2 万条目 10.6 秒。
 *
 * 这里不测耗时(CI 机器快慢不一, 会变成 flaky), 而是直接断言查询计划: 计划里出现
 * 全表 SCAN media_files 就说明退化回 n×n 了。
 */

let root: string;
let rt: Runtime;
let libraryId: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-qplan-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
  libraryId = createLibrary(rt.db, { name: "库", root: join(root, "media"), domain: "video" }).id;

  rt.db.run("begin");
  for (let i = 0; i < 50; i++) {
    rt.db.run(
      `insert into items (number, content_type, title, plot, field_sources, domain, scrape_attempts)
       values (?, 'av', ?, '简介', '{}', 'av', ?)`,
      [`ABP-${String(i).padStart(3, "0")}`, `标题${i}`, i % 3 === 0 ? 5 : 0],
    );
    rt.db.run(`insert into media_files (path, library_id, number, size, mtime_ms) values (?, ?, ?, 1, 1)`, [
      `/m/${i}.mp4`,
      libraryId,
      `ABP-${String(i).padStart(3, "0")}`,
    ]);
  }
  rt.db.run("commit");
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

function plan(sql: string): string[] {
  return rt.db.all<{ detail: string }>(`explain query plan ${sql}`).map((row) => row.detail);
}

describe("按库限定条目的查询不许退化成全表扫", () => {
  test("media_files 上有 (library_id, number) 复合索引, 旧的单列索引已删", () => {
    const names = rt.db.all<{ name: string }>("pragma index_list(media_files)").map((row) => row.name);
    expect(names).toContain("media_files_library_number");
    // 单列索引是复合索引的前缀, 留着只会让写放大 + 让优化器再次挑错
    expect(names).not.toContain("media_files_library");
  });

  test("correlated exists 写法走覆盖索引, 不扫全表", () => {
    // 别的模块 (nfo-tv / scrape-show / rows) 还在用这个写法, 计划必须是对的
    const lines = plan(
      `select count(*) from items
       where exists (select 1 from media_files m where m.number = items.number and m.library_id = ${libraryId})`,
    );
    const joined = lines.join("\n");
    expect(joined).toContain("media_files_library_number");
    expect(joined).not.toContain("SCAN m");
  });

  test("countPending / countExhausted 的库过滤走 in 子查询, 不是逐行 exists", () => {
    const lines = plan(
      `select count(*) from items
       where content_type <> 'ugc' and scrape_attempts < 5
         and items.number in (select number from media_files where library_id = ${libraryId} and number is not null)`,
    );
    const joined = lines.join("\n");
    expect(joined).toContain("LIST SUBQUERY");
    expect(joined).toContain("media_files_library_number");
  });

  test("真调用能跑, 且库过滤真的在生效 (不是算全库)", () => {
    // 另一个库里的条目不该被算进这个库
    const other = createLibrary(rt.db, { name: "别的库", root: join(root, "media2"), domain: "video" }).id;
    rt.db.run(
      `insert into items (number, content_type, title, field_sources, domain) values ('OTHER-001', 'av', 'x', '{}', 'av')`,
    );
    rt.db.run(`insert into media_files (path, library_id, number, size, mtime_ms) values ('/o/1.mp4', ?, 'OTHER-001', 1, 1)`, [
      other,
    ]);

    const scoped = countPending(rt, { libraryId });
    const all = countPending(rt);
    expect(all).toBe(scoped + 1);
    expect(countExhausted(rt, { libraryId })).toBeLessThanOrEqual(scoped);
  });
});
