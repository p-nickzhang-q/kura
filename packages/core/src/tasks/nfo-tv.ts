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

  for (let index = 0; index < shows.length; index++) {
    if (options.signal?.aborted) {
      report.cancelled = true;
      break;
    }
    const show = shows[index]!;
    report.shows++;
    const files = filesOf(rt, show.number, options.libraryId);
    if (files.length === 0) {
      report.skipped++;
      report.entries.push({ path: "", kind: "tvshow", key: show.number, action: "skip", changed: ["没有绑定文件"] });
      options.onProgress?.({ index: index + 1, total: shows.length, key: show.number, action: "skip" });
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
    };

    // 电影: <视频名>.nfo 根 <movie>。
    // 曾经把电影也当成剧写进 `<目录>/tvshow.nfo` —— Emby 于是把整个电影文件夹当电视剧,
    // 一部电影变成"剧集 0 季 0 集", 而真正的 movie nfo 根本没生成。
    if (tmdb?.kind === "movie") {
      const target = nfoPathFor(files[0]!.path);
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
      };
      const entry = await writeOne({
        path: target,
        kind: "movie",
        key: show.number,
        apply: options.apply,
        render: () => renderMovieNfo(movieFields),
        merge: (original) => mergeTvNfo(original, "movie", movieFields),
      });
      tally(report, entry);
      options.onProgress?.({ index: index + 1, total: shows.length, key: show.number, action: entry.action });
      continue;
    }

    // 剧级: <剧目录>/tvshow.nfo
    const showEntry = await writeOne({
      path: `${dir}${sep}tvshow.nfo`,
      kind: "tvshow",
      key: show.number,
      apply: options.apply,
      render: () => renderTvShowNfo(showFields),
      merge: (original) => mergeTvNfo(original, "tvshow", showFields),
    });
    tally(report, showEntry);

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
      const entry = await writeOne({
        path: nfoPathFor(file.path),
        kind: "episode",
        key: show.number,
        apply: options.apply,
        render: () => renderEpisodeNfo(fields),
        merge: (original) => mergeTvNfo(original, "episodedetails", fields),
      });
      tally(report, entry);
    }

    options.onProgress?.({ index: index + 1, total: shows.length, key: show.number, action: "update" });
  }

  return report;
}

export async function exportTvNfoTask(
  rt: Runtime,
  options: TvNfoOptions,
  signal: AbortSignal,
): Promise<{ task: TaskRow; result: TvNfoReport | null }> {
  const total = listTvShows(rt, { ...options, limit: Number.MAX_SAFE_INTEGER }).length;
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
    return { result, processed: result.shows, failed: result.errors };
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
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
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

