import { describe, expect, test } from "bun:test";
import {
  guessTitleFromDir,
  guessTitleFromFile,
  matchConfidence,
  normalizeTitle,
  searchableGuess,
} from "../src/domain/title-guess";

describe("从目录名猜片名", () => {
  const cases: [string, { title: string; year: string | null }][] = [
    ["进击的巨人 (2013)", { title: "进击的巨人", year: "2013" }],
    ["进击的巨人 (2013) 最终季", { title: "进击的巨人 最终季", year: "2013" }],
    ["阿甘正传 [1994]", { title: "阿甘正传", year: "1994" }],
    ["Chernobyl.2019.1080p.BluRay", { title: "Chernobyl", year: "2019" }],
    ["The.Wandering.Earth.2019.1080p.WEB-DL", { title: "The Wandering Earth", year: "2019" }],
    ["[Lilith-Raws] 无职转生 S01 1080p", { title: "无职转生", year: null }],
    ["某电影 2160p HDR x265", { title: "某电影", year: null }],
    ["请回答1988 (2015)", { title: "请回答1988", year: "2015" }],
    ["某综艺 2024", { title: "某综艺", year: "2024" }],
    ["电影", { title: "电影", year: null }],
    ["", { title: "", year: null }],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" → ${expected.title || "(空)"} ${expected.year ?? ""}`.trim(), () => {
      expect(guessTitleFromDir(input)).toEqual(expected);
    });
  }

  test("片名里本来就有的数字不能被当成年份吃掉", () => {
    expect(guessTitleFromDir("请回答1988")).toEqual({ title: "请回答1988", year: null });
    expect(guessTitleFromDir("1917 (2019)")).toEqual({ title: "1917", year: "2019" });
  });

  test("发布组前缀与字幕标记被剥掉", () => {
    expect(guessTitleFromDir("[Group] Some.Show.S02E03.中字.1080p")).toEqual({
      title: "Some Show",
      year: null,
    });
  });
});

describe("建议的把握", () => {
  test("片名一致且年份一致 → high", () => {
    expect(matchConfidence({ title: "进击的巨人", year: "2013" }, { title: "进击的巨人", year: "2013" })).toBe("high");
  });

  test("片名一致但年份不同 → medium (可能是重拍/续作)", () => {
    expect(matchConfidence({ title: "沙丘", year: "1984" }, { title: "沙丘", year: "2021" })).toBe("medium");
  });

  test("目录名带副标题、命中名是前缀 → medium", () => {
    expect(
      matchConfidence({ title: "进击的巨人 最终季", year: "2013" }, { title: "进击的巨人 最终季", year: "2013" }),
    ).toBe("high");
    expect(matchConfidence({ title: "进击的巨人 最终季完结篇", year: null }, { title: "进击的巨人 最终季", year: null })).toBe(
      "medium",
    );
  });

  test("只有部分重合 → low (低到不该显示成建议)", () => {
    expect(matchConfidence({ title: "某综艺", year: "2024" }, { title: "奔跑吧", year: "2014" })).toBe("low");
  });

  test("空片名 → low, 且不该发搜索", () => {
    expect(searchableGuess({ title: "", year: null })).toBe(false);
    expect(searchableGuess({ title: "电", year: null })).toBe(false);
    expect(searchableGuess({ title: "电影", year: null })).toBe(true);
  });

  test("归一化忽略空格/标点/大小写", () => {
    expect(normalizeTitle("The Wandering Earth")).toBe(normalizeTitle("the.wandering-earth"));
    expect(normalizeTitle("进击的巨人：最终季")).toBe("进击的巨人最终季");
  });
});

describe("文件名猜片名 (电影候选是文件, 不是目录)", () => {
  const cases: [string, string][] = [
    ["[迅雷下载www.2tu.cc]卑劣的街头BD1024高清中字.rmvb", "卑劣的街头"],
    ["[迅播影院XunBo.Cc]老千1024高清BD无水印中字.rmvb", "老千"],
    ["[迅雷下载www.2tu.cc]101次求婚.HD1280高清国语中字.mkv", "101次求婚"],
    ["[迅雷下载www.2tu.cc]7号房的礼物.HD1024超清韩语中字.mkv", "7号房的礼物"],
    ["勇敢的心.BD中英双字1024高清.rmvb", "勇敢的心"],
    ["Chernobyl.S01.1080p.BluRay.x264.mkv", "Chernobyl"],
  ];

  for (const [input, expected] of cases) {
    test(`${input} → ${expected}`, () => {
      expect(guessTitleFromFile(input).title).toBe(expected);
    });
  }

  test("粘在片名后的画质/语言标记全部砍掉, 一个都不留在搜索词里", () => {
    const guess = guessTitleFromFile("[组]某片.BD1024高清中英双字.rmvb");
    expect(guess.title).toBe("某片");
    expect(guess.title).not.toMatch(/\d{3,4}|BD|中字|高清/);
  });

  test("片名本身带数字时不被截断 (1408/101次求婚)", () => {
    expect(guessTitleFromFile("[组]1408幻影凶间.BD1024高清中英双字.rmvb").title).toBe("1408幻影凶间");
  });

  test("整个文件名都是标记时退回原名, 不至于一个词都不发", () => {
    expect(guessTitleFromFile("BD1024高清.mkv").title.length).toBeGreaterThan(0);
  });
});

describe("粘在片名后面的裸介质标记", () => {
  // 这些站不写分辨率, 只在片名后面粘一个 HD/BD/DVD —— 以前整串拿去搜, 0 命中
  const cases: [string, string][] = [
    ["[66影视www.66ys.org]开心鬼上身HD中字1024高清.rmvb", "开心鬼上身"],
    ["[电影天堂-www.dy2018.net]阳光姐妹淘BD中字.rmvb", "阳光姐妹淘"],
    ["[迅雷下载www.99b.cc]逍遥法外DVD中英双字CD1.rmvb", "逍遥法外"],
    ["[迅雷下载www.XunBo.Cc]教父1BD1280高清中英双字.rmvb", "教父1"],
    ["[迅播影院www.xunbo.cc]机器人9号BD中英双字1280x720高清版.rmvb", "机器人9号"],
    ["刺客信条：血系HD版[www.qire123.com].rmvb", "刺客信条：血系"],
    // 半截方括号要清掉
    ["疯狂初恋[高清版].mp4", "疯狂初恋"],
  ];
  for (const [name, want] of cases) {
    test(name, () => {
      expect(guessTitleFromFile(name).title).toBe(want);
    });
  }

  test("整个名字都是方括号分组时, 挑一个最像片名的", () => {
    const name = "[goxiazai.com][2011韩国最新爱情喜剧][攒钱罗曼史][DVD][韩语中字][迅雷下载].rmvb";
    expect(guessTitleFromFile(name).title).toBe("攒钱罗曼史");
  });

  test("书名号里的是真片名", () => {
    const name = "〖韩国〗喜剧爱情影片《一番街的奇迹》；又名：〈 1号街的奇迹〉.flv";
    expect(guessTitleFromFile(name).title).toBe("一番街的奇迹");
  });
});
