import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";
import {
  bindDirectory,
  countBindableDirs,
  listBindableDirs,
  rebindItem,
  listItemDirs,
  setDirectorySeason,
  setFileEpisode,
  unbindDirectory,
} from "../src/tasks/bind";
import { listFiles, scan } from "../src/tasks/scan";
import { AppError } from "../src/exit";

let root: string;
let rt: Runtime;
let media: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-bind-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
  media = join(root, "media");
  await mkdir(media, { recursive: true });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

async function makeShow(relative: string, files: string[]): Promise<string> {
  const dir = join(media, relative);
  await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(join(dir, file), "x");
  return dir;
}

describe("待绑定目录清单", () => {
  test("一个季目录 3 个文件 → 一个候选 (剧目录是它的上一层)", async () => {
    await makeShow("某剧 (2019)/Season 01", ["某剧 - S01E01.mkv", "某剧 - S01E02.mkv", "某剧 - S01E03.mkv"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });

    const dirs = listBindableDirs(rt, { libraryId: library.id });
    expect(dirs).toHaveLength(1);
    expect(dirs[0]?.name).toBe("某剧 (2019)");
    expect(dirs[0]?.files).toBe(3);
    expect(dirs[0]?.parsed).toBe(3);
    expect(dirs[0]?.seasons).toEqual([1]);
    expect(countBindableDirs(rt, { libraryId: library.id })).toBe(1);
  });

  test("认不出集号的文件也算进它所在目录, 并拉低 parsed", async () => {
    await makeShow("某剧", ["第1集.mp4", "花絮片段.mp4"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });

    const dirs = listBindableDirs(rt, { libraryId: library.id });
    expect(dirs[0]?.files).toBe(2);
    expect(dirs[0]?.parsed).toBe(1);
  });
});

describe("目录级绑定", () => {
  test("绑 12 个文件: 建条目 + 建集 + 文件全部有身份", async () => {
    const dir = join(media, "某剧", "Season 01");
    await makeShow(
      "某剧/Season 01",
      Array.from({ length: 12 }, (_, i) => `某剧 - S01E${String(i + 1).padStart(2, "0")}.mkv`),
    );
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });

    const result = bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:1399" });
    expect(result.key).toBe("tmdb:tv:1399");
    expect(result.bound).toBe(12);
    expect(result.episodes).toBe(12);
    expect(result.stillUnparsed).toEqual([]);

    const item = rt.db.get<{ number: string; domain: string; content_type: string }>(
      "select number, domain, content_type from items",
    );
    expect(item?.number).toBe("tmdb:tv:1399");
    expect(item?.domain).toBe("tv");
    // 影视条目没有内容类型 (列是 NOT NULL, 用空串)
    expect(item?.content_type).toBe("");

    const episodes = rt.db.all<{ season: number; episode: number }>(
      "select season, episode from episodes where number = 'tmdb:tv:1399' order by episode",
    );
    expect(episodes).toHaveLength(12);
    expect(episodes[11]).toEqual({ season: 1, episode: 12 });

    // 绑完就不再是"未识别"
    expect(listFiles(rt, { libraryId: library.id, unparsedOnly: true })).toHaveLength(0);
    expect(countBindableDirs(rt, { libraryId: library.id })).toBe(0);
    expect(dir.length).toBeGreaterThan(0);
  });

  test("干跑不写库", async () => {
    await makeShow("某剧", ["第1集.mp4", "第2集.mp4"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });

    const dry = bindDirectory(rt, {
      libraryId: library.id,
      dir: join(media, "某剧"),
      key: "tmdb:tv:42",
      dryRun: true,
    });
    expect(dry.bound).toBe(2);
    expect(rt.db.get<{ c: number }>("select count(*) c from items")?.c).toBe(0);
    expect(listFiles(rt, { libraryId: library.id, unparsedOnly: true })).toHaveLength(2);
  });

  test("认不出集号的文件绑了目录也留着, 等 set-episode", async () => {
    await makeShow("某剧", ["第1集.mp4", "特典映像.mp4"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });

    const result = bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:7" });
    expect(result.bound).toBe(2);
    expect(result.episodes).toBe(1);
    expect(result.stillUnparsed).toHaveLength(1);
    // 文件有了身份(不再进未识别), 但没有集号
    const files = listFiles(rt, { libraryId: library.id });
    expect(files.every((file) => file.number === "tmdb:tv:7")).toBe(true);
  });

  test("影视库里绑电影 id 是合法的 (类型来自身份键)", async () => {
    await makeShow("某电影", ["某电影 (2019).mkv"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const result = bindDirectory(rt, { libraryId: library.id, dir: join(media, "某电影"), key: "tmdb:movie:603" });
    expect(result.bound).toBe(1);
    // 电影没有集号是正常的, 不该被算成"还缺集号"
    expect(result.stillUnparsed).toEqual([]);
    const item = rt.db.get<{ domain: string }>("select domain from items where number = 'tmdb:movie:603'");
    expect(item?.domain).toBe("movie");
    // 电影没有集
    expect(rt.db.get<{ c: number }>("select count(*) c from episodes")?.c).toBe(0);
  });

  test("番号制库不能绑 TMDB 身份", async () => {
    await makeShow("某剧", ["第1集.mp4"]);
    const library = createLibrary(rt.db, { name: "番号库", root: media, domain: "av" });
    await scan(rt, { library });
    expect(() =>
      bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:1" }),
    ).toThrow(/番号制库不能绑定 TMDB/);
  });

  test("不是 TMDB 身份直接拒", async () => {
    await makeShow("某剧", ["第1集.mp4"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });
    expect(() => bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "SSIS-915" })).toThrow(
      /不是 TMDB 身份/,
    );
  });

  test("已经绑过的文件不会被静默改绑", async () => {
    await makeShow("某剧", ["第1集.mp4", "第2集.mp4"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:1" });

    expect(() =>
      bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:2" }),
    ).toThrow(/没有待绑定的文件/);
    expect(rt.db.get<{ c: number }>("select count(*) c from items")?.c).toBe(1);
  });

  test("重扫不会把已绑定的文件打回未识别 (扫描不碰 number)", async () => {
    await makeShow("某剧", ["第1集.mp4", "第2集.mp4"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:5" });

    const again = await scan(rt, { library });
    expect(again.counts.unchanged).toBe(2);
    expect(listFiles(rt, { libraryId: library.id }).every((file) => file.number === "tmdb:tv:5")).toBe(true);
    expect(countBindableDirs(rt, { libraryId: library.id })).toBe(0);
  });

  test("解绑退回未识别; 条目没人指向时删掉", async () => {
    await makeShow("某剧", ["第1集.mp4", "第2集.mp4"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:1" });

    expect(unbindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧") })).toBe(2);
    expect(listFiles(rt, { libraryId: library.id, unparsedOnly: true })).toHaveLength(2);
    expect(rt.db.get<{ c: number }>("select count(*) c from items")?.c).toBe(0);
    // 集跟着条目级联删除
    expect(rt.db.get<{ c: number }>("select count(*) c from episodes")?.c).toBe(0);
  });
});

describe("手工补集号", () => {
  test("绑定后给认不出的文件指定集号, 集行跟着长出来", async () => {
    await makeShow("某剧", ["第1集.mp4", "特典映像.mp4"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });
    const bound = bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:9" });

    const target = bound.stillUnparsed[0]!;
    const result = setFileEpisode(rt, { path: target, season: 1, episode: 2 });
    expect(result.number).toBe("tmdb:tv:9");

    const episodes = rt.db.all<{ episode: number }>(
      "select episode from episodes where number = 'tmdb:tv:9' order by episode",
    );
    expect(episodes.map((row) => row.episode)).toEqual([1, 2]);
  });

  test("文件不在索引里报 NOT_FOUND", () => {
    expect(() => setFileEpisode(rt, { path: join(media, "nope.mp4"), episode: 1 })).toThrow(AppError);
  });

  test("集号必须是正整数", async () => {
    await makeShow("某剧", ["第1集.mp4"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });
    const path = listFiles(rt, { libraryId: library.id })[0]!.path;
    expect(() => setFileEpisode(rt, { path, episode: 0 })).toThrow(/正整数/);
  });
});

describe("改绑", () => {
  test("把已绑定条目的文件转到新身份, 旧条目清掉", async () => {
    await makeShow("某剧", ["第1集.mp4", "第2集.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:1" });
    expect(rt.db.get<{ c: number }>("select count(*) c from items where number = 'tmdb:tv:1'")?.c).toBe(1);

    const result = rebindItem(rt, { key: "tmdb:tv:1", newKey: "tmdb:tv:2" });
    expect(result.moved).toBe(2);
    expect(result.bound?.episodes).toBe(2);

    // 旧条目与它的集没了
    expect(rt.db.get<{ c: number }>("select count(*) c from items where number = 'tmdb:tv:1'")?.c).toBe(0);
    expect(rt.db.get<{ c: number }>("select count(*) c from episodes where number = 'tmdb:tv:1'")?.c).toBe(0);
    // 新条目接住了文件与集
    expect(rt.db.get<{ c: number }>("select count(*) c from items where number = 'tmdb:tv:2'")?.c).toBe(1);
    expect(rt.db.get<{ c: number }>("select count(*) c from episodes where number = 'tmdb:tv:2'")?.c).toBe(2);
    const numbers = rt.db.all<{ number: string }>("select number from media_files");
    expect(numbers.every((row) => row.number === "tmdb:tv:2")).toBe(true);
  });

  test("新旧身份相同时报错", async () => {
    await makeShow("某剧", ["第1集.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:1" });
    expect(() => rebindItem(rt, { key: "tmdb:tv:1", newKey: "tmdb:tv:1" })).toThrow(/新旧身份相同/);
  });

  test("没有文件的条目无从改绑", () => {
    expect(() => rebindItem(rt, { key: "tmdb:tv:9", newKey: "tmdb:tv:10" })).toThrow(/没有登记到任何文件/);
  });
});

describe("同一部剧拆成多个目录", () => {
  test("第二个目录可以绑到同一身份并指定为第 2 季", async () => {
    await makeShow("仁医", ["仁医 - 第1集.mp4", "仁医 - 第2集.mp4"]);
    await makeShow("仁医2", ["仁医2 - 第1集.mp4", "仁医2 - 第2集.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    bindDirectory(rt, { libraryId: library.id, dir: join(media, "仁医"), key: "tmdb:tv:46198" });
    // 关键: 第二个目录绑同一身份, 但显式指定第 2 季
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "仁医2"), key: "tmdb:tv:46198", season: 2 });

    const rows = rt.db.all<{ season: number; episode: number }>(
      "select season, episode from media_files where number = 'tmdb:tv:46198' order by season, episode",
    );
    expect(rows).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
      { season: 2, episode: 1 },
      { season: 2, episode: 2 },
    ]);
    // 没有重复的 (季, 集)
    const dup = rt.db.get<{ n: number }>(
      `select count(*) as n from (select season, episode, count(*) c from media_files
        where number = 'tmdb:tv:46198' group by season, episode having c > 1)`,
    );
    expect(dup?.n).toBe(0);
  });

  test("setDirectorySeason: 已绑错季的目录可以整体改季", async () => {
    await makeShow("A", ["A - 第1集.mp4", "A - 第2集.mp4"]);
    await makeShow("B", ["B - 第1集.mp4", "B - 第2集.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    // 两个目录都绑成同一部剧, 季号都没指定 → 全落在第 1 季
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "A"), key: "tmdb:tv:7" });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "B"), key: "tmdb:tv:7" });
    expect(rt.db.get<{ n: number }>("select count(*) as n from media_files where season = 2")?.n).toBe(0);

    const result = setDirectorySeason(rt, { dir: join(media, "B"), season: 2, key: "tmdb:tv:7" });
    expect(result.files).toBe(2);
    expect(result.season).toBe(2);
    expect(rt.db.get<{ n: number }>("select count(*) as n from media_files where season = 2")?.n).toBe(2);
    // 集行跟着补出来
    expect(rt.db.get<{ n: number }>("select count(*) as n from episodes where number = 'tmdb:tv:7' and season = 2")?.n).toBe(2);
  });

  test("listItemDirs: 列出这个条目的来源文件夹", async () => {
    await makeShow("A", ["A - 第1集.mp4"]);
    await makeShow("B", ["B - 第1集.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "A"), key: "tmdb:tv:8" });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "B"), key: "tmdb:tv:8", season: 2 });

    const dirs = listItemDirs(rt, "tmdb:tv:8");
    expect(dirs.map((dir) => dir.season)).toEqual([1, 2]);
    expect(dirs.map((dir) => dir.files)).toEqual([1, 1]);
  });
});
