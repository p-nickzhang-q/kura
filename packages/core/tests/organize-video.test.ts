import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import type { Library } from "../src/domain/materialize";
import { openRuntime, type Runtime } from "../src/runtime";
import { bindDirectory } from "../src/tasks/bind";
import { scan } from "../src/tasks/scan";
import { episodeBaseName, folderName, organizeVideo } from "../src/tasks/organize-video";

let root: string;
let media: string;
let rt: Runtime;

async function touch(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-orgvideo-"));
  media = join(root, "库");
  await mkdir(media, { recursive: true });
  rt = await openRuntime({ dataDir: join(root, "data") });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

async function setupShow(): Promise<Library> {
  // 同一部剧拆在两个目录里(仁医 / 仁医2), 季号分别 1 / 2
  for (let episode = 1; episode <= 2; episode++) {
    await touch(join(media, "仁医", `仁医 - 第${episode}集.mp4`));
  }
  for (let episode = 3; episode <= 4; episode++) {
    await touch(join(media, "仁医2", `仁医2 - 第${episode}集.mp4`));
  }
  // 认不出集号的文件: 不该被搬走
  await touch(join(media, "仁医", "幕后花絮.mkv"));

  const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
  await scan(rt, { library });
  bindDirectory(rt, { libraryId: library.id, dir: join(media, "仁医"), key: "tmdb:tv:46198", season: 1 });
  bindDirectory(rt, { libraryId: library.id, dir: join(media, "仁医2"), key: "tmdb:tv:46198", season: 2 });
  rt.db.run(
    "update items set title = '仁医', title_original = 'JIN - 仁 -', release_date = '2009-10-11', tags = '[\"剧情\"]' where number = 'tmdb:tv:46198'",
  );
  // 来源声明的集(集名来自 TMDB)
  for (const [season, episode, title] of [
    [1, 1, "第一集"],
    [2, 3, "第三集"],
  ] as const) {
    rt.db.run("insert into episodes (number, season, episode, title, field_sources) values ('tmdb:tv:46198', ?, ?, ?, '{}')", [
      season,
      episode,
      title,
    ]);
  }
  return library;
}

describe("影视整理: 目录形状", () => {
  test("剧: 剧名 (年份)/Season NN/SxxEyy + tvshow.nfo", async () => {
    const library = await setupShow();

    // 干跑: 不动磁盘
    const dry = await organizeVideo(rt, { library });
    expect(dry.applied).toBeNull();
    expect(dry.plan.summary.move).toBe(4);
    expect(await readdir(join(media, "仁医"))).toContain("仁医 - 第1集.mp4");

    const report = await organizeVideo(rt, { library, apply: true });
    expect(report.applied?.every((entry) => entry.ok)).toBe(true);

    // 两个源目录的集合并到同一个剧目录, 按季分文件夹
    const showDir = join(media, "仁医 (2009)");
    expect(await readdir(showDir)).toContain("tvshow.nfo");
    expect((await readdir(join(showDir, "Season 01"))).sort()).toEqual(
      ["仁医 - S01E01.mp4", "仁医 - S01E01.nfo", "仁医 - S01E02.mp4", "仁医 - S01E02.nfo"].sort(),
    );
    expect(await readdir(join(showDir, "Season 02"))).toContain("仁医 - S02E03.mp4");

    const tvshow = await readFile(join(showDir, "tvshow.nfo"), "utf8");
    expect(tvshow).toContain("<tvshow>");
    expect(tvshow).toContain("<title>仁医</title>");
    expect(tvshow).toContain('<uniqueid type="tmdb" default="true">46198</uniqueid>');

    // 集 nfo 有集名与集号
    const episode = await readFile(join(showDir, "Season 01", "仁医 - S01E01.nfo"), "utf8");
    expect(episode).toContain("<episodedetails>");
    expect(episode).toContain("<title>第一集</title>");
    expect(episode).toContain("<episode>1</episode>");

    // 认不出集号的文件原地不动
    expect(await readdir(join(media, "仁医"))).toEqual(["幕后花絮.mkv"]);
  });

  test("索引跟着搬: 不产生'旧路径消失 + 新路径出现'", async () => {
    const library = await setupShow();
    await organizeVideo(rt, { library, apply: true });

    const paths = rt.db
      .all<{ path: string }>(
        "select path from media_files where number = 'tmdb:tv:46198' and episode is not null order by season, episode",
      )
      .map((row) => row.path.replace(media, ""));
    expect(paths[0]).toContain("仁医 (2009)");
    expect(paths[0]).toContain("Season 01");
    // 再扫一次不该出现"新增 + 删除"
    const rescan = await scan(rt, { library });
    expect(rescan.counts.added).toBe(0);
    expect(rescan.counts.removed).toBe(0);
  });

  test("电影: 片名 (年份)/片名 (年份).mkv + <movie> nfo, 不写 tvshow.nfo", async () => {
    await touch(join(media, "阿甘正传", "阿甘正传 1994.mkv"));
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "阿甘正传"), key: "tmdb:movie:13" });
    rt.db.run("update items set title = '阿甘正传', release_date = '1994-07-06', duration_min = 142 where number = 'tmdb:movie:13'");

    await organizeVideo(rt, { library, apply: true });
    const dir = join(media, "阿甘正传 (1994)");
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(["阿甘正传 (1994).mkv", "阿甘正传 (1994).nfo"]);
    const nfo = await readFile(join(dir, "阿甘正传 (1994).nfo"), "utf8");
    expect(nfo).toContain("<movie>");
    expect(nfo).toContain("<runtime>142</runtime>");
  });

  test("认不出的文件不搬, 并给出提醒", async () => {
    await touch(join(media, "某剧", "某剧 - 第1集.mp4"));
    await touch(join(media, "某剧", "某剧 花絮.mkv"));
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    // 花絮认不出集号: 手工把它挂到条目上, 模拟"有身份但没集号"
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:9" });
    rt.db.run("update media_files set number = 'tmdb:tv:9' where path like '%花絮%'");
    rt.db.run("update items set title = '某剧' where number = 'tmdb:tv:9'");

    const report = await organizeVideo(rt, { library });
    expect(report.warnings.some((warning) => warning.includes("认不出集号"))).toBe(true);
    const skipped = report.plan.entries.filter((entry) => entry.action === "skip");
    expect(skipped.some((entry) => entry.reason?.includes("认不出集号"))).toBe(true);
  });

  test("没刮削的条目(没有标题)整条跳过", async () => {
    await touch(join(media, "某剧", "某剧 - 第1集.mp4"));
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:9" });

    const report = await organizeVideo(rt, { library });
    expect(report.plan.summary.move).toBe(0);
    expect(report.warnings[0]).toContain("还没刮削");
  });

  test("库设为只索引时不搬", async () => {
    const library = { ...(await setupShow()), organizeEnabled: false };
    const report = await organizeVideo(rt, { library, apply: true });
    expect(report.skipped).toBe(true);
    expect(report.applied).toBeNull();
    expect(await readdir(join(media, "仁医"))).toContain("仁医 - 第1集.mp4");
  });

  test("两个文件抢同一集: 只搬第一个, 并提醒", async () => {
    await touch(join(media, "某剧", "某剧 - 第1集.mp4"));
    await touch(join(media, "某剧", "某剧 - 第1集 修复版.mp4"));
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:9" });
    rt.db.run("update items set title = '某剧' where number = 'tmdb:tv:9'");

    const report = await organizeVideo(rt, { library });
    expect(report.plan.summary.move).toBe(1);
    expect(report.warnings.some((warning) => warning.includes("抢同一个目标"))).toBe(true);
  });
});

describe("名字规则", () => {
  test("目录名带年份, 名字里的非法字符被消毒", () => {
    expect(folderName("仁医", "2009")).toBe("仁医 (2009)");
    expect(folderName("仁医", null)).toBe("仁医");
    expect(folderName("A/B:C", "2009")).toBe("A B C (2009)");
  });

  test("集文件名是 SxxEyy, 补零到两位", () => {
    expect(episodeBaseName("仁医", 1, 1)).toBe("仁医 - S01E01");
    expect(episodeBaseName("成长的烦恼", 7, 165)).toBe("成长的烦恼 - S07E165");
  });
});
