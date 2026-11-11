import { describe, expect, test } from "bun:test";
import { checkUpdate, compareVersion } from "../src/update";
import type { FetchLike } from "../src/net/http";

function fakeFetch(reply: () => Response | Promise<Response>): FetchLike {
  return (() => Promise.resolve(reply())) as FetchLike;
}

function release(tag: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ tag_name: tag, html_url: `https://github.com/p-nickzhang-q/kura/releases/tag/${tag}`, published_at: "2026-11-10T10:27:12Z", ...extra }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("版本比对", () => {
  test("逐段比数字, 不是字符串比", () => {
    expect(compareVersion("0.6.34", "0.6.34")).toBe(0);
    expect(compareVersion("0.6.35", "0.6.34")).toBe(1);
    expect(compareVersion("0.6.34", "0.6.35")).toBe(-1);
    // 字符串比会在这里翻车
    expect(compareVersion("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersion("1.0.0", "0.99.99")).toBe(1);
  });

  test("剥 v 前缀与 -dev 后缀", () => {
    expect(compareVersion("v0.6.34", "0.6.34")).toBe(0);
    expect(compareVersion("0.6.34-dev", "0.6.34")).toBe(0);
    expect(compareVersion("v0.6.35-beta.1", "0.6.34")).toBe(1);
  });

  test("段数不一样也不炸", () => {
    expect(compareVersion("1.2", "1.2.0")).toBe(0);
    expect(compareVersion("1.2.0.1", "1.2")).toBe(1);
  });
});

describe("检查更新", () => {
  test("线上更新 → newer true, 带发布页地址", async () => {
    const result = await checkUpdate({ current: "0.6.34", fetch: fakeFetch(() => release("v0.6.35")) });
    expect(result.newer).toBe(true);
    expect(result.latest).toBe("0.6.35");
    expect(result.url).toContain("/releases/tag/v0.6.35");
    expect(result.error).toBeNull();
  });

  test("同版本 → newer false", async () => {
    const result = await checkUpdate({ current: "0.6.34", fetch: fakeFetch(() => release("v0.6.34")) });
    expect(result.newer).toBe(false);
    expect(result.latest).toBe("0.6.34");
  });

  test("本地比线上新 → 不算有更新", async () => {
    const result = await checkUpdate({ current: "0.6.36", fetch: fakeFetch(() => release("v0.6.34")) });
    expect(result.newer).toBe(false);
  });

  test("没发过 release (404) → 明确说, 不当成已是最新", async () => {
    const result = await checkUpdate({ current: "0.6.34", fetch: fakeFetch(() => new Response("{}", { status: 404 })) });
    expect(result.newer).toBe(false);
    expect(result.error).toContain("还没有发布过 release");
  });

  test("网络不通 → 返回 error, 不抛", async () => {
    const failing = (() => Promise.reject(new Error("getaddrinfo ENOTFOUND api.github.com"))) as FetchLike;
    const result = await checkUpdate({ current: "0.6.34", fetch: failing });
    expect(result.newer).toBe(false);
    expect(result.error).toContain("连不上 GitHub");
  });

  test("超时 → 说超时", async () => {
    const timeout = (() => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }))) as FetchLike;
    const result = await checkUpdate({ current: "0.6.34", fetch: timeout });
    expect(result.error).toContain("超时");
  });

  test("HTTP 500 与坏 JSON 都不抛", async () => {
    const bad = await checkUpdate({ current: "0.6.34", fetch: fakeFetch(() => new Response("x", { status: 500 })) });
    expect(bad.error).toContain("HTTP 500");

    const garbage = await checkUpdate({
      current: "0.6.34",
      fetch: fakeFetch(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })),
    });
    expect(garbage.error).toContain("看不懂");
  });

  test("release 没有 tag_name → 报出来, 不静默当最新", async () => {
    const result = await checkUpdate({ current: "0.6.34", fetch: fakeFetch(() => release("", { tag_name: undefined })) });
    expect(result.error).toContain("tag_name");
  });
});
