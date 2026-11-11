import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLibrary } from "../src/db/rows";
import type { Library } from "../src/domain/materialize";
import { openRuntime, type Runtime } from "../src/runtime";
import { bindDirectory, bindLocalDirectory } from "../src/tasks/bind";
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

describe("搬空的源目录", () => {
  test("空目录被清掉, 还有文件的不动", async () => {
    // 仁医 / 仁医2 两个目录被搬空 → 都该删; 仁医里放一个认不出的文件 → 留着
    await touch(join(media, "仁医", "仁医 - 第1集.mp4"));
    await touch(join(media, "仁医2", "仁医2 - 第2集.mp4"));
    await touch(join(media, "某剧", "某剧 - 第1集.mp4"));
    await touch(join(media, "某剧", "某剧 幕后花絮.mkv"));

    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "仁医"), key: "tmdb:tv:1" });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "仁医2"), key: "tmdb:tv:2" });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:3" });
    rt.db.run("update items set title = '仁医', release_date = '2009-10-11' where number = 'tmdb:tv:1'");
    rt.db.run("update items set title = '仁医二', release_date = '2011-04-17' where number = 'tmdb:tv:2'");
    rt.db.run("update items set title = '某剧', release_date = '2020-01-01' where number = 'tmdb:tv:3'");
    // 花絮有身份但认不出集号 → 留在源目录, 目录因此不能删
    rt.db.run("update media_files set number = 'tmdb:tv:3' where path like '%花絮%'");

    const report = await organizeVideo(rt, { library, apply: true });
    const left = await readdir(media);

    expect(left).not.toContain("仁医");
    expect(left).not.toContain("仁医2");
    expect(left).toContain("某剧");
    expect(await readdir(join(media, "某剧"))).toEqual(["某剧 幕后花絮.mkv"]);
    expect(report.removedDirs?.length).toBe(2);
    expect(report.leftoverDirs?.some((item) => item.dir.endsWith("某剧"))).toBe(true);
    // 提醒里说清楚为什么没删
    expect(report.warnings.some((warning) => warning.includes("目录没删"))).toBe(true);
  });

  test("干跑不删任何目录", async () => {
    await touch(join(media, "某剧", "某剧 - 第1集.mp4"));
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:9" });
    rt.db.run("update items set title = '某剧' where number = 'tmdb:tv:9'");

    const report = await organizeVideo(rt, { library });
    expect(report.applied).toBeNull();
    expect(await readdir(media)).toContain("某剧");
  });
});


describe("目标目录就是源目录时", () => {
  test("没有年份 → 目录名相同, 不该把它当成'搬空的旧目录'", async () => {
    await touch(join(media, "无年份剧", "无年份剧 - 第1集.mp4"));
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "无年份剧"), key: "tmdb:tv:7" });
    rt.db.run("update items set title = '无年份剧' where number = 'tmdb:tv:7'");

    const report = await organizeVideo(rt, { library, apply: true });
    // 文件搬进 无年份剧/Season 01/, 目录本身留着(它是新结构)
    expect(await readdir(join(media, "无年份剧"))).toContain("Season 01");
    expect(report.removedDirs ?? []).toEqual([]);
    // 也不该冒出"目录没删"的提醒
    expect(report.warnings.some((warning) => warning.includes("目录没删"))).toBe(false);
  });
});

describe("老目录里只剩 Kura 自己的东西时", () => {
  test("poster.jpg / fanart.jpg / 集 nfo 会被清掉, 目录跟着删; 字幕一律不动", async () => {
    await touch(join(media, "某剧", "某剧 - 第1集.mp4"));
    await touch(join(media, "某剧", "某剧 - 第1集.nfo"));
    await touch(join(media, "某剧", "poster.jpg"));
    await touch(join(media, "某剧", "fanart.jpg"));
    await touch(join(media, "某剧", "tvshow.nfo"));
    // 用户自己的东西: 必须留着
    await touch(join(media, "另一个剧", "另一个剧 - 第1集.mp4"));
    await touch(join(media, "另一个剧", "另一个剧 - 第1集.nfo"));
    await touch(join(media, "另一个剧", "poster.jpg"));
    await touch(join(media, "另一个剧", "另一个剧 - 第1集.zh.srt"));

    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:1" });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "另一个剧"), key: "tmdb:tv:2" });
    rt.db.run("update items set title = '某剧', release_date = '2020-01-01' where number = 'tmdb:tv:1'");
    rt.db.run("update items set title = '另一个剧', release_date = '2021-01-01' where number = 'tmdb:tv:2'");

    const report = await organizeVideo(rt, { library, apply: true });
    const left = await readdir(media);

    // 只剩 Kura 生成物的目录 → 连目录一起没了
    expect(left).not.toContain("某剧");
    expect(report.removedFiles?.some((file) => file.endsWith("poster.jpg"))).toBe(true);

    // 有字幕的目录: 字幕留着, Kura 的图删了, 目录保留并报出来
    expect(left).toContain("另一个剧");
    const remain = await readdir(join(media, "另一个剧"));
    expect(remain).toEqual(["另一个剧 - 第1集.zh.srt"]);
    expect(report.leftoverDirs?.some((item) => item.dir.endsWith("另一个剧"))).toBe(true);
  });
});

describe("清理空壳目录", () => {
  test("没影片、只剩海报与 nfo → 连目录一起删; 有字幕的只删海报", async () => {
    const { cleanupEmptyDirs } = await import("../src/tasks/organize-video");
    await touch(join(media, "剧/某剧 老目录/poster.jpg"));
    await touch(join(media, "剧/某剧 老目录/fanart.jpg"));
    await touch(join(media, "剧/某剧 老目录/某剧 - 第1集.nfo"));
    await touch(join(media, "剧/有字幕的/poster.jpg"));
    await touch(join(media, "剧/有字幕的/某剧 - 第1集.zh.srt"));
    await touch(join(media, "剧/还有影片/某剧 - S01E01.mkv"));
    await touch(join(media, "剧/还有影片/poster.jpg"));

    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });

    // 干跑: 一个文件都不动
    const dry = await cleanupEmptyDirs(rt, { libraryId: library.id });
    expect(dry.dryRun).toBe(true);
    expect(dry.removedDirs.some((dir) => dir.endsWith("某剧 老目录"))).toBe(true);
    expect(await readdir(join(media, "剧/某剧 老目录"))).toContain("poster.jpg");

    const report = await cleanupEmptyDirs(rt, { libraryId: library.id, apply: true });
    const dirs = await readdir(join(media, "剧"));
    expect(dirs).not.toContain("某剧 老目录"); // 全是 Kura 残留 → 整个目录没了
    expect(dirs).toContain("有字幕的"); // 有字幕 → 目录留着
    expect(await readdir(join(media, "剧/有字幕的"))).toEqual(["某剧 - 第1集.zh.srt"]); // 海报删了
    expect(await readdir(join(media, "剧/还有影片"))).toContain("poster.jpg"); // 还有影片 → 一点不动
    expect(report.kept.some((item) => item.dir.endsWith("有字幕的"))).toBe(true);
  });
});

describe("本地条目 (手动加入的 UGC)", () => {
  test("整理不碰它们, 并在报告里说明跳过了几个", async () => {
    await touch(join(media, "bilibili", "115406106794717-黑熊精新歌", "成片-33241500011.mp4"));
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    bindLocalDirectory(rt, {
      libraryId: library.id,
      dir: join(media, "bilibili", "115406106794717-黑熊精新歌"),
    });

    const report = await organizeVideo(rt, { library, apply: true });
    expect(report.skippedLocal).toBe(1);
    expect(report.plan.summary.move).toBe(0);
    // 文件原地不动
    expect(await readdir(join(media, "bilibili", "115406106794717-黑熊精新歌"))).toEqual(["成片-33241500011.mp4"]);
    expect(report.warnings.some((line) => line.includes("本地条目"))).toBe(true);
  });
});

describe("索引指着已删除的旧目录时, 整理自己会纠正", () => {
  test("源路径不存在、目标存在 → 索引改到目标, 不需要人工跑 repair", async () => {
    const library = await setupShow();
    await organizeVideo(rt, { library, apply: true });
    // 造出"上次搬完但索引没跟上"的状态: 把索引改回**整理前**的位置。
    // 不能随便造一个陌生目录 —— 那样整理计划判"认不出集号", 连目标路径都没有,
    // 纠正逻辑(靠 from 不在 + to 在)压根没机会跑。
    const row = rt.db.get<{ path: string }>(
      "select path from media_files where number = 'tmdb:tv:46198' and season = 1 and episode = 1",
    )!;
    const ghost = join(media, "仁医", "仁医 - 第1集.mp4");
    rt.db.run("update media_files set path = ? where path = ?", [ghost, row.path]);
    expect(await (await import("node:fs/promises")).access(ghost).then(() => true, () => false)).toBe(false);

    // 再整理一次: 计划里是 skip(目标已在), 但索引该被纠正回目标路径
    await organizeVideo(rt, { library, apply: true });
    // 查**同一集**(不能 limit 1: 同一条目下还有"幕后花絮"这种没集号的文件)
    const after = rt.db.get<{ path: string }>(
      "select path from media_files where number = 'tmdb:tv:46198' and season = 1 and episode = 1",
    )!;
    expect(after.path).not.toBe(ghost);
    expect(after.path).toContain("仁医 (2009)");
  });
});

describe("分碟: 同一部电影切成几块, 都要搬进去", () => {
  test("cd=2/3 的文件带 - cdN 后缀进同一目录; 没有 cd 的多版本仍然只搬第一个", async () => {
    const library = await setupShow();
    // 一部电影 + 两个分碟 + 一个多余版本(无 cd)
    const movieDir = join(media, "电影");
    await touch(join(movieDir, "[电影天堂].神奇绿巨人-cd2.rmvb"));
    await touch(join(movieDir, "[电影天堂].神奇绿巨人-cd3.rmvb"));
    await touch(join(movieDir, "[电影天堂].绿巨人-1080p.rmvb"));
    await scan(rt, { library });
    // 先建条目再绑文件: media_files.number 有外键指向 items
    rt.db.run(
      "insert or replace into items (number, content_type, domain, title, release_date) values ('tmdb:movie:1927', '', 'movie', '绿巨人浩克', '2003-06-19')",
    );
    for (const name of ["[电影天堂].神奇绿巨人-cd2.rmvb", "[电影天堂].神奇绿巨人-cd3.rmvb", "[电影天堂].绿巨人-1080p.rmvb"]) {
      rt.db.run("update media_files set number = 'tmdb:movie:1927' where path = ?", [join(movieDir, name)]);
    }

    const report = await organizeVideo(rt, { library, apply: true });
    const moves = report.plan.entries
      .filter((entry) => entry.action === "move" && entry.from?.includes("绿巨人"))
      .map((entry) => basename(entry.to!))
      .sort();

    // 两个分碟各自带 - cdN(以前它们想搬到同一个正片名上, 互相判"目标已存在", 永远不动)
    expect(moves).toContain("绿巨人浩克 (2003) - cd2.rmvb");
    expect(moves).toContain("绿巨人浩克 (2003) - cd3.rmvb");
    // 无 cd 的那个当正片
    expect(moves).toContain("绿巨人浩克 (2003).rmvb");
    // 三个都在同一目录
    expect(report.plan.entries.filter((entry) => entry.action === "move" && entry.from?.includes("绿巨人")).every((entry) => entry.to!.includes("绿巨人浩克 (2003)"))).toBe(true);
  });

  test("只有分碟、没有正片时, 不凭空造一个正片名", async () => {
    const library = await setupShow();
    const movieDir = join(media, "电影2");
    await touch(join(movieDir, "你是我的命运CD2.mkv"));
    await touch(join(movieDir, "你是我的命运CD3.mkv"));
    await scan(rt, { library });
    rt.db.run(
      "insert or replace into items (number, content_type, domain, title, release_date) values ('tmdb:movie:112283', '', 'movie', '你是我的命运', '2005-09-23')",
    );
    for (const name of ["你是我的命运CD2.mkv", "你是我的命运CD3.mkv"]) {
      rt.db.run("update media_files set number = 'tmdb:movie:112283' where path = ?", [join(movieDir, name)]);
    }

    const report = await organizeVideo(rt, { library, apply: true });
    const names = report.plan.entries
      .filter((entry) => entry.action === "move" && entry.from?.includes("CD"))
      .map((entry) => basename(entry.to!))
      .sort();
    expect(names).toEqual(["你是我的命运 (2005) - cd2.mkv", "你是我的命运 (2005) - cd3.mkv"]);
  });
});
