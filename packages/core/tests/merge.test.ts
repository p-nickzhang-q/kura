import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeItems } from "../src/tasks/merge";
import { openRuntime, type Runtime } from "../src/runtime";

let rt: Runtime;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kura-merge-"));
  rt = await openRuntime({ dataDir: dir });
});

afterEach(async () => {
  rt.close();
  await rm(dir, { recursive: true, force: true });
});

function seed(): void {
  // media_files.library_id 有外键, 先建库
  rt.db.run("insert into libraries (id, name, root, template, domain) values (1, '视频', 'Z:\\视频', '{series}', 'video')");
  rt.db.run("insert into items (number, content_type, domain, title) values ('tmdb:movie:422153', '', 'movie', '绿巨人与怪物')");
  rt.db.run("insert into items (number, content_type, domain, title) values ('local:绿巨人与怪物', 'ugc', 'movie', '绿巨人与怪物')");
  // local 条目占着 cd3, tmdb 条目占着正片
  for (const [path, number] of [
    ["Z:\\视频\\movie\\绿巨人-cd3.rmvb", "local:绿巨人与怪物"],
    ["Z:\\视频\\绿巨人与怪物 (2016)\\绿巨人与怪物 (2016).rmvb", "tmdb:movie:422153"],
  ] as const) {
    rt.db.run("insert into media_files (path, library_id, number, size, mtime_ms) values (?, 1, ?, 1, 1)", [path, number]);
  }
}

describe("合并条目", () => {
  test("本地条目的文件并进 TMDB 条目, 原条目删掉", () => {
    seed();
    const result = mergeItems(rt, { from: "local:绿巨人与怪物", into: "tmdb:movie:422153" });
    expect(result.moved).toBe(1);
    expect(result.removed).toBe(true);

    expect(rt.db.get("select 1 from items where number = 'local:绿巨人与怪物'")).toBeFalsy();
    const files = rt.db.all<{ path: string }>("select path from media_files where number = 'tmdb:movie:422153' order by path");
    expect(files.length).toBe(2);
    expect(files.some((row) => row.path.includes("cd3"))).toBe(true);
  });

  test("目标不存在 / 是同一个 / 有待集数据都不该乱来", () => {
    seed();
    expect(() => mergeItems(rt, { from: "local:绿巨人与怪物", into: "tmdb:movie:999" })).toThrow(/条目不存在/);
    expect(() => mergeItems(rt, { from: "local:绿巨人与怪物", into: "local:绿巨人与怪物" })).toThrow(/同一个/);
    // 失败了就什么都没动
    expect(rt.db.get("select 1 from items where number = 'local:绿巨人与怪物'")).toBeTruthy();
  });

  test("剧集条目拒绝合并(季集要重排, v1 不做)", () => {
    rt.db.run("insert into items (number, content_type, domain, title) values ('tmdb:tv:1', '', 'tv', '某剧')");
    rt.db.run("insert into items (number, content_type, domain, title) values ('local:某剧', 'ugc', 'tv', '某剧')");
    expect(() => mergeItems(rt, { from: "local:某剧", into: "tmdb:tv:1" })).toThrow(/只能合并电影/);
  });
});
