import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { sep } from "node:path";
import { parseTmdbKey } from "../sources/tmdb";
import { locateEpisode } from "../domain/episodes";
import { nfoPathFor } from "../domain/nfo";
import {
  mergeTvNfo,
  renderEpisodeNfo,
  renderMovieNfo,
  renderTvShowNfo,
  type EpisodeNfoFields,
  type MovieNfoFields,
  type TvShowNfoFields,
} from "../domain/nfo-tv";
import type { Runtime } from "../runtime";
import { createTask, runTask, type TaskRow } from "./queue";

/**
 * 影视域的 NFO 导出:**只写不读**(ADR 0008 决策 6)。
 *
 * av 域之所以要回读, 是因为那边的 nfo 多是别的工具生成的旧库;
 * 影视恰好相反 —— Emby / Jellyfin 会主动写集级 nfo(标记已看、改集名),
 * 回读等于把播放器的内部状态当元数据吸进库里。所以这里只有写方向。
 */

export type TvNfoAction = "create" | "update" | "skip" | "error";

export interface TvNfoEntry {
  path: string;
  /** `tvshow` / `episode` / `movie`。 */
  kind: "tvshow" | "episode" | "movie";
  key: string;
  action: TvNfoAction;
  /** 改了什么;dry-run 时就是给人看的清单。 */
  changed: string[];
  error?: string;
}

export interface TvNfoReport {
  dryRun: boolean;
  /** 处理了多少个剧条目。 */
  shows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  cancelled: boolean;
  entries: TvNfoEntry[];
}

export interface TvNfoOptions {
  libraryId?: number;
  /** 只处理这些条目(重试失败项时用)。 */
  keys?: string[];
  apply: boolean;
  limit?: number;
  /** 并发写盘数, 默认 8(移动硬盘上单次 read+write+rename 约 1.5 秒)。 */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { index: number; total: number; key: string; action: TvNfoAction }) => void;
}

interface ShowRow {
  number: string;
  title: string | null;
  title_original: string | null;
  plot: string | null;
  release_date: string | null;
  duration_min: number | null;
  studio: string | null;
  actors: string | null;
  tags: string | null;
}

interface EpisodeRow {
  season: number;
  episode: number;
  title: string | null;
  plot: string | null;
  air_date: string | null;
  duration_min: number | null;
}

interface FileRow {
  path: string;
  season: number | null;
  episode: number | null;
}

/** 一个待写目标: 剧级 tvshow.nfo、集级 nfo、或电影的 nfo。 */
interface NfoJob {
  path: string;
  kind: "tvshow" | "episode" | "movie";
  key: string;
  render: () => string;
  merge: (original: string) => { content: string; changed: string[] };
}

/**
 * 影视 nfo 导出。
 *
 * **并发 8**: 以前是纯串行 —— 每部剧先写 tvshow.nfo, 再一集一集 `await`。
 * 移动硬盘上单次 read+write+rename 约 1.5 秒, 于是 1,548 个文件要跑 40 分钟,
 * 用户看到「正在写… 5/82」卡着不动。番号制那条路一直是 8 并发。
 *
 * 工作量口径也从"剧数"改成"文件数": 82 部剧里有 1,466 集, 只报 5/82 等于没报。
 */
export async function exportTvNfo(rt: Runtime, options: TvNfoOptions): Promise<TvNfoReport> {
  const report: TvNfoReport = {
    dryRun: !options.apply,
    shows: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    cancelled: false,
    entries: [],
  };

  const shows = listTvShows(rt, options);
  const roots = new Map<number, string>();
  for (const row of rt.db.all<{ id: number; root: string }>("select id, root from libraries")) roots.set(row.id, row.root);

  // 先把要写的目标全部列出来(纯 DB 查询 + 纯函数), 再并发执行 ——
  // 不在并发体里查库, 免得一集一集地串行等 IO。
  const jobs: NfoJob[] = [];
  const skipped: TvNfoEntry[] = [];

  for (const show of shows) {
    report.shows++;
    if (options.signal?.aborted) {
      report.cancelled = true;
      break;
    }
    const files = filesOf(rt, show.number, options.libraryId);
    if (files.length === 0) {
      skipped.push({ path: "", kind: "tvshow", key: show.number, action: "skip", changed: ["没有绑定文件"] });
      continue;
    }

    const tmdb = parseTmdbKey(show.number);
    const dir = showDirOf(files[0]!.path, roots, rt);
    const showFields: TvShowNfoFields = {
      title: show.title,
      originalTitle: show.title_original,
      plot: show.plot,
      premiered: show.release_date,
      studio: show.studio,
      genres: parseList(show.tags),
      actors: parseList(show.actors),
      tmdbId: tmdb ? String(tmdb.id) : null,
      // 本地条目(UGC): 没有 TMDB id, 但必须留身份, 否则换电脑后这份 nfo 认不回来。
      kuraId: tmdb ? null : show.number,
    };

    // 电影: <视频名>.nfo 根 <movie>。
    // 曾经把电影也当成剧写进 `<目录>/tvshow.nfo` —— Emby 于是把整个电影文件夹当电视剧,
    // 一部电影变成"剧集 0 季 0 集", 而真正的 movie nfo 根本没生成。
    if (tmdb?.kind === "movie") {
      const movieFields: MovieNfoFields = {
        title: show.title,
        originalTitle: show.title_original,
        plot: show.plot,
        premiered: show.release_date,
        studio: show.studio,
        runtimeMin: show.duration_min,
        genres: parseList(show.tags),
        actors: parseList(show.actors),
        tmdbId: String(tmdb.id),
        kuraId: null,
      };
      jobs.push({
        path: nfoPathFor(files[0]!.path),
        kind: "movie",
        key: show.number,
        render: () => renderMovieNfo(movieFields),
        merge: (original) => mergeTvNfo(original, "movie", movieFields),
      });
      continue;
    }

    // 剧级: <剧目录>/tvshow.nfo
    jobs.push({
      path: `${dir}${sep}tvshow.nfo`,
      kind: "tvshow",
      key: show.number,
      render: () => renderTvShowNfo(showFields),
      merge: (original) => mergeTvNfo(original, "tvshow", showFields),
    });

    // 集级: 每个绑了集号的视频旁边一个同名 nfo
    const episodes = new Map<string, EpisodeRow>();
    for (const row of rt.db.all<EpisodeRow>(
      "select season, episode, title, plot, air_date, duration_min from episodes where number = ?",
      [show.number],
    )) {
      episodes.set(`${row.season}-${row.episode}`, row);
    }

    for (const file of files) {
      if (file.season === null || file.episode === null) continue;
      const episode = episodes.get(`${file.season}-${file.episode}`);
      const fields: EpisodeNfoFields = {
        title: episode?.title ?? null,
        plot: episode?.plot ?? null,
        aired: episode?.air_date ?? null,
        runtimeMin: episode?.duration_min ?? null,
        season: file.season,
        episode: file.episode,
        tmdbId: tmdb ? String(tmdb.id) : null,
      };
      jobs.push({
        path: nfoPathFor(file.path),
        kind: "episode",
        key: show.number,
        render: () => renderEpisodeNfo(fields),
        merge: (original) => mergeTvNfo(original, "episodedetails", fields),
      });
    }
  }

  for (const entry of skipped) tally(report, entry);

  // 并发执行。结果按下标回填: 报告里的清单顺序稳定, 不是"谁先写完谁在前"。
  const total = jobs.length;
  const results = new Array<TvNfoEntry | undefined>(total);
  let cursor = 0;
  let done = 0;
  const workers = Math.max(1, Math.min(options.concurrency ?? 8, total));

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) {
        report.cancelled = true;
        return;
      }
      const index = cursor++;
      if (index >= total) return;
      const job = jobs[index]!;
      const entry = await writeOne({ path: job.path, kind: job.kind, key: job.key, apply: options.apply, render: job.render, merge: job.merge });
      results[index] = entry;
      done++;
      options.onProgress?.({ index: done, total, key: entry.key, action: entry.action });
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));

  for (const entry of results) if (entry) tally(report, entry);
  return report;
}

/** 影视 nfo 一共有多少个目标(剧级 + 集级 + 电影) —— 任务行的 total 用它。 */
export function countTvNfoTargets(rt: Runtime, options: { libraryId?: number; keys?: string[] } = {}): number {
  const shows = listTvShows(rt, { ...options, limit: Number.MAX_SAFE_INTEGER }).length;
  const where = ["l.domain = 'video'", "m.number is not null", "m.season is not null", "m.episode is not null"];
  const params: (number | string)[] = [];
  if (options.libraryId !== undefined) {
    where.push("m.library_id = ?");
    params.push(options.libraryId);
  }
  if (options.keys && options.keys.length > 0) {
    where.push(`m.number in (${options.keys.map(() => "?").join(", ")})`);
    params.push(...options.keys.map((key) => key.toLowerCase()));
  }
  const episodes =
    rt.db.get<{ c: number }>(
      `select count(*) c from media_files m join libraries l on l.id = m.library_id where ${where.join(" and ")}`,
      params,
    )?.c ?? 0;
  return shows + episodes;
}

export async function exportTvNfoTask(
  rt: Runtime,
  options: TvNfoOptions,
  signal: AbortSignal,
): Promise<{ task: TaskRow; result: TvNfoReport | null }> {
  const total = countTvNfoTargets(rt, options);
  const task = createTask(rt, {
    type: "nfo.tv",
    payload: { libraryId: options.libraryId ?? null, apply: options.apply },
    total,
  });

  return runTask(rt, task, signal, async (run) => {
    const result = await exportTvNfo(rt, {
      ...options,
      signal: run.signal,
      onProgress: (progress) => {
        run.progress(progress.index, progress.action === "error" ? 1 : 0, progress.total);
        run.log.write("item", { ...progress });
        options.onProgress?.(progress);
      },
    });
    // processed 用"写过的文件数", 不是"剧数" —— 82 部剧里有 1,466 集, 只报 5/82 等于没进度
    // 失败原因进 jsonl: 任务详情的「失败 N」靠它列出是哪几个、为什么。
    // 以前只记了进度事件, 于是"失败 24"点开是空的。
    for (const entry of result.entries) {
      if (!entry.error) continue;
      run.log.write("item", { key: entry.key, path: entry.path, ok: false, error: entry.error });
    }
    return { result, processed: result.created + result.updated + result.skipped, failed: result.errors };
  });
}

/** 要处理的剧条目: 影视域、在某个库里、有 TMDB 身份。 */
export function listTvShows(
  rt: Runtime,
  options: { libraryId?: number; keys?: string[]; limit?: number } = {},
): ShowRow[] {
  const where = ["items.domain in ('tv','movie')"];
  const params: (number | string)[] = [];
  if (options.libraryId !== undefined) {
    where.push("exists (select 1 from media_files mf where mf.number = items.number and mf.library_id = ?)");
    params.push(options.libraryId);
  }
  if (options.keys && options.keys.length > 0) {
    where.push(`items.number in (${options.keys.map(() => "?").join(", ")})`);
    params.push(...options.keys.map((key) => key.toLowerCase()));
  }
  params.push(options.limit ?? 500);
  return rt.db.all<ShowRow>(
    `select number, title, title_original, plot, release_date, duration_min, studio, actors, tags
     from items where ${where.join(" and ")} order by number limit ?`,
    params,
  );
}

function filesOf(rt: Runtime, key: string, libraryId?: number): FileRow[] {
  const where = ["number = ?"];
  const params: (number | string)[] = [key];
  if (libraryId !== undefined) {
    where.push("library_id = ?");
    params.push(libraryId);
  }
  return rt.db.all<FileRow>(`select path, season, episode from media_files where ${where.join(" and ")} order by path`, params);
}

function showDirOf(path: string, roots: Map<number, string>, rt: Runtime): string {
  // 库里记的是绝对路径, 剧目录由集号解析规则推断(有季目录时上溯一层)
  const libraryId = rt.db.get<{ library_id: number }>("select library_id from media_files where path = ?", [path])?.library_id;
  const root = libraryId !== undefined ? roots.get(libraryId) ?? "" : "";
  return locateEpisode(path, root)?.showDir ?? path.slice(0, path.lastIndexOf(sep));
}

interface WriteArgs {
  path: string;
  kind: "tvshow" | "episode" | "movie";
  key: string;
  apply: boolean;
  render: () => string;
  merge: (original: string) => { content: string; changed: string[] };
}

/** 有 nfo 就字段级合并, 没有就新建;内容没变就不写(不抖 mtime)。 */
async function writeOne(args: WriteArgs): Promise<TvNfoEntry> {
  const base = { path: args.path, kind: args.kind, key: args.key };
  try {
    const original = await readText(args.path);
    if (original === null) {
      const content = args.render();
      if (args.apply) await writeFileAtomic(args.path, content);
      return { ...base, action: "create", changed: ["(新建)"] };
    }
    const merged = args.merge(original);
    if (merged.changed.length === 0) return { ...base, action: "skip", changed: [] };
    if (args.apply) await writeFileAtomic(args.path, merged.content);
    return { ...base, action: "update", changed: merged.changed };
  } catch (err) {
    return { ...base, action: "error", changed: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function tally(report: TvNfoReport, entry: TvNfoEntry): void {
  if (entry.action === "create") report.created++;
  else if (entry.action === "update") report.updated++;
  else if (entry.action === "error") report.errors++;
  else report.skipped++;
  report.entries.push(entry);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** 先写临时文件再改名: 中途失败留下的是临时文件, 不是半截 nfo。 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.kura-tmp`;
  const attempt = async (): Promise<void> => {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  };
  try {
    await attempt();
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    // 外置 USB 机械盘偶发 `EIO: i/o error`(实测一次同步 24 个文件栽在这上面),
    // 隔一会儿重试通常就过去了; 真坏道第二次仍失败, 那时才报错。
    if ((err as NodeJS.ErrnoException).code !== "EIO") throw err;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await attempt();
  }
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

