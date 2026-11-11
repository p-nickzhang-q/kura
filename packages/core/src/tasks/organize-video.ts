import { existsSync } from "node:fs";
import { parsePhase } from "../db/rows";
import { readdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { findSidecarImages } from "./resources";
import { isVideoFile } from "./scan";
import {
  applyPlan,
  isKuraArtifact,
  pruneEmptyDirs,
  type PruneResult,
  sanitizeName,
  targetState,
  type ApplyResult,
  type Library,
  type Plan,
  type PlanEntry,
} from "../domain/materialize";
import { renderEpisodeNfo, renderMovieNfo, renderTvShowNfo } from "../domain/nfo-tv";
import type { Runtime } from "../runtime";
import { findResource } from "./resources";

/**
 * 影视库的整理: 把文件搬成媒体服务器认得的**目录结构**。
 *
 * 目标形状(Emby / Jellyfin / Kodi 三家的共同约定):
 *
 * ```
 * <库根>/剧名 (1985)/
 *          tvshow.nfo
 *          poster.jpg  fanart.jpg
 *          Season 01/
 *            剧名 - S01E01.mkv
 *            剧名 - S01E01.nfo
 * <库根>/片名 (1994)/
 *          片名 (1994).mkv
 *          片名 (1994).nfo
 *          片名 (1994)-poster.jpg  fanart.jpg
 * ```
 *
 * 与 av 域的两点不同:
 *  1. **路径不走模板** —— 剧与电影的形状不一样(剧多两层), 而模板是库级的单一字符串。
 *  2. 文件名用 `SxxEyy` —— 媒体服务器靠它认集号, 靠文件名里的季号分季。
 *     中文 `第3集` 也能认, 但七季的剧会全落第 1 季(没有季信息)。
 *
 * 安全阀与 av 域一致: 默认 dry-run; 目标被占用绝不覆盖; 认不出集号的文件不搬。
 */
export interface VideoOrganizeReport {
  plan: Plan;
  applied: ApplyResult[] | null;
  skipped?: boolean;
  reason?: string;
  /** 人话提醒: 认不出集号的、抢同一目标的、源目录会留下的东西。 */
  warnings: string[];
  /** 搬空之后删掉的源目录。 */
  removedDirs?: string[];
  /** 源目录里还有东西、所以没删的 (字幕/认不出集号的文件)。 */
  leftoverDirs?: { dir: string; files: string[] }[];
  /** 删掉的 Kura 自己生成的残留 (旧目录里的 poster.jpg / fanart.jpg / 集 nfo)。 */
  removedFiles?: string[];
  /**
   * 跳过的本地条目数 (`local:` / `ugc`)。
   *
   * 它们的标题是人写的、文件名没有季集信息、也没有来源能补: 按模板改名只会把
   * "我自己起的名" 换成 "我认不出的名"。要整理就先 `item title` 定好名自己搬。
   */
  skippedLocal?: number;
}

export interface VideoOrganizeOptions {
  library: Library;
  /** 默认 false —— 见 ADR 0002: 整理是唯一不可逆的动作。 */
  apply?: boolean;
  /** 停止信号(只对真搬运有意义: 已经搬完的保持原样)。 */
  signal?: AbortSignal;
  /** 进度: 一个计划条目一次。 */
  onProgress?: (progress: { index: number; total: number; action: "move" | "write-nfo" | "copy-image" | "skip"; path: string }) => void;
  /** 每个条目结束后的结果(成功/失败/本来就不用动)。 */
  onResult?: (result: { entry: PlanEntry; ok: boolean; error?: string; unchanged?: boolean }, progress: { index: number; total: number }) => void;
}

interface ItemFilesRow {
  number: string;
  title: string | null;
  title_original: string | null;
  domain: string;
  release_date: string | null;
  plot: string | null;
  studio: string | null;
  duration_min: number | null;
  tags: string | null;
  actors: string | null;
  path: string;
  season: number | null;
  episode: number | null;
  /** 扫描时从文件名解析出的相位(JSON), 里面有分碟号 `cd`。 */
  phase: string | null;
}

interface EpisodeInfo {
  title: string | null;
  plot: string | null;
  air_date: string | null;
  duration_min: number | null;
}



/** `剧名 (1985)`; 没有年份就不要空括号。 */
export function folderName(title: string, year: string | null): string {
  const clean = sanitizeName(title);
  const suffix = year && /^\d{4}$/.test(year) ? ` (${year})` : "";
  return `${clean}${suffix}`.trim();
}

/** `剧名 - S01E03` —— 媒体服务器靠这个认集号。 */
export function episodeBaseName(title: string, season: number, episode: number): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${sanitizeName(title)} - S${pad(season)}E${pad(episode)}`;
}

function seasonFolder(season: number): string {
  return `Season ${String(season).padStart(2, "0")}`;
}

function yearOf(releaseDate: string | null): string | null {
  const year = (releaseDate ?? "").slice(0, 4);
  return /^\d{4}$/.test(year) ? year : null;
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** 目标必须在库根内 —— 片名里带 `../` 或盘符时宁可不搬。 */
function insideRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

export async function organizeVideo(rt: Runtime, opts: VideoOrganizeOptions): Promise<VideoOrganizeReport> {
  const apply = opts.apply ?? false;
  const root = resolve(opts.library.root);
  const emptyPlan: Plan = {
    libraryId: opts.library.id,
    libraryRoot: root,
    entries: [],
    summary: { move: 0, writeNfo: 0, copyImage: 0, skip: 0 },
  };

  if (opts.library.organizeEnabled === false) {
    return { plan: emptyPlan, applied: null, skipped: true, reason: "该库已设为不整理 (只索引), 不会移动或改名文件", warnings: [] };
  }

  const rows = rt.db.all<ItemFilesRow>(
    `select i.number, i.title, i.title_original, i.domain, i.release_date, i.plot, i.studio,
            i.duration_min, i.tags, i.actors,
            m.path, m.season, m.episode, m.phase
     from media_files m join items i on i.number = m.number
     where m.library_id = ? and i.domain in ('tv', 'movie') and i.content_type <> 'ugc'
     order by i.number, m.season, m.episode, m.path`,
    [opts.library.id],
  );

  // 本地条目(手动加入的 UGC)一律不动: 没有来源、没有季集、标题也是人写的
  const skippedLocal =
    rt.db.get<{ n: number }>(
      `select count(distinct m.number) as n
       from media_files m join items i on i.number = m.number
       where m.library_id = ? and i.content_type = 'ugc'`,
      [opts.library.id],
    )?.n ?? 0;

  const byItem = new Map<string, ItemFilesRow[]>();
  for (const row of rows) {
    const list = byItem.get(row.number);
    if (list) list.push(row);
    else byItem.set(row.number, [row]);
  }

  const entries: PlanEntry[] = [];
  const summary = { move: 0, writeNfo: 0, copyImage: 0, skip: 0 };
  const warnings: string[] = [];
  const claimed = new Set<string>();
  const push = (entry: PlanEntry): void => {
    entries.push(entry);
    if (entry.action === "move") summary.move++;
    else if (entry.action === "write-nfo") summary.writeNfo++;
    else if (entry.action === "copy-image") summary.copyImage++;
    else summary.skip++;
  };

  for (const [key, files] of byItem) {
    const head = files[0]!;
    // 没刮削就没有名字, 搬过去只会得到一堆 "tmdb-tv-54" 目录
    if (!head.title) {
      warnings.push(`${key}: 还没刮削 (没有标题), 跳过 ${files.length} 个文件`);
      for (const file of files) push({ action: "skip", from: file.path, reason: "条目还没刮削 (没有标题)" });
      continue;
    }

    const year = yearOf(head.release_date);
    const folder = folderName(head.title, year);
    const dir = resolve(join(root, folder));
    if (!insideRoot(root, dir)) {
      warnings.push(`${key}: 目标目录在库根之外, 跳过`);
      for (const file of files) push({ action: "skip", from: file.path, reason: "目标目录在库根之外" });
      continue;
    }

    const tmdbId = /^tmdb:(tv|movie):(\d+)$/.exec(key)?.[2] ?? null;
    const genres = parseList(head.tags);
    const actors = parseList(head.actors);

    if (head.domain === "movie") {
      const base = folder;
      // 一部电影名下有多个文件时, 分两种情况, 以前一律按"多版本"处理:
      //  - **分碟** (`cd` 标记): 同一次发行切成的几块, 都该搬进同一目录, 名字带 ` - cdN`
      //  - **多版本** (没有 cd): 1080p / 720p 这类, 只整理第一个, 其余留在原地
      // 以前两者都按后者处理, 结果 `神奇绿巨人-cd2.rmvb` 想出目标却发现目标已被
      // 正片占着, 互相判"目标已存在", 永远整理不动。
      const cdOf = (row: ItemFilesRow): number | null => parsePhase(row.phase)?.cd ?? null;
      const discs = files.filter((row) => cdOf(row) !== null);
      const plain = files.filter((row) => cdOf(row) === null);
      // 正片: 优先没 cd 标记的第一个(完整版); 全是分碟时用 cd 最小的那个当"正片"位置?
      // 不 —— 全分碟就直接都带 -cdN, 不额外造一个正片名, 免得磁盘上出现两份同样的内容。
      const primary = plain[0] ?? null;
      if (primary) {
        const extension = extname(primary.path);
        const target = resolve(join(dir, `${base}${extension}`));
        const state = await targetState(primary.path, target);
        if (state === "free") push({ action: "move", from: primary.path, to: target });
        else push({ action: "skip", from: primary.path, to: target, reason: skipReason(state) });
      }
      for (const disc of discs) {
        const cd = cdOf(disc);
        const extension = extname(disc.path);
        const target = resolve(join(dir, `${base} - cd${cd}${extension}`));
        const state = await targetState(disc.path, target);
        if (state === "free") push({ action: "move", from: disc.path, to: target });
        else push({ action: "skip", from: disc.path, to: target, reason: skipReason(state) });
      }

      push({
        action: "write-nfo",
        to: resolve(join(dir, `${base}.nfo`)),
        content: renderMovieNfo({
          title: head.title,
          originalTitle: head.title_original,
          plot: head.plot,
          premiered: head.release_date,
          studio: head.studio,
          runtimeMin: head.duration_min,
          genres,
          actors,
          tmdbId,
        }),
      });

      addImages(rt, key, head.title, dir, `${base}-poster`, "fanart", push, warnings, primary?.path ?? files[0]!.path);
      // 正片之外、又没有分碟标记的: 多版本(1080p / 720p)。不猜哪个"更好", 留在原地。
      for (const file of plain.slice(1)) {
        push({ action: "skip", from: file.path, reason: "同一部电影有多个版本, 只整理第一个" });
      }
      continue;
    }

    // 剧: tvshow.nfo + 海报 + 每集进 Season 目录
    push({
      action: "write-nfo",
      to: resolve(join(dir, "tvshow.nfo")),
      content: renderTvShowNfo({
        title: head.title,
        originalTitle: head.title_original,
        plot: head.plot,
        premiered: head.release_date,
        studio: head.studio,
        genres,
        actors,
        tmdbId,
      }),
    });
    addImages(rt, key, head.title, dir, "poster", "fanart", push, warnings, files[0]!.path);

    const episodes = new Map<string, EpisodeInfo>();
    for (const row of rt.db.all<EpisodeInfo & { season: number; episode: number }>(
      "select season, episode, title, plot, air_date, duration_min from episodes where number = ?",
      [key],
    )) {
      episodes.set(`${row.season}-${row.episode}`, row);
    }

    for (const file of files) {
      if (file.season === null || file.episode === null) {
        warnings.push(`${file.path.split(sep).pop()}: 认不出集号, 没搬 (先补集号再整理)`);
        push({ action: "skip", from: file.path, reason: "认不出集号, 先补集号再整理" });
        continue;
      }
      const base = episodeBaseName(head.title, file.season, file.episode);
      const target = resolve(join(dir, seasonFolder(file.season), `${base}${extname(file.path)}`));
      if (claimed.has(target)) {
        warnings.push(`${base}: 两个文件抢同一个目标位置, 只搬第一个`);
        push({ action: "skip", from: file.path, to: target, reason: "另一个文件已经占了同一集的位置" });
        continue;
      }
      claimed.add(target);

      const state = await targetState(file.path, target);
      if (state === "free") push({ action: "move", from: file.path, to: target });
      else push({ action: "skip", from: file.path, to: target, reason: skipReason(state) });

      const info = episodes.get(`${file.season}-${file.episode}`);
      push({
        action: "write-nfo",
        to: resolve(join(dir, seasonFolder(file.season), `${base}.nfo`)),
        content: renderEpisodeNfo({
          title: info?.title ?? null,
          plot: info?.plot ?? null,
          aired: info?.air_date ?? null,
          runtimeMin: info?.duration_min ?? null,
          season: file.season,
          episode: file.episode,
          tmdbId,
        }),
      });
    }
  }

  const plan: Plan = { libraryId: opts.library.id, libraryRoot: root, entries, summary };
  const applied = apply
    ? await applyPlan(plan, { signal: opts.signal, onProgress: opts.onProgress, onResult: opts.onResult })
    : null;

  let prune: PruneResult | null = null;
  if (applied) {
    // 搬完立刻改索引: 否则下次扫描会把同一文件当成 "旧路径消失 + 新路径出现"。
    rt.db.exec("begin");
    try {
      for (const result of applied) {
        if (!result.ok || !result.entry.from || !result.entry.to) continue;
        if (result.entry.action === "move") {
          rt.db.run("update media_files set path = ? where path = ?", [result.entry.to, result.entry.from]);
          continue;
        }
        // 计划说"目标就是它", 而源文件已经不在了 —— 说明上一次整理搬了文件、索引没跟上。
        // 不纠正的话, 索引会一直指着空目录, nfo 同步往里写就是 ENOENT, 永远不收敛。
        if (result.entry.action === "skip" && !existsSync(result.entry.from) && existsSync(result.entry.to)) {
          rt.db.run("update media_files set path = ? where path = ?", [result.entry.to, result.entry.from]);
        }
      }
      rt.db.exec("commit");
    } catch (err) {
      rt.db.exec("rollback");
      throw err;
    }
  }

  if (applied) {
    // 目标目录可能就是源目录本身(没有年份时 `仁医` → `仁医`): 那是新结构, 不能当成"搬空的旧目录"
    const targets = plan.entries
      .filter((entry) => entry.action !== "skip" && entry.to)
      .map((entry) => entry.to!);
    const moved = applied
      .filter((result) => result.ok && result.entry.action === "move" && result.entry.from)
      .map((result) => ({ from: result.entry.from!, base: basename(result.entry.from!, extname(result.entry.from!)) }))
      .filter((item) => !targets.some((target) => target === dirname(item.from) || target.startsWith(`${dirname(item.from)}${sep}`)));
    const byDir = new Map<string, string[]>();
    for (const item of moved) {
      const dir = dirname(item.from);
      byDir.set(dir, [...(byDir.get(dir) ?? []), item.base]);
    }
    prune = await pruneEmptyDirs(
      [root],
      [...byDir].map(([dir, bases]) => ({ dir, bases })),
    );
    for (const item of prune.leftover.slice(0, 10)) {
      warnings.push(`${item.dir}: 还有 ${item.files.length} 个文件 (${item.files.join("、")}), 目录没删`);
    }
  }

  if (skippedLocal > 0) {
    warnings.push(`本地条目 ${skippedLocal} 个没有整理: 手动加入的条目 (local:) 没有来源也没有季集, 要搬请自己来`);
  }

  return {
    plan,
    applied,
    warnings,
    ...(prune ? { removedDirs: prune.removed, leftoverDirs: prune.leftover, removedFiles: prune.removedFiles } : {}),
    ...(skippedLocal > 0 ? { skippedLocal } : {}),
  };
}

function skipReason(state: "same" | "occupied" | "unknown"): string {
  if (state === "same") return "已在目标位置";
  if (state === "occupied") return "目标已存在同名文件, 不覆盖";
  return "无法判断目标状态";
}

/**
 * 海报/剧照进目录。只认**已经缓存**的图(`resources` 表), 整理不发网络请求 ——
 * 整理是本地动作, 不该因为网络抖一下就少一张图。
 */
function addImages(
  rt: Runtime,
  key: string,
  title: string,
  dir: string,
  posterBase: string,
  fanartBase: string,
  push: (entry: PlanEntry) => void,
  warnings: string[],
  sourcePath: string,
): void {
  const row = rt.db.get<{ poster_urls: string | null; cover_urls: string | null; thumb_urls: string | null }>(
    "select poster_urls, cover_urls, thumb_urls from items where number = ?",
    [key],
  );
  const first = (...urls: string[]): string | null => urls.find((url) => findResource(rt, url) !== null) ?? null;
  const posterUrl = first(...parseList(row?.poster_urls ?? null), ...parseList(row?.cover_urls ?? null));
  const thumbUrl = first(...parseList(row?.thumb_urls ?? null));
  const poster = findResource(rt, posterUrl ?? undefined);
  const thumb = findResource(rt, thumbUrl ?? undefined);
  // 盘上已有的图: 从 nfo 恢复的条目没有 poster_urls, 但上次整理(或别的工具)已经把图放在
  // 目录里了。只看缓存的话会警告"目录里不会有 xxx-poster.jpg" —— 而它就躺在那儿。
  const sidecar = findSidecarImages(sourcePath);

  if (poster) {
    push({ action: "copy-image", from: poster.path, to: resolve(join(dir, `${posterBase}${extname(poster.path) || ".jpg"}`)) });
  } else if (sidecar.poster) {
    // 源目录有图: 搬到目标的规范名(整理时顺手, 不用先「下载图片」)
    const target = resolve(join(dir, `${posterBase}${extname(sidecar.poster) || ".jpg"}`));
    if (resolve(sidecar.poster) !== target) push({ action: "copy-image", from: sidecar.poster, to: target });
  } else if (!onDisk(dir, posterBase)) {
    warnings.push(`${title}: 没有缓存的海报 (先「下载图片」), 目录里不会有 ${posterBase}.jpg`);
  }
  if (thumb) {
    push({ action: "copy-image", from: thumb.path, to: resolve(join(dir, `${fanartBase}${extname(thumb.path) || ".jpg"}`)) });
  } else if (sidecar.thumb) {
    const target = resolve(join(dir, `${fanartBase}${extname(sidecar.thumb) || ".jpg"}`));
    if (resolve(sidecar.thumb) !== target) push({ action: "copy-image", from: sidecar.thumb, to: target });
  }
}

/** 目标目录里已经有这张图了吗(任意常见扩展名)。 */
function onDisk(dir: string, base: string): boolean {
  return [".jpg", ".jpeg", ".png", ".webp"].some((extension) => existsSync(join(dir, `${base}${extension}`)));
}

export interface CleanupReport {
  dryRun: boolean;
  /** 清掉的目录(由深到浅)。 */
  removedDirs: string[];
  /** 清掉的文件: 全是 Kura 自己生成的海报 / nfo。 */
  removedFiles: string[];
  /** 里面有视频或用户文件、所以没动的目录。 */
  kept: { dir: string; files: string[] }[];
}

/**
 * 清掉库里的"空壳目录": 已经没有影片、只剩 Kura 自己生成的海报与 nfo。
 *
 * 为什么单独一条命令: 「整理」只清它这次**搬空**的目录。等影片早就搬完了、
 * 老目录里只剩 `poster.jpg` + `fanart.jpg` 时才想起来要清, 再跑整理也没用
 * —— 没有移动发生, 就没有清理的触发点。
 *
 * 判据(宁可不动): 目录里**没有任何影片**, 且**每个文件**都是 Kura 生成物
 * (固定图片名 / tvshow.nfo / 任意 .nfo)。字幕、别的东西一律让目录留下来。
 */
export async function cleanupEmptyDirs(
  rt: Runtime,
  options: { libraryId?: number; apply?: boolean },
): Promise<CleanupReport> {
  const apply = options.apply ?? false;
  const roots = rt.db.all<{ id: number; root: string }>(
    options.libraryId === undefined
      ? "select id, root from libraries"
      : "select id, root from libraries where id = ?",
    options.libraryId === undefined ? [] : [options.libraryId],
  );
  const report: CleanupReport = { dryRun: !apply, removedDirs: [], removedFiles: [], kept: [] };

  for (const library of roots) {
    const root = resolve(library.root);
    const dirs = await listDirs(root);
    // 由深到浅: 清完子目录, 父目录才有机会变空
    for (const dir of dirs.sort((a, b) => b.split(sep).length - a.split(sep).length)) {
      if (dir === root) continue;
      let names: string[];
      try {
        names = (await readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      if (names.some(isVideoFile)) continue; // 还有片子, 不动
      if ((await readdir(dir, { withFileTypes: true })).some((entry) => entry.isDirectory())) continue;

      // 这个目录里没有任何影片, 所以 .nfo 也算断了线的元数据
      const artifacts = names.filter((name) => isKuraArtifact(name, new Set(), { orphanNfo: true }));
      const remains = names.filter((name) => !artifacts.includes(name));

      if (!apply) {
        report.removedFiles.push(...artifacts.map((name) => join(dir, name)));
        if (remains.length === 0) report.removedDirs.push(dir);
        else report.kept.push({ dir, files: remains.slice(0, 5) });
        continue;
      }

      for (const name of artifacts) {
        try {
          await unlink(join(dir, name));
          report.removedFiles.push(join(dir, name));
        } catch {
          // 删不掉就不算清掉
          remains.push(name);
        }
      }
      if (remains.length > 0) {
        report.kept.push({ dir, files: remains.slice(0, 5) });
        continue;
      }
      try {
        await rmdir(dir);
        report.removedDirs.push(dir);
      } catch (err) {
        report.kept.push({ dir, files: [`rmdir 失败: ${(err as NodeJS.ErrnoException).code ?? "?"}`] });
      }
    }
  }
  return report;
}

/** 库根下所有目录(含多层), 跳过软链与隐藏目录。 */
async function listDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      const next = join(dir, entry.name);
      out.push(next);
      await walk(next);
    }
  };
  await walk(root);
  return out;
}
