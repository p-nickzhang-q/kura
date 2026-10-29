import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  numberMatch,
  numberVariants,
  parseDetail,
  parseSearch,
  selectCandidateIndex,
} from "../src/sources/javbus";

const fixtures = join(import.meta.dir, "fixtures");
const detailHtml = readFileSync(join(fixtures, "javbus-detail.html"), "utf8");
const searchHtml = readFileSync(join(fixtures, "javbus-search.html"), "utf8");

describe("parseDetail", () => {
  test("真实结构能被解析出全部字段", () => {
    const fields = parseDetail(detailHtml, "https://www.javbus.com/ABC-123");
    expect(fields).not.toBeNull();
    expect(fields!.title).toBe("示例标题");
    expect(fields!.actors).toEqual(["演员1", "演员2"]);
    expect(fields!.studio).toBe("片商A");
    expect(fields!.label).toBe("厂牌A");
    expect(fields!.directors).toEqual(["导演A"]);
    expect(fields!.release_date).toBe("2024-01-02");
    expect(fields!.duration_min).toBe(120);
    expect(fields!.tags?.length).toBeGreaterThan(0);
    expect(fields!.tags?.[0]).toBe("标签1");
  });

  test("系列链接存在时才产出 series (这条样本本身没有系列)", () => {
    const withSeries = detailHtml.replace(
      "</body>",
      '<p><span class="header">系列:</span><a href="https://www.javbus.com/series/ab">系列A</a></p></body>',
    );
    expect(parseDetail(withSeries)!.series).toBe("系列A");
  });

  test("海报由封面派生: /cover/ → /thumb/, _b.jpg → .jpg", () => {
    const fields = parseDetail(detailHtml, "https://www.javbus.com/ABC-123")!;
    expect(fields.cover_urls?.[0]).toContain("/cover/");
    expect(fields.poster_urls?.[0]).toContain("/thumb/");
    expect(fields.poster_urls?.[0]).not.toContain("_b.jpg");
    expect(fields.poster_urls?.[0]).toMatch(/\.jpg$/);
  });

  test("相对地址会被补成绝对地址", () => {
    const fields = parseDetail(detailHtml, "https://www.javbus.com/ABC-123")!;
    expect(fields.cover_urls?.[0]).toStartWith("https://www.javbus.com/");
  });

  test("没有 h3 或没有识别码就不产出结果 (不猜)", () => {
    expect(parseDetail("<html><body>nothing</body></html>")).toBeNull();
    const noNumber = detailHtml.replace(/識別碼/g, "XXX");
    expect(parseDetail(noNumber)).toBeNull();
  });
});

describe("parseSearch", () => {
  test("从检索结果里取 URL 与番号", () => {
    const candidates = parseSearch(searchHtml);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.url).toStartWith("https://www.javbus.com/");
    expect(candidates[0]!.number).toBe("ABC-123");
  });
});

describe("numberVariants", () => {
  test("原样写法优先, FC2 补无 PPV 写法", () => {
    expect(numberVariants("SSIS-001")).toEqual(["SSIS-001"]);
    expect(numberVariants("FC2-PPV-1234567")).toEqual(["FC2-PPV-1234567", "FC2-1234567"]);
  });

  test("开头纯数字段的番号补一条去掉数字的写法", () => {
    expect(numberVariants("259LUXU-1234")).toEqual(["259LUXU-1234", "LUXU-1234"]);
  });
});

describe("numberMatch / selectCandidateIndex", () => {
  test("精确 / 仅差数字段 / 不匹配", () => {
    expect(numberMatch("SSIS-001", "ssis001")).toBe("exact");
    expect(numberMatch("259LUXU-1234", "LUXU-1234")).toBe("without-leading-digits");
    expect(numberMatch("SSIS-999", "SSIS-001")).toBe("none");
  });

  test("精确命中优先", () => {
    expect(selectCandidateIndex(["259LUXU-1234", "LUXU-1234"], "LUXU-1234")).toBe(1);
  });

  test("仅差数字段的候选唯一时才接受, 多个则不匹配", () => {
    expect(selectCandidateIndex(["259LUXU-1234"], "LUXU-1234")).toBe(0);
    expect(selectCandidateIndex(["259LUXU-1234", "010LUXU-1234"], "LUXU-1234")).toBeNull();
  });

  test("完全无命中返回 null, 不退回首条", () => {
    expect(selectCandidateIndex(["AAA-111", "BBB-222"], "CCC-333")).toBeNull();
    expect(selectCandidateIndex([], "CCC-333")).toBeNull();
  });
});
