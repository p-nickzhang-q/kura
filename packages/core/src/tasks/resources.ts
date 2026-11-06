import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { locateEpisode } from "../domain/episodes";
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
  /** 竖版海报 (Emby 的 poster 位)。 */
  poster: LocalResource | null;
  /** 横版缩略图 (Emby 的 thumb 位)。没有就是一个 null —— 整理时退回用 poster。 */
  thumb: LocalResource | null;
  tried: string[];
  failures: { url: string; error: string }[];
}

/** 依次尝试候选地址, 第一个成功的就返回; 全失败返回 null。 */
async function firstOk(
  rt: Runtime,
  http: HttpClient,
  candidates: string[],
  failures: { url: string; error: string }[],
): Promise<LocalResource | null> {
  for (const url of candidates) {
    try {
      return await downloadResource(rt, http, url);
    } catch (err) {
      failures.push({ url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return null;
}

function unique(urls: string[] | undefined): string[] {
  const list = urls ?? [];
  return list.filter((url, index) => url && list.indexOf(url) === index);
}

/**
 * 下载两张图: 竖版海报 (poster → cover 兜底) 与横版缩略图 (thumb)。
 *
 * 分开下是因为它们在 Emby/Kodi 里位子不同: `<poster>` 是竖版主图, `<thumb>` 是横版缩略图。
 * 之前只下一张, 再把竖版图塞进 `<thumb>`, 于是缩略图位显示的是被压扁的海报。
 * 缩略图很小 (几十 KB), 多一次请求换来正确的版面。
 */
export async function downloadPoster(
  rt: Runtime,
  http: HttpClient,
  metadata: Metadata,
): Promise<PosterDownloadResult> {
  const failures: { url: string; error: string }[] = [];

  const posterCandidates = unique([...(metadata.poster_urls ?? []), ...(metadata.cover_urls ?? [])]);
  const poster = await firstOk(rt, http, posterCandidates, failures);

  const thumbCandidates = unique(metadata.thumb_urls);
  const thumb = await firstOk(rt, http, thumbCandidates, failures);

  return { key: metadata.key, poster, thumb, tried: [...posterCandidates, ...thumbCandidates], failures };
}

const SIDECAR_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

/**
 * 视频文件旁边**已经存在**的图片 (别的工具下好的), 按常见命名找一遍。
 *
 * 存在的理由: 很多人早就用别的工具把图存成了 `<视频名>-poster.jpg`, 再让 Kura 下一遍
 * 既浪费流量又可能存成两张不同的图。有就地用, 没有才下载。
 */
export function findSidecarImages(videoPath: string): { poster: string | null; thumb: string | null } {
  const directory = dirname(videoPath);
  const base = basename(videoPath, extname(videoPath));

  // 先列目录再按小写比对: 用户那边可能是 POSTER.JPG / Fanart.PNG,
  // 靠文件系统的大小写不敏感只在一个平台上能用。
  let names: Map<string, string>;
  try {
    names = new Map(readdirSync(directory).map((entry) => [entry.toLowerCase(), entry]));
  } catch {
    return { poster: null, thumb: null };
  }

  const pick = (candidates: string[]): string | null => {
    for (const name of candidates) {
      for (const extension of SIDECAR_EXTENSIONS) {
        const hit = names.get(`${name}${extension}`.toLowerCase());
        if (hit) return join(directory, hit);
      }
    }
    return null;
  };

  return {
    // 越具体越优先: <视频名>-poster 比目录级的 poster 更可能是这一部的
    poster: pick([`${base}-poster`, `${base}-cover`, base, "poster", "folder", "cover"]),
    // thumb.jpg 名字最贴切, 其次 fanart / backdrop (都是横版)
    thumb: pick([`${base}-thumb`, `${base}-fanart`, "thumb", "fanart", "backdrop"]),
  };
}

/** 整理时用: 已缓存的横版缩略图, 没有网络请求。 */
export function cachedThumb(rt: Runtime, metadata: Metadata): LocalResource | null {
  for (const url of metadata.thumb_urls ?? []) {
    const found = findResource(rt, url);
    if (found) return found;
  }
  return null;
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


/**
 * 把已缓存的图复制到视频旁边, 命名与 `findSidecarImages` 认的一致。
 *
 * 为什么要有: 图只存在进程的数据目录里, 换台电脑/换个播放器就什么都看不到;
 * 存一份到片子旁边, Emby/Kodi 直接用, 整个库搬走也不用重新下载。
 * 目标已存在且大小相同就跳过 (重复点"下载图片"不该反复写盘)。
 */
export async function placeImagesBesideVideo(
  rt: Runtime,
  metadata: Metadata,
  images: { poster?: LocalResource | null; thumb?: LocalResource | null },
): Promise<{ saved: string[]; skipped: string[]; errors: string[] }> {
  const saved: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const key = metadata.number ?? metadata.key;
  const videos = rt.db.all<{ path: string }>("select path from media_files where number = ? order by path", [key]);
  if (videos.length === 0) return { saved, skipped, errors };

  // 剧集不逐集贴图: Emby / Jellyfin 要的是**目录级** `poster.jpg` + `fanart.jpg`,
  // 一部 165 集的剧逐集复制同一张海报 = 165 份冗余, 而且媒体服务器一张都不认。
  const domain = rt.db.get<{ domain: string }>("select domain from items where number = ?", [key])?.domain;
  if (domain === "tv") {
    const roots = new Map<number, string>();
    for (const row of rt.db.all<{ id: number; root: string }>("select id, root from libraries")) roots.set(row.id, row.root);
    const dirs = new Set<string>();
    for (const video of videos) {
      if (!existsSync(video.path)) continue;
      const libraryId = rt.db.get<{ library_id: number }>("select library_id from media_files where path = ?", [video.path])?.library_id;
      const root = libraryId !== undefined ? roots.get(libraryId) ?? "" : "";
      dirs.add(locateEpisode(video.path, root)?.showDir ?? dirname(video.path));
    }
    for (const dir of dirs) {
      for (const [name, image] of [
        ["poster", images.poster],
        ["fanart", images.thumb],
      ] as const) {
        if (!image) continue;
        const target = join(dir, `${name}${extname(image.path) || ".jpg"}`);
        try {
          const existing = statSync(target, { throwIfNoEntry: false });
          if (existing && existing.size === image.size) {
            skipped.push(target);
            continue;
          }
          await copyFile(image.path, target);
          saved.push(target);
        } catch (err) {
          errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { saved, skipped, errors };
  }

  for (const video of videos) {
    if (!existsSync(video.path)) continue;
    const base = video.path.slice(0, video.path.length - extname(video.path).length);

    for (const [suffix, image] of [
      ["-poster", images.poster],
      ["-thumb", images.thumb],
    ] as const) {
      if (!image) continue;
      const target = `${base}${suffix}${extname(image.path) || ".jpg"}`;
      try {
        const existing = statSync(target, { throwIfNoEntry: false });
        if (existing && existing.size === image.size) {
          skipped.push(target);
          continue;
        }
        await copyFile(image.path, target);
        saved.push(target);
      } catch (err) {
        // 只读盘/权限不足不该让"下载图片"整个失败 —— 缓存里已经有了, 界面还能显示。
        errors.push(`${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { saved, skipped, errors };
}
