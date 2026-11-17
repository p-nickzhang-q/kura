import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode as encodeJpeg, decode as decodeJpeg } from "jpeg-js";
import type { Metadata } from "../src/domain/types";
import { HttpClient } from "../src/net/http";
import { openRuntime } from "../src/runtime";
import { croppedCoverKey, downloadPoster, findResource } from "../src/tasks/resources";

/**
 * 真实 JPEG 的端到端用例: 站点给 800×537 的包装展开图 + 147×200 的竖版小图,
 * 下载后应当缓存并返回**裁好的封面**, 而不是把展开图当海报交出去。
 */

function paint(width: number, height: number, fn: (u: number, v: number) => number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.max(0, Math.min(255, Math.round(fn(x / width, y / height))));
      const i = (y * width + x) * 4;
      out[i] = value;
      out[i + 1] = value;
      out[i + 2] = value;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** 左半=密集小方块(封底剧照阵列), 右半=中央亮圆的"一张大照片"(封面)。 */
function panorama(width = 800, height = 537): Uint8Array {
  return paint(width, height, (u, v) => {
    if (u < 0.5) {
      const cell = Math.floor(u * 20) + Math.floor(v * 14);
      return cell % 2 === 0 ? 40 : 210;
    }
    const distance = Math.hypot((u - 0.75) * 1.4, v - 0.45);
    return distance < 0.3 ? 200 - distance * 200 : 30;
  });
}

/** 右半的缩略版, 就是站点给的 ps.jpg。 */
function thumbOf(panoramaData: Uint8Array, panoramaWidth: number, panoramaHeight: number): Uint8Array {
  return paint(147, 200, (u, v) => {
    const x = Math.min(panoramaWidth - 1, Math.floor(panoramaWidth / 2 + u * (panoramaWidth / 2)));
    const y = Math.min(panoramaHeight - 1, Math.floor(v * panoramaHeight));
    return panoramaData[(y * panoramaWidth + x) * 4]!;
  });
}

const PANO = panorama();
const THUMB = thumbOf(PANO, 800, 537);
const PANO_JPEG = encodeJpeg({ data: PANO, width: 800, height: 537 }, 85).data;
const THUMB_JPEG = encodeJpeg({ data: THUMB, width: 147, height: 200 }, 85).data;

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/pl.jpg") return new Response(PANO_JPEG, { headers: { "content-type": "image/jpeg" } });
    if (url.pathname === "/ps.jpg") return new Response(THUMB_JPEG, { headers: { "content-type": "image/jpeg" } });
    return new Response("missing", { status: 404 });
  },
});

afterAll(() => server.stop(true));

const base = `http://127.0.0.1:${server.port}`;

let root: string;
let rt: Awaited<ReturnType<typeof openRuntime>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-crop-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

function metadata(overrides: Partial<Metadata> = {}): Metadata {
  return {
    key: "ABC-123",
    number: "ABC-123",
    contentType: "censored",
    title: "示例",
    poster_urls: [`${base}/pl.jpg`],
    thumb_urls: [`${base}/ps.jpg`],
    fieldSources: {},
    ...overrides,
  };
}

describe("包装展开图 → 封面", () => {
  test("800×537 的展开图被裁成竖版封面, 且留的是右半", async () => {
    const http = new HttpClient({ minIntervalMs: 0, retries: 0 });
    const result = await downloadPoster(rt, http, metadata());

    expect(result.poster).not.toBeNull();
    // 不再把展开图交出去
    expect(result.poster!.url).toBe(croppedCoverKey(`${base}/pl.jpg`));

    const bytes = new Uint8Array(await Bun.file(result.poster!.path).arrayBuffer());
    const decoded = decodeJpeg(bytes, { useTArray: true });
    expect(decoded.width).toBe(400);
    expect(decoded.height).toBe(537);
    expect(decoded.width).toBeLessThan(decoded.height);
  });

  test("裁好的图进缓存, 再刮一次不重复解码", async () => {
    const http = new HttpClient({ minIntervalMs: 0, retries: 0 });
    const first = await downloadPoster(rt, http, metadata());
    const second = await downloadPoster(rt, http, metadata());

    expect(second.poster!.path).toBe(first.poster!.path);
    expect(findResource(rt, croppedCoverKey(`${base}/pl.jpg`))).not.toBeNull();
    // 原图仍在缓存里 —— 裁切是派生物, 不顶替原图
    expect(findResource(rt, `${base}/pl.jpg`)).not.toBeNull();
  });

  test("没有缩略图当尺子时不裁, 原样返回展开图", async () => {
    const http = new HttpClient({ minIntervalMs: 0, retries: 0 });
    const result = await downloadPoster(rt, http, metadata({ thumb_urls: undefined }));

    expect(result.poster!.url).toBe(`${base}/pl.jpg`);
    expect(findResource(rt, croppedCoverKey(`${base}/pl.jpg`))).toBeNull();
  });

  test("缩略图与展开图对不上时不裁, 退回竖版小图而不是展开图", async () => {
    const unrelated = encodeJpeg(
      { data: paint(147, 200, (u, v) => ((u * 7 + v * 13) % 1) * 255), width: 147, height: 200 },
      85,
    ).data;
    const local = Bun.serve({
      port: 0,
      fetch() {
        return new Response(unrelated, { headers: { "content-type": "image/jpeg" } });
      },
    });
    try {
      const thumbUrl = `http://127.0.0.1:${local.port}/ps.jpg`;
      const http = new HttpClient({ minIntervalMs: 0, retries: 0 });
      const result = await downloadPoster(rt, http, metadata({ thumb_urls: [thumbUrl] }));

      // 没裁, 但也不把展开图交出去 —— 147×200 放大怱是怱, 版面至少是对的。
      expect(result.poster!.url).toBe(thumbUrl);
      expect(findResource(rt, croppedCoverKey(`${base}/pl.jpg`))).toBeNull();
    } finally {
      local.stop(true);
    }
  });
});
