import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { locateEpisode, showDirOf } from "../domain/episodes";
import { parseTmdbKey } from "../sources/tmdb";
import { metadataColumns, rowToMetadata, type ItemRow } from "../db/rows";
import type { Runtime } from "../runtime";
import type { Metadata, RawFields } from "../domain/types";
import { HttpClient } from "../net/http";
import { resolveProxyUrl } from "../config";

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

/**
 * 条目没有图片 URL 时, 按 TMDB 身份现查一次, 把 URL 写回库里。
 *
 * 为什么需要: 从 nfo 恢复的条目, 元数据是从盘上的 nfo 读回来的 —— nfo 里没有图片地址,
 * 于是 `poster_urls` 是空的,「下载图片」直接报"该条目没有图片 URL"。但**身份还在**
 * (`tmdb:movie:1927`), 图完全能重新要到。
 *
 * 只在"一条 URL 都没有"时动手: 已经有 URL 说明还有别的来源(av 站的多个镜像),
 * 不该拿 TMDB 覆盖掉。
 */
export async function refillArtworkUrls(
  rt: Runtime,
  tmdb: { movie(id: number): Promise<{ fields: RawFields } | null>; show(id: number): Promise<{ fields: RawFields } | null> },
  key: string,
): Promise<boolean> {
  const parsed = parseTmdbKey(key);
  if (!parsed) return false;
  const row = rt.db.get<ItemRow>("select * from items where number = ?", [key]);
  if (!row) return false;

  const current = rowToMetadata(row);
  if ((current.poster_urls?.length ?? 0) > 0 || (current.thumb_urls?.length ?? 0) > 0) return false;

  const found = parsed.kind === "tv" ? await tmdb.show(parsed.id) : await tmdb.movie(parsed.id);
  const poster = found?.fields.poster_urls;
  const thumb = found?.fields.thumb_urls;
  if (!poster && !thumb) return false;

  const sources = { ...current.fieldSources };
  if (poster) sources.poster_urls = "tmdb";
  if (thumb) sources.thumb_urls = "tmdb";
  const patch: Metadata = {
    ...current,
    poster_urls: poster ?? current.poster_urls,
    thumb_urls: thumb ?? current.thumb_urls,
    fieldSources: sources,
  };
  const columns = metadataColumns(patch);
  const entries = Object.entries(columns).filter(([column]) => column !== "number" && column !== "actors");
  rt.db.run(`update items set ${entries.map(([column]) => `${column} = ?`).join(", ")}, updated_at = unixepoch() where number = ?`, [
    ...entries.map(([, value]) => value),
    key,
  ]);
  return true;
}

const SIDECAR_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

/**
 * 视频文件旁边**已经存在**的图片 (别的工具下好的), 按常见命名找一遍。
 *
 * 存在的理由: 很多人早就用别的工具把图存成了 `<视频名>-poster.jpg`, 再让 Kura 下一遍
 * 既浪费流量又可能存成两张不同的图。有就地用, 没有才下载。
 */
export function findSidecarImages(videoPath: string): { poster: string | null; thumb: string | null } {
  // 影视整理之后视频在 `<剧>/Season 01/xxx.mkv` 里, 而图在**剧目录** —— 只查同目录会
  // 一个都找不到。真机症状: 盘上明明有 poster.jpg / fanart.jpg, 详情页却说「未缓存 · 下载」。
  const dir = dirname(videoPath);
  const showDir = showDirOf(videoPath);
  for (const directory of showDir === dir ? [dir] : [dir, showDir]) {
    const found = findInDirectory(directory, videoPath);
    if (found.poster || found.thumb) return found;
  }
  return { poster: null, thumb: null };
}

function findInDirectory(directory: string, videoPath: string): { poster: string | null; thumb: string | null } {
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
/** 刮削顺手存图的结果。失败一律不影响刮削本身 —— 图是附赠, 不是前提。 */
export interface ImageSaveResult {
  /** 已经落在本地缓存里 (= 之后整理/「下载图片」/NFO 都能直接用)。 */
  poster: boolean;
  thumb: boolean;
  /** 没做的原因: 设置关掉了 / 条目本来就没有图片地址。 */
  skipped?: "disabled" | "no-url";
  /** 做了但失败了(网络/403)。 */
  error?: string;
}

/**
 * 刮完顺手把海报/剧照落到本地缓存。
 *
 * 为什么要有这一步: 图是**整理**与「下载图片」的输入 —— 缓存里没有图, 整理时就只能
 * 干看着 `poster.jpg` 那个位置空着, 而那时候再补下载就得人一个个点。
 *
 * 刻意只写缓存, 不往媒体目录里塞: 目录归整理管, 让刮削也动磁盘会让"整理是唯一
 * 改磁盘的动作"这条边界破掉, 而且批量刮削时每个视频旁边多出两张图也没人想要。
 */
export async function saveItemImages(
  rt: Runtime,
  metadata: Metadata,
  options: { enabled?: boolean; http?: HttpClient } = {},
): Promise<ImageSaveResult> {
  const enabled = options.enabled ?? rt.settings.saveImages !== false;
  if (!enabled) return { poster: false, thumb: false, skipped: "disabled" };

  const urls = [...(metadata.poster_urls ?? []), ...(metadata.cover_urls ?? []), ...(metadata.thumb_urls ?? [])];
  if (urls.length === 0) return { poster: false, thumb: false, skipped: "no-url" };

  // 已经有了就不重复下载: 重复刮削是常态, 每次都重下一遍纯属浪费。
  const cached = { poster: Boolean(cachedPoster(rt, metadata)), thumb: Boolean(cachedThumb(rt, metadata)) };
  if (cached.poster && cached.thumb) return cached;

  try {
    const http = options.http ?? new HttpClient({ proxy: await resolveProxyUrl(rt.settings) });
    const result = await downloadPoster(rt, http, metadata);
    return {
      poster: Boolean(result.poster) || cached.poster,
      thumb: Boolean(result.thumb) || cached.thumb,
      ...(result.poster || result.thumb
        ? {}
        : { error: result.failures[0]?.error ?? "所有图片地址都下载失败" }),
    };
  } catch (err) {
    return { poster: cached.poster, thumb: cached.thumb, error: err instanceof Error ? err.message : String(err) };
  }
}

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
