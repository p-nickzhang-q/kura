import { describe, expect, test } from "bun:test";
import { aggregate, mergeWithPinned } from "../src/domain/aggregate";
import type { SourceRecord } from "../src/domain/types";

const records: SourceRecord[] = [
  { site: "b", fields: { title: "B 标题", actors: ["B 演员"], poster_urls: ["u2", "u3"], studio: "" } },
  { site: "a", fields: { title: "A 标题", plot: "A 简介", actors: ["A1", "A2"], poster_urls: ["u1", "u2"] } },
  { site: "c", fields: { title: "C 标题", tags: ["tag"], duration_min: 120 } },
];

describe("aggregate", () => {
  test("单源字段取路由里第一个非空值", () => {
    const result = aggregate(records, ["a", "b", "c"]);
    expect(result.fields.title).toBe("A 标题");
    expect(result.fieldSources.title).toBe("a");
    // b 的 studio 是空串, 不能被当成"有值"
    expect(result.fields.studio).toBeUndefined();
  });

  test("列表字段取第一个非空列表, 不做并集", () => {
    const result = aggregate(records, ["b", "a"]);
    expect(result.fields.actors).toEqual(["B 演员"]);
  });

  test("路由顺序就是优先级, 不在名单里的源被丢弃", () => {
    expect(aggregate(records, ["c", "a"]).fields.title).toBe("C 标题");
    expect(aggregate(records, ["a"]).fields.duration_min).toBeUndefined();
  });

  test("URL 字段按顺序拼接去重", () => {
    const result = aggregate(records, ["b", "a"]);
    expect(result.fields.poster_urls).toEqual(["u2", "u3", "u1"]);
  });

  test("列表值去掉首尾空白与重复", () => {
    const result = aggregate([{ site: "a", fields: { actors: [" 甲 ", "甲", ""] } }], ["a"]);
    expect(result.fields.actors).toEqual(["甲"]);
  });
});

describe("mergeWithPinned", () => {
  test("锁定字段不被新结果覆盖", () => {
    const incoming = aggregate([{ site: "a", fields: { title: "新标题", plot: "新简介" } }], ["a"]);
    const merged = mergeWithPinned(incoming, { title: "我改的标题" }, ["title"]);
    expect(merged.fields.title).toBe("我改的标题");
    expect(merged.fields.plot).toBe("新简介");
  });
});
