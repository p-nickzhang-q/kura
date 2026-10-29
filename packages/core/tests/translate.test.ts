import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNfo, renderTemplate } from "../src/domain/materialize";
import type { Metadata } from "../src/domain/types";
import { buildSystemPrompt, chatEndpoint, createTranslator, hasKana, needsTranslation, TranslationCache } from "../src/llm/translate";
import { HttpClient } from "../src/net/http";
import { openRuntime } from "../src/runtime";
import { defaultSources } from "../src/sources";
import { getItem, scrape } from "../src/tasks/scrape";
import { pendingTranslationKeys, translateItem } from "../src/tasks/translate";

const JA_TITLE = "サンプル タイトル";
const ZH_TITLE = "示例标题";
const JA_PLOT = "これはサンプルの説明です。";
const ZH_PLOT = "这是示例简介。";

let requests = 0;
let failNext = false;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    requests++;
    if (failNext) return new Response("boom", { status: 500 });
    const body = (await request.json()) as { messages: { role: string; content: string }[] };
    const source = body.messages.find((message) => message.role === "user")?.content ?? "";
    const content = source.includes("説明") ? ZH_PLOT : ZH_TITLE;
    return Response.json({ choices: [{ message: { content } }] });
  },
});

afterAll(() => server.stop(true));

const baseUrl = `http://127.0.0.1:${server.port}/v1`;

describe("语言判定", () => {
  test("含假名才算日文", () => {
    expect(hasKana(JA_TITLE)).toBe(true);
    expect(hasKana("ABC-123 中文字幕")).toBe(false);
    expect(needsTranslation(JA_TITLE)).toBe(true);
    expect(needsTranslation("国产 中文标题")).toBe(false);
    expect(needsTranslation("")).toBe(false);
    expect(needsTranslation(undefined)).toBe(false);
  });

  test("端点补全与提示词约束", () => {
    expect(chatEndpoint({ baseUrl, apiKey: "", model: "m" })).toBe(`${baseUrl}/chat/completions`);
    expect(chatEndpoint({ baseUrl: `${baseUrl}/chat/completions`, apiKey: "", model: "m" })).toBe(
      `${baseUrl}/chat/completions`,
    );
    const prompt = buildSystemPrompt("title");
    expect(prompt).toContain("只输出译文本身");
    expect(prompt).toContain("标题");
  });
});

describe("Translator", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kura-tr-"));
    requests = 0;
    failNext = false;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("调用模型并写缓存: 同文本第二次不再请求", async () => {
    const cache = await TranslationCache.open(dir);
    const http = new HttpClient({ minIntervalMs: 0 });
    const translator = createTranslator(http, { baseUrl, apiKey: "k", model: "m" }, cache);

    expect(await translator.translate("title", JA_TITLE)).toBe(ZH_TITLE);
    expect(requests).toBe(1);
    expect(await translator.translate("title", JA_TITLE)).toBe(ZH_TITLE);
    expect(requests).toBe(1);
  });

  test("中文输入不请求模型", async () => {
    const cache = await TranslationCache.open(dir);
    const translator = createTranslator(new HttpClient({ minIntervalMs: 0 }), { baseUrl, apiKey: "k", model: "m" }, cache);
    expect(await translator.translate("title", "国产 中文标题")).toBeNull();
    expect(requests).toBe(0);
  });

  test("模型失败返回 null 且不写缓存", async () => {
    const cache = await TranslationCache.open(dir);
    const translator = createTranslator(new HttpClient({ minIntervalMs: 0, retries: 0 }), { baseUrl, apiKey: "k", model: "m" }, cache);

    failNext = true;
    expect(await translator.translate("title", JA_TITLE)).toBeNull();

    failNext = false;
    expect(await translator.translate("title", JA_TITLE)).toBe(ZH_TITLE);
  });
});

describe("刮削时翻译", () => {
  let root: string;
  let dataDir: string;
  let fixturesDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kura-tr-e2e-"));
    dataDir = join(root, "data");
    fixturesDir = join(root, "fx");
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(
      join(fixturesDir, "ABC-123.json"),
      JSON.stringify({ title: JA_TITLE, plot: JA_PLOT, actors: ["演员甲"] }),
      "utf8",
    );
    requests = 0;
    failNext = false;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("覆盖 title/plot, 原文进 *_original; NFO 与占位符各取所需", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const cache = await TranslationCache.open(dataDir);
      const translator = createTranslator(new HttpClient({ minIntervalMs: 0 }), { baseUrl, apiKey: "k", model: "m" }, cache);

      await scrape(rt, {
        key: { value: "ABC-123", number: "ABC-123", contentType: "censored" },
        registry: defaultSources({ env: {} }),
        fixturesDir,
        sources: ["fixture"],
        translator,
      });

      const item = getItem(rt, "ABC-123")!;
      expect(item.title).toBe(ZH_TITLE);
      expect(item.titleOriginal).toBe(JA_TITLE);
      expect(item.plot).toBe(ZH_PLOT);
      expect(item.plotOriginal).toBe(JA_PLOT);

      // 目录名用原文(稳定), {title_zh} 才用译文
      expect(renderTemplate("{title}/{number}", item)).toBe(`${JA_TITLE}/ABC-123`);
      expect(renderTemplate("{title_zh}/{number}", item)).toBe(`${ZH_TITLE}/ABC-123`);

      // NFO: title 中文, originaltitle 日文
      const nfo = buildNfo(item);
      expect(nfo).toContain(`<title>${ZH_TITLE}</title>`);
      expect(nfo).toContain(`<originaltitle>${JA_TITLE}</originaltitle>`);
    } finally {
      rt.close();
    }
  });

  test("手动 translate --pending: 只挑含日文的条目, 且重跑一次不再请求", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      await scrape(rt, {
        key: { value: "ABC-123", number: "ABC-123", contentType: "censored" },
        registry: defaultSources({ env: {} }),
        fixturesDir,
        sources: ["fixture"],
      });

      expect(pendingTranslationKeys(rt)).toEqual(["ABC-123"]);

      const cache = await TranslationCache.open(dataDir);
      const translator = createTranslator(new HttpClient({ minIntervalMs: 0 }), { baseUrl, apiKey: "k", model: "m" }, cache);
      const report = await translateItem(rt, "ABC-123", translator);
      expect(report.translated).toEqual(["title", "plot"]);

      // 已翻译(无假名) → 不再进待翻译队列
      expect(pendingTranslationKeys(rt)).toEqual([]);
    } finally {
      rt.close();
    }
  });
});
