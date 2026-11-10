import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";
import { bindDirectory } from "../src/tasks/bind";
import { repairIndexPaths } from "../src/tasks/repair";
import { scan } from "../src/tasks/scan";

let root: string;
let media: string;
let rt: Runtime;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-repair-"));
  media = join(root, "库");
  await mkdir(media, { recursive: true });
  rt = await openRuntime({ dataDir: join(root, "data") });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

async function touch(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x");
}

describe("修复'文件搬走了但索引没跟上'", () => {
  test("文件已经被搬到整理后的位置时, 按计划把 path 改过去", async () => {
    // 源目录里的文件早就被搬走了(模拟旧版整理/中途崩), 只剩索引还指着旧路径
    await touch(join(media, "movie", "2013-5-15", "[迅雷]亡灵.DVD.rmvb"));
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });
    // 手工绑成电影(没有 TMDB 就用手工身份会走另一条路, 这里直接写索引)
    rt.db.run("insert or ignore into items (number, content_type, domain, title, release_date) values (?,?,?,?,?)", [
      "tmdb:movie:79896",
      "",
      "movie",
      "亡灵",
      "2009-08-16",
    ]);
    const oldPath = join(media, "movie", "2013-5-15", "[迅雷]亡灵.DVD.rmvb");
    rt.db.run("update media_files set number = ? where path = ?", ["tmdb:movie:79896", oldPath]);
    // 影片其实已经在整理后的位置了
    const newPath = join(media, "亡灵 (2009)", "亡灵 (2009).rmvb");
    await rm(oldPath);
    await touch(newPath);
    await writeFile(join(media, "movie", "2013-5-15", "[迅雷]亡灵.DVD.nfo"), "<movie/>");

    const dry = await repairIndexPaths(rt, { libraryId: library.id });
    expect(dry.dryRun).toBe(true);
    expect(dry.repaired).toHaveLength(1);
    expect(dry.repaired[0]!.to).toBe(newPath);
    // 干跑不动索引
    expect(rt.db.get<{ path: string }>("select path from media_files")?.path).toBe(oldPath);

    const applied = await repairIndexPaths(rt, { libraryId: library.id, apply: true });
    expect(applied.repaired).toHaveLength(1);
    expect(rt.db.get<{ path: string }>("select path from media_files")?.path).toBe(newPath);
    // 旧位置那份没人读的 nfo 顺手删掉
    expect(existsSync(join(media, "movie", "2013-5-15", "[迅雷]亡灵.DVD.nfo"))).toBe(false);
  });

  test("两个位置都在: 当成重复, 不自动动", async () => {
    await touch(join(media, "movie", "旧", "亡灵.rmvb"));
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });
    rt.db.run("insert or ignore into items (number, content_type, domain, title, release_date) values (?,?,?,?,?)", [
      "tmdb:movie:79896",
      "",
      "movie",
      "亡灵",
      "2009-08-16",
    ]);
    rt.db.run("update media_files set number = ? where path like ?", ["tmdb:movie:79896", join(media, "movie", "%")]);
    await touch(join(media, "亡灵 (2009)", "亡灵 (2009).rmvb"));

    const report = await repairIndexPaths(rt, { libraryId: library.id, apply: true });
    expect(report.repaired).toHaveLength(0);
    expect(report.ambiguous).toHaveLength(1);
  });

  test("文件真丢了: 报出来, 让扫描去清", async () => {
    await touch(join(media, "movie", "旧", "亡灵.rmvb"));
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });
    rt.db.run("insert or ignore into items (number, content_type, domain, title, release_date) values (?,?,?,?,?)", [
      "tmdb:movie:79896",
      "",
      "movie",
      "亡灵",
      "2009-08-16",
    ]);
    rt.db.run("update media_files set number = ? where path like ?", ["tmdb:movie:79896", join(media, "movie", "%")]);
    await rm(join(media, "movie", "旧", "亡灵.rmvb"));

    const report = await repairIndexPaths(rt, { libraryId: library.id, apply: true });
    expect(report.repaired).toHaveLength(0);
    expect(report.missing).toHaveLength(1);
  });
});
