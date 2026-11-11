import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNfo, buildPlan } from "../src/domain/materialize";
import type { Metadata } from "../src/domain/types";
import { HttpClient } from "../src/net/http";
import { openRuntime } from "../src/runtime";
import { cachedPoster, cachedThumb, downloadPoster, downloadResource, findResource, findSidecarImages, refererFor, resourceDir } from "../src/tasks/resources";

// 最小的"JPEG": 只要字节能落盘、扩展名按 content-type 推断即可。
const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/poster.jpg") {
      return new Response(FAKE_JPEG, { headers: { "content-type": "image/jpeg" } });
    }
    if (url.pathname === "/thumb.jpg") {
      // 横版缩略图, 内容无所谓 —— 但要是不同的字节, 免得撞上同一份缓存
      return new Response(new Uint8Array([...FAKE_JPEG, 9, 9]), { headers: { "content-type": "image/jpeg" } });
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
    const result = await downloadPoster(rt, http, { ...metadata, poster_urls: [], cover_urls: [], thumb_urls: [] });
    expect(result.poster).toBeNull();
    expect(result.thumb).toBeNull();
    expect(result.tried).toHaveLength(0);
  });

  test("缩略图单独下载: 海报竖版、缩略图横版各一张", async () => {
    const http = new HttpClient({ minIntervalMs: 0 });
    const result = await downloadPoster(rt, http, {
      ...metadata,
      poster_urls: [`${base}/poster.jpg`],
      cover_urls: [],
      thumb_urls: [`${base}/thumb.jpg`],
    });

    expect(result.poster?.url).toBe(`${base}/poster.jpg`);
    expect(result.thumb?.url).toBe(`${base}/thumb.jpg`);
    expect(result.thumb?.path).not.toBe(result.poster?.path);
  });

  test("缩略图下载失败时不影响海报", async () => {
    const http = new HttpClient({ minIntervalMs: 0, retries: 0 });
    const result = await downloadPoster(rt, http, {
      ...metadata,
      poster_urls: [`${base}/poster.jpg`],
      cover_urls: [],
      thumb_urls: [`${base}/broken-thumb.jpg`],
    });

    expect(result.poster).not.toBeNull();
    expect(result.thumb).toBeNull();
    expect(result.failures.some((failure) => failure.url.includes("broken-thumb"))).toBe(true);
  });
});

describe("整理时的海报落地", () => {
  test("计划里出现 copy-image, NFO 引用相对文件名", async () => {
    const http = new HttpClient({ minIntervalMs: 0 });
    await downloadResource(rt, http, `${base}/poster.jpg`);

    const poster = cachedPoster(rt, metadata);
    expect(poster).not.toBeNull();

    const plan = await buildPlan(
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

  test("海报与缩略图各落地一张, NFO 的 thumb 指向横版那张", async () => {
    const withThumb: Metadata = {
      ...metadata,
      poster_urls: [`${base}/poster.jpg`],
      cover_urls: [],
      thumb_urls: [`${base}/thumb.jpg`],
    };

    const http = new HttpClient({ minIntervalMs: 0 });
    const result = await downloadPoster(rt, http, withThumb);

    const poster = cachedPoster(rt, withThumb);
    const thumb = cachedThumb(rt, withThumb);
    expect(thumb?.path).toBe(result.thumb?.path);

    const plan = await buildPlan(
      { id: 1, name: "主库", root: "/media/library", template: "{content_type}/{number}" },
      [
        {
          path: "/media/library/in/ABC-123.mkv",
          metadata: withThumb,
          phase: { cd: null, part: null, hasSubtitle: false, mosaic: null, definition: null },
          posterPath: poster!.path,
          thumbPath: thumb!.path,
        },
      ],
    );

    expect(plan.summary.copyImage).toBe(2);
    const targets = plan.entries.filter((entry) => entry.action === "copy-image").map((entry) => entry.to);
    expect(targets).toContain("/media/library/有码/ABC-123/ABC-123-poster.jpg");
    expect(targets).toContain("/media/library/有码/ABC-123/ABC-123-thumb.jpg");

    const nfo = plan.entries.find((entry) => entry.action === "write-nfo")!;
    expect(nfo.content).toContain("<thumb>ABC-123-thumb.jpg</thumb>");
  });

  test("缩略图与海报是同一张时只复制一次", async () => {
    const http = new HttpClient({ minIntervalMs: 0 });
    await downloadResource(rt, http, `${base}/poster.jpg`);
    const poster = cachedPoster(rt, metadata)!;

    const plan = await buildPlan(
      { id: 1, name: "主库", root: "/media/library", template: "{number}" },
      [
        {
          path: "/media/library/in/ABC-123.mkv",
          metadata,
          phase: { cd: null, part: null, hasSubtitle: false, mosaic: null, definition: null },
          posterPath: poster.path,
          thumbPath: poster.path,
        },
      ],
    );

    expect(plan.summary.copyImage).toBe(1);
    const nfo = plan.entries.find((entry) => entry.action === "write-nfo")!;
    expect(nfo.content).toContain("<thumb>ABC-123-poster.jpg</thumb>");
  });

  test("没有缓存海报时不产生 copy-image, NFO 里也没有 thumb", async () => {
    const plan = await buildPlan(
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

describe("盘上的图: 影视整理后的布局", () => {
  test("视频在 Season 01 里, 图在剧目录 —— 也要找得到", async () => {
    const root = await mkdtemp(join(tmpdir(), "kura-sidecar-"));
    const showDir = join(root, "乡村爱情 (2006)");
    const seasonDir = join(showDir, "Season 01");
    await mkdir(seasonDir, { recursive: true });
    await writeFile(join(showDir, "poster.jpg"), "p");
    await writeFile(join(showDir, "fanart.jpg"), "f");

    const found = findSidecarImages(join(seasonDir, "乡村爱情 - S01E01.rmvb"));
    // 修复前只查 Season 01, 返回全 null → 详情页说"未缓存 · 下载", 而盘上明明有图
    expect(found.poster).toBe(join(showDir, "poster.jpg"));
    expect(found.thumb).toBe(join(showDir, "fanart.jpg"));
    await rm(root, { recursive: true, force: true });
  });

  test("同目录的图优先于剧目录 (番号制不受影响)", async () => {
    const root = await mkdtemp(join(tmpdir(), "kura-sidecar-"));
    await writeFile(join(root, "ABP-123.mp4"), "v");
    await writeFile(join(root, "ABP-123-poster.jpg"), "p");
    await writeFile(join(root, "poster.jpg"), "p2");

    const found = findSidecarImages(join(root, "ABP-123.mp4"));
    expect(found.poster).toBe(join(root, "ABP-123-poster.jpg"));
    await rm(root, { recursive: true, force: true });
  });
});
