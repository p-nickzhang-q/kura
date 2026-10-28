import { afterAll, describe, expect, test } from "bun:test";
import { AppError, EXIT } from "../src/exit";
import { HttpClient } from "../src/net/http";

let attempts = 0;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/flaky") {
      attempts++;
      if (attempts < 3) return new Response("boom", { status: 503 });
      return Response.json({ ok: true, attempts });
    }
    if (url.pathname === "/missing") {
      attempts++;
      return new Response("nope", { status: 404 });
    }
    if (url.pathname === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response("late");
    }
    return Response.json({ ok: true });
  },
});

afterAll(() => server.stop(true));

const base = `http://127.0.0.1:${server.port}`;

describe("HttpClient", () => {
  test("5xx 会重试, 成功后返回", async () => {
    attempts = 0;
    const http = new HttpClient({ retries: 2, minIntervalMs: 0 });
    const payload = await http.getJson<{ ok: boolean; attempts: number }>(`${base}/flaky`);
    expect(payload.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  test("4xx 不重试, 直接 NOT_FOUND", async () => {
    attempts = 0;
    const http = new HttpClient({ retries: 2, minIntervalMs: 0 });
    const error = await http.getText(`${base}/missing`).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(EXIT.NOT_FOUND);
    expect(attempts).toBe(1);
  });

  test("超时抛可重试错误", async () => {
    const http = new HttpClient({ timeoutMs: 50, retries: 0, minIntervalMs: 0 });
    const error = await http.getText(`${base}/slow`).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(EXIT.RETRYABLE);
  });

  test("同一客户端串行节流", async () => {
    const http = new HttpClient({ minIntervalMs: 60 });
    const started = Date.now();
    await Promise.all([http.getJson(`${base}/a`), http.getJson(`${base}/b`)]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });
});
