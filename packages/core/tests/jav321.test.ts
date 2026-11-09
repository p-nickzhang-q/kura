import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregate } from "../src/domain/aggregate";
import type { SourceRecord } from "../src/domain/types";
import { contentIdCandidates, parseDetail, stripTrailingActors } from "../src/sources/jav321";

const fixtures = join(import.meta.dir, "fixtures");
const detailHtml = readFileSync(join(fixtures, "jav321-detail.html"), "utf8");

describe("Jav321 详情页", () => {
  test("简介取容器开头的文本, 广告与免责声明留在外面", () => {
    const fields = parseDetail(detailHtml);
    expect(fields).not.toBeNull();
    expect(fields!.plot).toContain("示例简介正文第一段");
    // 简介容器后面挂着 DMM 直播广告与「※ 配信方法…」, 不能一起拼进来
    expect(fields!.plot).not.toContain("配信方法");
    expect(fields!.plot).not.toContain("banner.jpg");
    expect(fields!.plot).not.toContain("ライブチャット");
    // 播放器与广告位容器同样不是简介
    expect(fields!.plot).not.toContain("adsbyjuicy");
    expect(fields!.plot).not.toContain("video");
  });

  test("玩家/广告块整块跳过: 以元素开头的容器不算简介", () => {
    const html = readFileSync(join(fixtures, "jav321-detail.html"), "utf8");
    const fields = parseDetail(html)!;
    // 只有一个简介段落, 不该把演员推荐位(以 div.col-xs-6 开头)也当成简介
    expect(fields.plot!.split("示例").length - 1).toBe(1);
  });

  test("出演者 / 厂牌 / 标签按 nextUntil 分组, 不把别的标签的链接一起捞进来", () => {
    const fields = parseDetail(detailHtml)!;
    expect(fields.actors).toEqual(["演员名一", "演员名二"]);
    expect(fields.studio).toBe("片商A");
    expect(fields.label).toBe("厂牌A");
    expect(fields.series).toBe("系列A");
  });

  test("标题去掉裸文本形式的演员名, 也不带 <small> 里的番号", () => {
    const fields = parseDetail(detailHtml)!;
    expect(fields.title).toBe("示例标题文本");
  });

  test("日期 / 时长 / 封面: ps 是大图之外的小图, poster 取 pl", () => {
    const fields = parseDetail(detailHtml)!;
    expect(fields.release_date).toBe("2024-01-02");
    expect(fields.duration_min).toBe(120);
    expect(fields.thumb_urls).toEqual(["https://pics.dmm.co.jp/digital/video/abc00123/abc00123ps.jpg"]);
    expect(fields.poster_urls).toEqual(["https://pics.dmm.co.jp/digital/video/abc00123/abc00123pl.jpg"]);
  });

  test("没有 h3 的页面不算这条 (例如站点的错误页)", () => {
    expect(parseDetail("<html><body>not found</body></html>")).toBeNull();
  });

  test("补零候选: 5 位优先, 3 位与原样兜底", () => {
    expect(contentIdCandidates("SSIS-001")).toEqual(["ssis00001", "ssis001"]);
    expect(contentIdCandidates("ABP-1")).toEqual(["abp00001", "abp001", "abp1"]);
    expect(contentIdCandidates("SNOS-461")).toEqual(["snos00461", "snos461"]);
  });

  test("多个演员依次接在标题后面时全部去掉", () => {
    expect(stripTrailingActors("标题 甲 乙", ["甲", "乙"])).toBe("标题");
    // 只在结尾, 标题中间的同名文本不动
    expect(stripTrailingActors("甲的故事", ["甲"])).toBe("甲的故事");
  });
});

describe("简介补缺", () => {
  test("javbus/javdb 都没简介时, 把 jav321 排在路由末尾才拿到 plot", () => {
    const records: SourceRecord[] = [
      { site: "javbus", fields: { title: "javbus 标题", actors: ["A"] } },
      { site: "javdb", fields: { title: "javdb 标题", tags: ["单人作品"] } },
      { site: "jav321", fields: { title: "jav321 标题", plot: "日语简介", studio: "片商A" } },
    ];

    const without = aggregate(records.slice(0, 2), ["javbus", "javdb"]);
    expect(without.fields.plot).toBeUndefined();

    const withFallback = aggregate(records, ["javbus", "javdb", "jav321"]);
    expect(withFallback.fields.plot).toBe("日语简介");
    expect(withFallback.fieldSources.plot).toBe("jav321");
    // 前面的源已经给了标题, 补缺源不能反客为主
    expect(withFallback.fields.title).toBe("javbus 标题");
  });
});
