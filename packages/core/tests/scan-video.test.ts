import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";
import { countFiles, listFiles, scan } from "../src/tasks/scan";
import { bindDirectory, listBindableDirs } from "../src/tasks/bind";

let root: string;
let rt: Runtime;
let media: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-scanvideo-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
  media = join(root, "media");
  await mkdir(media, { recursive: true });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

/** 造一个"一部剧 / 一季 / n 集"的目录。 */
async function makeShow(dir: string, name: string, files: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(join(dir, file), "video", "utf8");
  expect(name.length).toBeGreaterThan(0);
}

describe("剧集库扫描", () => {
  test("一个剧目录 12 个文件 → 12 集, 1 个候选剧, 0 个条目", async () => {
    const seasonDir = join(media, "某剧 (2019)", "Season 01");
    await makeShow(
      seasonDir,
      "某剧",
      Array.from({ length: 12 }, (_, i) => `某剧 - S01E${String(i + 1).padStart(2, "0")}.mkv`),
    );

    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    const report = await scan(rt, { library });

    expect(report.counts.added).toBe(12);
    expect(report.counts.unparsed).toBe(0);
    expect(report.counts.shows).toBe(1);

    // 影视文件此刻没有身份: 全部落在"未识别"里等绑定
    expect(rt.db.get<{ c: number }>("select count(*) c from items")?.c).toBe(0);
    expect(countFiles(rt, { libraryId: library.id, unparsedOnly: true })).toBe(12);

    const rows = rt.db.all<{ season: number | null; episode: number | null }>(
      "select season, episode from media_files order by episode",
    );
    expect(rows.map((row) => row.season)).toEqual(Array.from({ length: 12 }, () => 1));
    expect(rows.map((row) => row.episode)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  test("幂等: 同一目录重复扫描全部 unchanged", async () => {
    await makeShow(join(media, "Show", "Season 02"), "Show", ["Show.S02E01.mkv", "Show.S02E02.mkv"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });

    expect((await scan(rt, { library })).counts.added).toBe(2);
    const second = await scan(rt, { library });
    expect(second.counts.unchanged).toBe(2);
    expect(second.counts.added).toBe(0);
    expect(second.counts.updated).toBe(0);
    expect(second.counts.shows).toBe(1);
  });

  test("剧目录里认不出集号的文件计入 unparsed, 但不阻塞其他集", async () => {
    const dir = join(media, "Show", "Season 01");
    await makeShow(dir, "Show", ["Show.S01E01.mkv", "花絮合集片段.mkv"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });

    const report = await scan(rt, { library });
    expect(report.counts.added).toBe(2);
    expect(report.counts.unparsed).toBe(1);

    const rows = rt.db.all<{ path: string; season: number | null; episode: number | null }>(
      "select path, season, episode from media_files order by path",
    );
    const unparsedRow = rows.find((row) => row.path.endsWith("花絮合集片段.mkv"));
    expect(unparsedRow?.episode).toBeNull();
  });

  test("辅助媒体不登记 (extras / 预告片)", async () => {
    await makeShow(join(media, "Show", "Season 01"), "Show", ["Show.S01E01.mkv"]);
    await makeShow(join(media, "Show", "extras"), "Show", ["behind.mkv"]);
    await makeShow(join(media, "Show"), "Show", ["trailer.mkv"]);

    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    const report = await scan(rt, { library });

    expect(report.counts.added).toBe(1);
    expect(report.counts.auxiliary).toBe(2);
    expect(countFiles(rt, { libraryId: library.id })).toBe(1);
  });

  test("删除的文件从索引里清掉", async () => {
    const dir = join(media, "Show", "Season 01");
    await makeShow(dir, "Show", ["Show.S01E01.mkv", "Show.S01E02.mkv"]);
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });

    await rm(join(dir, "Show.S01E02.mkv"));
    const report = await scan(rt, { library });
    expect(report.counts.removed).toBe(1);
    expect(countFiles(rt, { libraryId: library.id })).toBe(1);
  });
});

describe("影视库里的电影", () => {
  test("没有集号的文件不是 unparsed —— 在这个域里它可能是电影", async () => {
    await makeShow(join(media, "电影 A"), "电影 A", ["某电影 (2019).mkv"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    const report = await scan(rt, { library });
    expect(report.counts.added).toBe(1);
    expect(report.counts.unparsed).toBe(0);
    expect(report.counts.shows).toBe(1);
  });

  test("一个文件一个候选, 没有季/集", async () => {
    await makeShow(join(media, "电影 A"), "A", ["某电影 (2019).mkv"]);
    await makeShow(join(media, "电影 B"), "B", ["另一部 (2021).mkv", "另一部 (2021).cd2.mkv"]);

    const library = createLibrary(rt.db, { name: "电影库", root: media, domain: "video" });
    const report = await scan(rt, { library });

    expect(report.counts.added).toBe(3);
    // 电影没有集号: 永远不会因为"认不出集号"进 unparsed
    expect(report.counts.unparsed).toBe(0);
    expect(report.counts.shows).toBe(2);

    const rows = rt.db.all<{ season: number | null; episode: number | null }>("select season, episode from media_files");
    expect(rows.every((row) => row.season === null && row.episode === null)).toBe(true);
  });
});

describe("电影与剧集混在一个库", () => {
  test("分目录判定: 有集号的算剧, 没有的算电影", async () => {
    await makeShow(join(media, "某剧", "Season 01"), "某剧", ["某剧 - S01E01.mkv", "某剧 - S01E02.mkv"]);
    await makeShow(join(media, "电影"), "电影", ["某电影 (2019).mkv"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });

    const report = await scan(rt, { library });
    expect(report.counts.added).toBe(3);
    expect(report.counts.unparsed).toBe(0);
    expect(report.counts.shows).toBe(2);

    const episodes = rt.db.all<{ season: number | null; episode: number | null }>(
      "select season, episode from media_files order by path",
    );
    // 剧那两条有季集, 电影那条没有
    expect(episodes.filter((row) => row.episode !== null)).toHaveLength(2);
    expect(episodes.filter((row) => row.episode === null)).toHaveLength(1);
  });

  test("待绑定清单标注推断的类型", async () => {
    await makeShow(join(media, "某剧", "Season 01"), "某剧", ["某剧 - S01E01.mkv"]);
    await makeShow(join(media, "电影"), "电影", ["某电影 (2019).mkv"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const dirs = listBindableDirs(rt, { libraryId: library.id });
    // 剧按目录做候选; 电影按**文件**做候选(一个文件一部片)
    const byKind = dirs.map((dir) => `${dir.kind}:${dir.name}`).sort();
    expect(byKind).toEqual(["movie:某电影 (2019).mkv", "tv:某剧"]);
  });
});

describe("多文件却认不出集号的目录", () => {
  test("按文件给候选 —— 绝不能把整目录当成一部片", async () => {
    // 用户真库里的样子: `movie\各种电影\` 里躺着一堆互不相关的片子
    await makeShow(join(media, "各种电影"), "各种电影", ["a 片.mp4", "b 片.mp4", "c 片.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const dirs = listBindableDirs(rt, { libraryId: library.id });
    expect(dirs).toHaveLength(3);
    expect(dirs.every((dir) => dir.kind === "movie" && dir.files === 1)).toBe(true);
    // 名字互不相关: 不提示"可能是同一部剧"
    expect(dirs.every((dir) => !dir.suspectSeries)).toBe(true);
  });

  test("同目录文件名共享前缀时标出「可能是同剧散集」", async () => {
    await makeShow(join(media, "某剧"), "某剧", [
      "【修复】某剧 001绝版.mp4",
      "【修复】某剧 002绝版.mp4",
      "【修复】某剧 003绝版.mp4",
    ]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const dirs = listBindableDirs(rt, { libraryId: library.id });
    expect(dirs).toHaveLength(3);
    expect(dirs.every((dir) => dir.suspectSeries === true)).toBe(true);
  });

  test("单文件目录是电影候选, 绑定只动那一个文件", async () => {
    await makeShow(join(media, "电影"), "电影", ["甲片 (2019).mp4"]);
    await makeShow(join(media, "电影"), "电影", ["乙片 (2021).mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const dirs = listBindableDirs(rt, { libraryId: library.id });
    expect(dirs.map((dir) => dir.kind)).toEqual(["movie", "movie"]);
    expect(dirs.map((dir) => dir.files)).toEqual([1, 1]);

    // 绑其中一个: 只该动那一个文件
    const first = dirs.find((dir) => dir.name.includes("甲片"))!;
    bindDirectory(rt, { libraryId: library.id, dir: first.dir, key: "tmdb:movie:603", paths: first.paths });
    const still = listBindableDirs(rt, { libraryId: library.id });
    expect(still).toHaveLength(1);
    expect(still[0]?.name).toContain("乙片");
  });
});

describe("番号制库不受影响", () => {
  test("同一个目录按 av 域扫描: 只认番号, 不解析集号、不建集", async () => {
    const dir = join(media, "某剧");
    await makeShow(dir, "某剧", ["SSIS-915.mkv", "某剧 - S01E02.mkv"]);

    const library = createLibrary(rt.db, { name: "番号库", root: media, domain: "av" });
    const report = await scan(rt, { library });

    // 番号认得出来; 集号那种写法在 av 域就是认不出 (进未识别)
    expect(report.counts.added).toBe(2);
    expect(report.counts.unparsed).toBe(1);
    expect(report.counts.shows).toBe(0);

    // av 域照旧建条目, 且 season/episode 恒为 null
    expect(rt.db.get<{ c: number }>("select count(*) c from items")?.c).toBe(1);
    const rows = rt.db.all<{ season: number | null; episode: number | null }>("select season, episode from media_files");
    expect(rows.every((row) => row.season === null && row.episode === null)).toBe(true);

    const files = listFiles(rt, { libraryId: library.id, unparsedOnly: true });
    expect(files.map((file) => file.path)).toEqual([join(dir, "某剧 - S01E02.mkv")]);
  });
});

describe("番号识别的误报", () => {
  test("文件名里有番号就以文件名为准, 不被目录名带偏", async () => {
    const dir = join(media, "kura-wtyk17");
    await makeShow(dir, "x", ["SSIS-915.mkv"]);
    const library = createLibrary(rt.db, { name: "番号库", root: media, domain: "av" });

    await scan(rt, { library });
    const row = rt.db.get<{ number: string | null }>("select number from media_files");
    expect(row?.number).toBe("SSIS-915");
  });

  test("文件名里没有番号时才回头看路径 (目录名带番号的老库照旧能认)", async () => {
    const dir = join(media, "SSIS-915-C");
    await makeShow(dir, "x", ["video.mp4"]);
    const library = createLibrary(rt.db, { name: "番号库", root: media, domain: "av" });

    await scan(rt, { library });
    const row = rt.db.get<{ number: string | null }>("select number from media_files");
    // 目录里的 -C 是"分集/中字"相位标记, 番号是 SSIS-915
    expect(row?.number).toBe("SSIS-915");
  });
});
