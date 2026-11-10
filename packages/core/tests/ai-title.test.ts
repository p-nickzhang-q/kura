import { describe, expect, test } from "bun:test";
import { HttpClient } from "../src/net/http";
import { buildAliasPrompt, parseAliasResponse } from "../src/llm/ai-title";

describe("解析模型返回的别名", () => {
  test("带 ```json 围栏和前后废话也能解析", () => {
    const raw = ['好的, 结果如下:', '```json', '[{"i":0,"title":"前哨","aliases":["The Outpost"],"year":"2019"}]', '```'].join("\n");
    const out = parseAliasResponse(raw, ["60号高地之下"]);
    expect(out).toEqual([{ name: "60号高地之下", title: "前哨", aliases: ["The Outpost"], year: "2019" }]);
  });

  test("下标越界/非数组项/坏年份都丢掉, 不抛", () => {
    const raw = '[{"i":9,"title":"x"},{},{"i":0,"title":"死神来了5","year":"两千一十","aliases":[]}]';
    const out = parseAliasResponse(raw, ["死神5"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("死神5");
    expect(out[0]!.year).toBeNull();
  });

  test("别名去重、去掉与 title 相同的、限 4 个", () => {
    const raw = '[{"i":0,"title":"甲","aliases":["甲","甲","乙","丙","丁","戊"]}]';
    expect(parseAliasResponse(raw, ["x"])[0]!.aliases).toEqual(["乙", "丙", "丁", "戊"]);
  });

  test("不是 JSON 就抛: 调用方据此退回正则结果", () => {
    expect(() => parseAliasResponse("抱歉, 我不知道", ["x"])).toThrow();
  });

  test("prompt 带下标, 模型才能按 i 对上", () => {
    expect(buildAliasPrompt(["甲", "乙"])).toContain("0. 甲");
    expect(buildAliasPrompt(["甲", "乙"])).toContain("1. 乙");
  });
});

describe("别名引擎", () => {
  test("同一个名字只问一次(第二次走缓存)", async () => {
    const { createAliasEngine } = await import("../src/llm/ai-title");
    const { TranslationCache } = await import("../src/llm/translate");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "kura-alias-"));
    const cache = await TranslationCache.open(dir);
    let calls = 0;
    const http = new HttpClient({
      fetchImpl: (async () => {
        calls++;
        const body = { choices: [{ message: { content: '[{"i":0,"title":"前哨","aliases":["The Outpost"],"year":"2019"}]' } }] };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const engine = createAliasEngine(http, { baseUrl: "http://x", apiKey: "", model: "m" }, cache);

    const first = await engine.suggest(["60号高地之下"]);
    expect(first.get("60号高地之下")?.aliases).toEqual(["The Outpost"]);
    const again = await engine.suggest(["60号高地之下"]);
    expect(again.get("60号高地之下")?.title).toBe("前哨");
    expect(calls).toBe(1);
  });

  test("模型挂了: 返回空 map, 记一条错误, 不抛", async () => {
    const { createAliasEngine } = await import("../src/llm/ai-title");
    const { TranslationCache } = await import("../src/llm/translate");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const cache = await TranslationCache.open(await mkdtemp(join(tmpdir(), "kura-alias2-")));
    const http = new HttpClient({
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    const engine = createAliasEngine(http, { baseUrl: "http://x", apiKey: "", model: "m" }, cache);

    const out = await engine.suggest(["甲"]);
    expect(out.size).toBe(0);
    expect(engine.errors.length).toBeGreaterThan(0);
  });
});
