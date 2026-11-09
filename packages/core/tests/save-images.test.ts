import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Metadata } from "../src/domain/types";
import { HttpClient } from "../src/net/http";
import { openRuntime, type Runtime } from "../src/runtime";
import { saveItemImages } from "../src/tasks/resources";

let root: string;
let rt: Runtime;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 假 HTTP: 只认图片地址, 记录请求过的 URL。 */
function fakeHttp(calls: string[], fail = false): HttpClient {
  const impl = (async (url: string) => {
    calls.push(String(url));
    if (fail) return new Response("nope", { status: 500 });
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch;
  return new HttpClient({ fetchImpl: impl });
}

function metadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    key: "SSIS-001",
    number: "SSIS-001",
    contentType: "censored",
    title: "示例",
    poster_urls: ["https://img.example/poster.jpg"],
    thumb_urls: ["https://img.example/thumb.jpg"],
    fieldSources: {},
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-images-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

describe("刮削顺手存图", () => {
  test("海报与剧照都进本地缓存", async () => {
    const calls: string[] = [];
    const result = await saveItemImages(rt, metadata(), { http: fakeHttp(calls) });
    expect(result).toEqual({ poster: true, thumb: true });
    expect(calls).toEqual(["https://img.example/poster.jpg", "https://img.example/thumb.jpg"]);
    // 缓存是真的落了盘: 整理/「下载图片」都从这里取
    const rows = rt.db.all<{ url: string }>("select url from resources");
    expect(rows.map((row) => row.url)).toEqual(["https://img.example/poster.jpg", "https://img.example/thumb.jpg"]);
  });

  test("已经存过的不再重复下载 (重复刮削是常态)", async () => {
    const first: string[] = [];
    await saveItemImages(rt, metadata(), { http: fakeHttp(first) });
    const second: string[] = [];
    const result = await saveItemImages(rt, metadata(), { http: fakeHttp(second) });
    expect(second).toHaveLength(0);
    expect(result).toEqual({ poster: true, thumb: true });
  });

  test("设置关掉时什么都不做", async () => {
    const calls: string[] = [];
    const result = await saveItemImages(rt, metadata(), { enabled: false, http: fakeHttp(calls) });
    expect(result).toEqual({ poster: false, thumb: false, skipped: "disabled" });
    expect(calls).toHaveLength(0);
  });

  test("条目本来就没有图片地址: 不报错, 只是没做事", async () => {
    const result = await saveItemImages(rt, metadata({ poster_urls: [], thumb_urls: [] }), { http: fakeHttp([]) });
    expect(result).toEqual({ poster: false, thumb: false, skipped: "no-url" });
  });

  test("下载失败只记原因, 不抛 —— 图是附赠品, 不能让刮削算失败", async () => {
    const result = await saveItemImages(rt, metadata(), { http: fakeHttp([], true) });
    expect(result.poster).toBe(false);
    expect(result.error).toBeString();
  });

  test("只有海报没有剧照也算存到了东西", async () => {
    const result = await saveItemImages(rt, metadata({ thumb_urls: [] }), { http: fakeHttp([]) });
    expect(result).toEqual({ poster: true, thumb: false });
  });
});
