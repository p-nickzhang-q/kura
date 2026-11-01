import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntime, type Runtime } from "../src/runtime";
import { HttpClient } from "../src/net/http";
import { openTranslator } from "../src/llm/translate";
import { countPendingTranslation, pendingTranslationKeys, translatePending, translationStats } from "../src/tasks/translate";

const SAMPLE = [
  "これは日本語のタイトルです",
  "巨乳と美少女の物語",
  "放課後の教室で",
  "夏休みの思い出",
];

let mode: "ok" | "unauthorized" | "empty" | "wrong_path" = "ok";
const requests: { path: string; auth?: string; model?: string }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as {
      model?: string;
      messages?: { role: string; content: string }[];
    };
    requests.push({ path: url.pathname, auth: request.headers.get("authorization") ?? undefined, model: body.model });

    if (mode === "wrong_path" && url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    if (mode === "unauthorized") {
      return Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 });
    }

    const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
    return Response.json({
      choices: [{ message: { role: "assistant", content: mode === "empty" ? "" : `中译: ${user.slice(0, 10)}` } }],
    });
  },
});

const config = () => ({ baseUrl: `${base}/v1`, apiKey: "sk-test-key", model: "test-model" });
const base = `http://127.0.0.1:${server.port}`;

let root: string;
let rt: Runtime;

beforeAll(() => undefined);
afterAll(() => server.stop(true));

beforeEach(async () => {
  mode = "ok";
  requests.length = 0;
  root = await mkdtemp(join(tmpdir(), "kura-llm-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
  for (let index = 0; index < 20; index++) {
    const title = `${SAMPLE[index % SAMPLE.length]} 第${index + 1}話`;
    rt.db.run("insert into items (number, content_type, title) values (?, 'censored', ?)", [
      `TST-${String(index + 1).padStart(3, "0")}`,
      title,
    ]);
  }
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

async function translator() {
  const opened = await openTranslator(rt, new HttpClient({ minIntervalMs: 0 }), config());
  expect(opened).not.toBeNull();
  return opened!;
}

describe("批量翻译: 走真实 HTTP 链路 (模拟 OpenAI 兼容端点)", () => {
  test("20 条日文标题全部翻译并落库", async () => {
    expect(countPendingTranslation(rt)).toBe(20);

    const result = await translatePending(rt, { translator: await translator(), limit: 1000 });

    expect(result.count).toBe(20);
    expect(result.translated).toBe(20);
    expect(result.failed).toBe(0);
    expect(countPendingTranslation(rt)).toBe(0);
    expect(translationStats(rt)).toEqual({ total: 20, translated: 20, pending: 0 });

    // 请求形态: 打到 /v1/chat/completions, 带 Bearer, 带 model
    expect(requests.every((r) => r.path === "/v1/chat/completions")).toBe(true);
    expect(requests.every((r) => r.auth === "Bearer sk-test-key")).toBe(true);
    expect(requests.every((r) => r.model === "test-model")).toBe(true);

    // 落库的是译文, 原文留在 title_original
    const row = rt.db.get<{ title: string; title_original: string }>(
      "select title, title_original from items where number = 'TST-001'",
    );
    expect(row?.title).toStartWith("中译:");
    expect(row?.title_original).toContain("これは日本語");
  });

  test("第二次调用不应重复请求 (命中翻译缓存)", async () => {
    await translatePending(rt, { translator: await translator(), limit: 1000 });
    const firstRound = requests.length;
    expect(firstRound).toBe(20);

    // 把标题改回日文, 制造"又要翻一遍"的局面 —— 缓存应当直接返回
    rt.db.run("update items set title = title_original, title_original = null");
    expect(countPendingTranslation(rt)).toBe(20);
    const result = await translatePending(rt, { translator: await translator(), limit: 1000 });

    expect(result.translated).toBe(20);
    expect(requests.length).toBe(firstRound); // 没有新增请求
  });

  test("401 时全失败, 且报错原文可见", async () => {
    mode = "unauthorized";
    const t = await translator();
    const result = await translatePending(rt, { translator: t, limit: 1000 });

    expect(result.translated).toBe(0);
    expect(result.failed).toBe(20);
    expect(countPendingTranslation(rt)).toBe(20); // 一条都没落库
    // 失败原因不能吞掉 (translated 返回 null, 但 translator.errors 里有原文)
    expect(t.errors.join(" ")).toContain("401");
  });

  test("模型返回空内容算无变化", async () => {
    mode = "empty";
    const result = await translatePending(rt, { translator: await translator(), limit: 1000 });
    expect(result.translated).toBe(0);
    expect(result.skipped).toBe(20);
  });

  test("baseUrl 少写 /v1 时请求打到错误路径, 全是失败", async () => {
    mode = "wrong_path";
    const opened = await openTranslator(rt, new HttpClient({ minIntervalMs: 0 }), {
      ...config(),
      baseUrl: base, // 少了 /v1
    });
    const result = await translatePending(rt, { translator: opened!, limit: 5 });

    expect(result.translated).toBe(0);
    expect(result.failed).toBe(5);
    expect(requests[0]!.path).toBe("/chat/completions");
  });

  test("取消后剩余条目仍在待翻译队列", async () => {
    const controller = new AbortController();
    const t = await translator();
    const result = await translatePending(rt, { translator: t, limit: 1000, signal: controller.signal });
    expect(result.translated).toBe(20);

    // 再来一批并立刻取消
    rt.db.run("update items set title = title_original, title_original = null");
    controller.abort();
    const cancelled = await translatePending(rt, { translator: t, limit: 1000, signal: controller.signal });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.count).toBe(0);
    expect(pendingTranslationKeys(rt).length).toBe(20);
  });
});
