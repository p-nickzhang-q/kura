import { describe, expect, test } from "bun:test";
import { guessTitleFromDir, matchConfidence, normalizeTitle, searchableGuess } from "../src/domain/title-guess";

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
