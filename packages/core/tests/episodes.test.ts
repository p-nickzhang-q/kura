import { describe, expect, test } from "bun:test";
import { chineseNumber, isSeasonDir, locateEpisode, locateMovie, parseEpisode, seasonFromDir, showDirOf } from "../src/domain/episodes";

describe("中文数字", () => {
  test("阿拉伯数字原样返回", () => {
    expect(chineseNumber("12")).toBe(12);
  });

  test("一到九十九", () => {
    expect(chineseNumber("一")).toBe(1);
    expect(chineseNumber("十")).toBe(10);
    expect(chineseNumber("十一")).toBe(11);
    expect(chineseNumber("二十")).toBe(20);
    expect(chineseNumber("二十三")).toBe(23);
    expect(chineseNumber("九十九")).toBe(99);
  });

  test("百", () => {
    expect(chineseNumber("一百")).toBe(100);
    expect(chineseNumber("一百零五")).toBe(105);
  });

  test("认不出返回 null", () => {
    expect(chineseNumber("第")).toBeNull();
    expect(chineseNumber("abc")).toBeNull();
  });
});

describe("季目录", () => {
  test("season / s / 第N季", () => {
    expect(seasonFromDir("Season 01")).toBe(1);
    expect(seasonFromDir("season 2")).toBe(2);
    expect(seasonFromDir("Season.03")).toBe(3);
    expect(seasonFromDir("S01")).toBe(1);
    expect(seasonFromDir("s12")).toBe(12);
    expect(seasonFromDir("第1季")).toBe(1);
    expect(seasonFromDir("第一季")).toBe(1);
    expect(seasonFromDir("第 2 季")).toBe(2);
  });

  test("普通目录不是季目录", () => {
    expect(seasonFromDir("某剧 (2019)")).toBeNull();
    expect(seasonFromDir("Season")).toBeNull();
    expect(isSeasonDir("Extras")).toBe(false);
  });
});

describe("集号解析", () => {
  const cases: [string, { season: number | null; episode: number } | null][] = [
    // SxxEyy
    ["Show.S01E02.1080p.mkv", { season: 1, episode: 2 }],
    ["show s1e2.mp4", { season: 1, episode: 2 }],
    ["Show.S01.E02.mkv", { season: 1, episode: 2 }],
    ["Show_S01_E02.mp4", { season: 1, episode: 2 }],
    ["Show.S12E101.mkv", { season: 12, episode: 101 }],
    // 第N集 / 话 / 回 / 期
    ["某剧 第02集.mp4", { season: null, episode: 2 }],
    ["动画 第12话.mkv", { season: null, episode: 12 }],
    ["综艺 第3回.mp4", { season: null, episode: 3 }],
    ["综艺 第8期.mkv", { season: null, episode: 8 }],
    ["某剧 第十二集.mp4", { season: null, episode: 12 }],
    // EPnn / Enn
    ["Show.EP05.mp4", { season: null, episode: 5 }],
    ["Show E05.mp4", { season: null, episode: 5 }],
    ["Show.E5.mkv", { season: null, episode: 5 }],
    // 结尾纯数字
    ["Show - 07.mkv", { season: null, episode: 7 }],
    ["Show 07.mp4", { season: null, episode: 7 }],
    ["Show_07.mp4", { season: null, episode: 7 }],
    // 该认不出的
    ["Show.1080p.mkv", null],
    ["Show.2160p.HDR.mkv", null],
    ["某电影 (2019).mkv", null],
    ["Show.2019.1080p.mkv", null],
    ["CD1.mp4", null],
    ["Show Part 2.mkv", null],
    ["[Group] Show [ABC123].mkv", null],
  ];

  for (const [name, expected] of cases) {
    test(`${name} → ${expected ? `S${expected.season ?? "?"}E${expected.episode}` : "认不出"}`, () => {
      expect(parseEpisode(name)).toEqual(expected);
    });
  }

  test("方括号里的发布组标记不干扰集号", () => {
    expect(parseEpisode("[Lilith-Raws] Show - 07 [Baha][WEB-DL][1080p].mp4")).toEqual({ season: null, episode: 7 });
    expect(parseEpisode("[Group] Show S02E03 [1080p].mkv")).toEqual({ season: 2, episode: 3 });
  });
});

describe("剧目录与位置", () => {
  test("有季目录时剧目录是上一层", () => {
    expect(showDirOf("/m/某剧 (2019)/Season 01/Show.S01E01.mkv")).toBe("/m/某剧 (2019)");
    expect(showDirOf("/m/某剧/第2季/第03集.mp4")).toBe("/m/某剧");
  });

  test("没有季目录时就是父目录", () => {
    expect(showDirOf("/m/某剧/Show - 07.mkv")).toBe("/m/某剧");
  });

  test("季的优先级: 文件名 > 季目录 > 1", () => {
    expect(locateEpisode("/m/Show/Season 02/Show.S02E05.mkv", "/m")).toEqual({
      showDir: "/m/Show",
      season: 2,
      episode: 5,
    });
    // 文件名没说季 → 用目录
    expect(locateEpisode("/m/Show/Season 03/第5集.mp4", "/m")).toEqual({
      showDir: "/m/Show",
      season: 3,
      episode: 5,
    });
    // 都没有 → 第 1 季
    expect(locateEpisode("/m/Show/第5集.mp4", "/m")).toEqual({ showDir: "/m/Show", season: 1, episode: 5 });
    // 文件名与目录冲突时以文件名为准 (它更具体)
    expect(locateEpisode("/m/Show/Season 01/Show.S02E05.mkv", "/m")).toEqual({
      showDir: "/m/Show",
      season: 2,
      episode: 5,
    });
  });

  test("认不出集号就返回 null", () => {
    expect(locateEpisode("/m/Show/trailer-teaser.mkv", "/m")).toBeNull();
  });

  test("剧目录不会走出库根", () => {
    // 库根自己就叫 Season 1: 剧目录只能回落到库根
    expect(locateEpisode("/m/Season 1/第1集.mp4", "/m/Season 1").showDir).toBe("/m/Season 1");
  });

  test("电影: 目录即候选, 与集号无关", () => {
    expect(locateMovie("/m/电影/某电影 (2019).mkv", "/m")).toEqual({ showDir: "/m/电影" });
  });
});
