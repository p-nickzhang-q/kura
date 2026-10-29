import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "cheerio";
import { join } from "node:path";
import { AppError, EXIT } from "../src/exit";
import { assertNotLoginPage, parseDetail, parseSearch } from "../src/sources/javdb";

const fixtures = join(import.meta.dir, "fixtures");
const detailHtml = readFileSync(join(fixtures, "javdb-detail.html"), "utf8");
const searchHtml = readFileSync(join(fixtures, "javdb-search.html"), "utf8");

const LOGIN_PAGE = `<html><body>
  <form action="/user_sessions" method="post"><input type="password" name="password"></form>
</body></html>`;

describe("parseDetail", () => {
  test("行式布局的字段都能解析", () => {
    const fields = parseDetail(detailHtml, "https://javdb.com/v/ZY5eq")!;
    expect(fields).not.toBeNull();
    expect(fields.title).toBe("示例标题");
    expect(fields.release_date).toBe("2024-01-02");
    expect(fields.duration_min).toBe(120);
    expect(fields.studio).toBe("片商A");
    expect(fields.series).toBe("系列A");
    expect(fields.directors).toEqual(["导演A"]);
    expect(fields.tags?.length).toBeGreaterThan(0);
    expect(fields.tags?.[0]).toBe("标签1");
  });

  test("演员包含女优与男优 (页面用 class 区分, 这里不建模性别)", () => {
    const fields = parseDetail(detailHtml, "https://javdb.com/v/ZY5eq")!;
    expect(fields.actors?.length).toBe(3);
    expect(fields.actors?.[0]).toBe("演员1");
  });

  test("没有发行商行时 label 为空, 不硬编", () => {
    const fields = parseDetail(detailHtml, "https://javdb.com/v/ZY5eq")!;
    expect(fields.label).toBeUndefined();
  });

  test("封面同时用作海报 (JavDB 只给一张图)", () => {
    const fields = parseDetail(detailHtml, "https://javdb.com/v/ZY5eq")!;
    expect(fields.cover_urls?.[0]).toStartWith("https://");
    expect(fields.poster_urls?.[0]).toBe(fields.cover_urls?.[0]);
  });

  test("没有番号或标题就返回 null", () => {
    expect(parseDetail("<html><body>nothing</body></html>")).toBeNull();
    expect(parseDetail(detailHtml.replace(/data-clipboard-text="[^"]*"/g, ""))).toBeNull();
  });
});

describe("登录页识别", () => {
  test("登录表单 → NEEDS_INPUT, 并给出可行动提示", () => {
    const error = (() => {
      try {
        assertNotLoginPage(load(LOGIN_PAGE));
        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(EXIT.NEEDS_INPUT);
    expect((error as AppError).message).toContain("登录");
  });

  test("正常页面不会被误判", () => {
    expect(() => parseDetail(detailHtml)).not.toThrow();
  });
});

describe("parseSearch", () => {
  test("从结果卡片取 URL 与番号, 且地址是绝对的", () => {
    const candidates = parseSearch(searchHtml);
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates[0]!.number).toBe("ABC-123");
    expect(candidates[0]!.url).toStartWith("https://javdb.com/v/");
  });

  test("登录页的搜索结果直接报 NEEDS_INPUT", () => {
    expect(() => parseSearch(LOGIN_PAGE)).toThrow(AppError);
  });
});
