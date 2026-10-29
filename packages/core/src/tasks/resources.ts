import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Metadata } from "../domain/types";
import type { HttpClient } from "../net/http";
import type { Runtime } from "../runtime";

/**
 * 图片资源的本地缓存: URL → 文件。
 *
 * 方向与 NFO 一致: **DB 是源, 文件是产物**。缓存目录归进程自己管 (`dataDir/resources`),
 * 整理时才复制到媒体库, 所以删库重建不需要重新下载。
 */
export interface LocalResource {
  url: string;
  path: string;
  contentType: string;
  size: number;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

interface ResourceRow {
  url: string;
  path: string;
  content_type: string | null;
  size: number;
}

export function resourceDir(rt: Runtime): string {
  return join(rt.paths.dataDir, "resources");
}

export function findResource(rt: Runtime, url: string | undefined): LocalResource | null {
  if (!url) return null;
  const row = rt.db.get<ResourceRow>("select url, path, content_type, size from resources where url = ?", [url]);
  if (!row) return null;
  // 文件被人手工删掉时按未缓存处理, 否则整理会复制一个不存在的文件。
  if (!existsSync(row.path)) return null;
  return { url: row.url, path: row.path, contentType: row.content_type ?? "", size: row.size };
}

/**
 * 图片 CDN 基本都开了防盗链: 不带 Referer 直接 403。
 * 这里按 URL 主机推断该站点的 Referer —— 比让调用方传更省事, 也不依赖来源实现。
 */
export function refererFor(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.endsWith("dmm.co.jp")) return "https://www.dmm.co.jp/";
    if (host.endsWith("jdbstatic.com")) return "https://javdb.com/";
    if (host.endsWith("javbus.com")) return "https://www.javbus.com/";
    return `${parsed.origin}/`;
  } catch {
    return "";
  }
}

export async function downloadResource(rt: Runtime, http: HttpClient, url: string): Promise<LocalResource> {
  const cached = findResource(rt, url);
  if (cached) return cached;

  const referer = refererFor(url);
  const { bytes, contentType } = await http.getBytes(url, referer ? { headers: { referer } } : {});
  const extension = pickExtension(contentType, url);
  const name = `${createHash("sha1").update(url).digest("hex")}${extension}`;
  const path = join(resourceDir(rt), name);

  await mkdir(resourceDir(rt), { recursive: true });
  await writeFile(path, bytes);
  rt.db.run(
    `insert into resources (url, path, content_type, size, fetched_at) values (?, ?, ?, ?, unixepoch())
     on conflict(url) do update set path = excluded.path, content_type = excluded.content_type,
       size = excluded.size, fetched_at = unixepoch()`,
    [url, path, contentType, bytes.byteLength],
  );

  return { url, path, contentType, size: bytes.byteLength };
}

export interface PosterDownloadResult {
  key: string;
  poster: LocalResource | null;
  tried: string[];
  failures: { url: string; error: string }[];
}

/**
 * 按 poster → cover 的顺序试, 第一个成功的就用。
 * 单张图失败不影响其它候选 —— 站点图片 CDN 比页面更容易抽风。
 */
export async function downloadPoster(
  rt: Runtime,
  http: HttpClient,
  metadata: Metadata,
): Promise<PosterDownloadResult> {
  const candidates = [...(metadata.poster_urls ?? []), ...(metadata.cover_urls ?? [])].filter(
    (url, index, all) => url && all.indexOf(url) === index,
  );

  const failures: { url: string; error: string }[] = [];
  for (const url of candidates) {
    try {
      return { key: metadata.key, poster: await downloadResource(rt, http, url), tried: candidates, failures };
    } catch (err) {
      failures.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { key: metadata.key, poster: null, tried: candidates, failures };
}

/** 整理时用: 已缓存的海报/封面里取第一张, 不做任何网络请求。 */
export function cachedPoster(rt: Runtime, metadata: Metadata): LocalResource | null {
  for (const url of [...(metadata.poster_urls ?? []), ...(metadata.cover_urls ?? [])]) {
    const found = findResource(rt, url);
    if (found) return found;
  }
  return null;
}

function pickExtension(contentType: string, url: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const known = EXT_BY_TYPE[type];
  if (known) return known;

  try {
    const fromUrl = extname(new URL(url).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(fromUrl)) {
      return fromUrl === ".jpeg" ? ".jpg" : fromUrl;
    }
  } catch {
    // URL 不合法就退回默认扩展名
  }
  return ".jpg";
}
