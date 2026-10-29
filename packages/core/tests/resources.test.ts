import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNfo, buildPlan } from "../src/domain/materialize";
import type { Metadata } from "../src/domain/types";
import { HttpClient } from "../src/net/http";
import { openRuntime } from "../src/runtime";
import { cachedPoster, downloadPoster, downloadResource, findResource, refererFor, resourceDir } from "../src/tasks/resources";

// 最小的"JPEG": 只要字节能落盘、扩展名按 content-type 推断即可。
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/poster.jpg") {
      return new Response(FAKE_JPEG, { headers: { "content-type": "image/jpeg" } });
    }
    if (url.pathname === "/broken.jpg") {
      return new Response("nope", { status: 404 });
    }
    return new Response("missing", { status: 404 });
  },
});

afterAll(() => server.stop(true));

const base = `http://127.0.0.1:${server.port}`;
const metadata: Metadata = {
  key: "ABC-123",
  number: "ABC-123",
  contentType: "censored",
  title: "示例标题",
  poster_urls: [`${base}/poster.jpg`],
  cover_urls: [`${base}/poster.jpg`],
  fieldSources: {},
};

let root: string;
let rt: Awaited<ReturnType<typeof openRuntime>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-res-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

describe("downloadResource", () => {
  test("按 content-type 决定扩展名并落盘 + 记账", async () => {
    const http = new HttpClient({ minIntervalMs: 0 });
    const resource = await downloadResource(rt, http, `${base}/poster.jpg`);

    expect(resource.path).toEndWith(".jpg");
    expect(resource.size).toBe(FAKE_JPEG.byteLength);
    expect(new Uint8Array(await readFile(resource.path))).toEqual(FAKE_JPEG);
    expect((await stat(resource.path)).isFile()).toBe(true);
    expect(resource.path.startsWith(resourceDir(rt))).toBe(true);
    expect(findResource(rt, `${base}/poster.jpg`)?.path).toBe(resource.path);
  });

  test("重复下载命中缓存, 不再请求 (文件 mtime 不变)", async () => {
    const http = new HttpClient({ minIntervalMs: 0 });
    const first = await downloadResource(rt, http, `${base}/poster.jpg`);
    const before = (await stat(first.path)).mtimeMs;

    const second = await downloadResource(rt, http, `${base}/poster.jpg`);
    expect(second.path).toBe(first.path);
    expect((await stat(second.path)).mtimeMs).toBe(before);
  });

  test("文件被手工删除后视为未缓存", async () => {
    const http = new HttpClient({ minIntervalMs: 0, retries: 0 });
    const resource = await downloadResource(rt, http, `${base}/poster.jpg`);
    await rm(resource.path);
    expect(findResource(rt, `${base}/poster.jpg`)).toBeNull();
  });

  test("404 时抛错而不是写空文件", async () => {
    const http = new HttpClient({ minIntervalMs: 0, retries: 0 });
    await expect(downloadResource(rt, http, `${base}/broken.jpg`)).rejects.toThrow(/HTTP 404/);
  });
});

describe("refererFor", () => {
  test("按图片主机推断站点 Referer (防盗链)", () => {
    expect(refererFor("https://www.javbus.com/pics/cover/x_b.jpg")).toBe("https://www.javbus.com/");
    expect(refererFor("https://c0.jdbstatic.com/covers/zy/x.jpg")).toBe("https://javdb.com/");
    expect(refererFor("https://pics.dmm.co.jp/large/x.jpg")).toBe("https://www.dmm.co.jp/");
    expect(refererFor("https://example.com/a.jpg")).toBe("https://example.com/");
    expect(refererFor("not a url")).toBe("");
  });
});

describe("downloadPoster", () => {
  test("poster 失败时回退 cover", async () => {
    const http = new HttpClient({ minIntervalMs: 0, retries: 0 });
    const result = await downloadPoster(rt, http, {
      ...metadata,
      poster_urls: [`${base}/broken.jpg`],
      cover_urls: [`${base}/poster.jpg`],
    });

    expect(result.poster?.path).toEndWith(".jpg");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.url).toContain("/broken.jpg");
  });

  test("没有任何 URL 时返回 null 且不报错", async () => {
    const http = new HttpClient({ minIntervalMs: 0 });
    const result = await downloadPoster(rt, http, { ...metadata, poster_urls: [], cover_urls: [] });
    expect(result.poster).toBeNull();
    expect(result.tried).toHaveLength(0);
  });
});

describe("整理时的海报落地", () => {
  test("计划里出现 copy-image, NFO 引用相对文件名", async () => {
    const http = new HttpClient({ minIntervalMs: 0 });
    await downloadResource(rt, http, `${base}/poster.jpg`);

    const poster = cachedPoster(rt, metadata);
    expect(poster).not.toBeNull();

    const plan = buildPlan(
      { id: 1, name: "主库", root: "/media/library", template: "{content_type}/{number}" },
      [
        {
          path: "/media/library/in/ABC-123.mkv",
          metadata,
          phase: { cd: null, part: null, hasSubtitle: false, mosaic: null, definition: null },
          posterPath: poster!.path,
        },
      ],
    );

    expect(plan.summary.copyImage).toBe(1);
    const copy = plan.entries.find((entry) => entry.action === "copy-image")!;
    expect(copy.to).toBe("/media/library/有码/ABC-123/ABC-123-poster.jpg");
    expect(copy.from).toBe(poster!.path);

    const nfo = plan.entries.find((entry) => entry.action === "write-nfo")!;
    expect(nfo.content).toContain("<thumb>ABC-123-poster.jpg</thumb>");
  });

  test("没有缓存海报时不产生 copy-image, NFO 里也没有 thumb", () => {
    const plan = buildPlan(
      { id: 1, name: "主库", root: "/media/library", template: "{number}" },
      [
        {
          path: "/media/library/in/ABC-123.mkv",
          metadata: { ...metadata, poster_urls: [], cover_urls: [] },
          phase: { cd: null, part: null, hasSubtitle: false, mosaic: null, definition: null },
        },
      ],
    );
    expect(plan.summary.copyImage).toBe(0);
    expect(plan.entries.some((entry) => entry.action === "copy-image")).toBe(false);
    expect(buildNfo(metadata)).not.toContain("<thumb>");
  });
});
