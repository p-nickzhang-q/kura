import { sep } from "node:path";
import { AppError, EXIT } from "../exit";
import { locateEpisode, showDirOf } from "../domain/episodes";
import { parseTmdbKey } from "../sources/tmdb";
import type { Runtime } from "../runtime";

/**
 * 影视域的"绑定": 把磁盘上的目录与 TMDB 身份对起来。
 *
 * 为什么需要这一步: 影视的身份是 TMDB id, 而 id 只能靠人或搜索确定。扫描只准备候选
 * (目录 + 季集), 绑定负责把候选变成条目 —— 猜错的代价是整季集名全错, 所以这一步
 * **永远是显式的**, 不做自动匹配 (ADR 0008 决策 4)。
 *
 * 粒度为**目录**: 一个目录 = 一部剧。100 集的剧逐个文件绑定等于 100 次操作, 没人会做。
 */

export interface BindableDir {
  /** 剧目录 (有季目录时是它的上一层)。 */
  dir: string;
  /** 目录名, 给界面直接显示。 */
  name: string;
  files: number;
  /** 其中能解析出集号的文件数; files > parsed 说明还有文件需要手工补集号。 */
  parsed: number;
  seasons: number[];
  /**
   * 从文件名推断的类型: 有集号 → 剧集, 没有 → 电影。
   * 绑定面板据此决定去 TMDB 搜剧还是搜片 (人仍然可以改)。
   */
  kind: "tv" | "movie";
}

/** 未识别页要的清单: 有哪些目录等着绑定, 各自多少文件。 */
export function listBindableDirs(
  rt: Runtime,
  options: { libraryId?: number; limit?: number; offset?: number } = {},
): BindableDir[] {
  const where: string[] = ["number is null"];
  const params: (number | string)[] = [];
  if (options.libraryId !== undefined) {
    where.push("library_id = ?");
    params.push(options.libraryId);
  }

  const rows = rt.db.all<{ path: string; season: number | null; library_id: number }>(
    `select path, season, library_id from media_files where ${where.join(" and ")} order by path`,
    params,
  );

  // 库根只查一次: 逐行查会变成 N 次 SQL(未识别清单可能上千行)
  const roots = new Map<number, string>();
  for (const row of rt.db.all<{ id: number; root: string }>("select id, root from libraries")) {
    roots.set(row.id, row.root);
  }

  const byDir = new Map<string, BindableDir & { seasonSet: Set<number> }>();
  for (const row of rows) {
    const located = locateEpisode(row.path, roots.get(row.library_id) ?? "");
    // 认不出集号的文件也归到"剧目录"(父目录是 Season 01 就再上一层): 它要跟同剧的
    // 其它文件一起出现在清单里, 人绑完目录再给这几个补集号。
    const dir = located?.showDir ?? showDirOf(row.path);
    const entry =
      byDir.get(dir) ??
      ({
        dir,
        name: dir.split(sep).filter(Boolean).pop() ?? dir,
        files: 0,
        parsed: 0,
        seasons: [],
        seasonSet: new Set<number>(),
        kind: "movie" as "tv" | "movie",
      } as BindableDir & { seasonSet: Set<number> });
    entry.files++;
    if (row.season !== null) {
      entry.parsed++;
      entry.seasonSet.add(row.season);
      entry.kind = "tv";
    }
    byDir.set(dir, entry);
  }

  return [...byDir.values()]
    .map(({ seasonSet, ...entry }) => ({ ...entry, seasons: [...seasonSet].sort((a, b) => a - b) }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
    .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 200));
}

export function countBindableDirs(rt: Runtime, options: { libraryId?: number } = {}): number {
  return listBindableDirs(rt, { ...options, limit: Number.MAX_SAFE_INTEGER }).length;
}

export interface BindingSuggestion {
  dir: string;
  name: string;
  files: number;
  parsed: number;
  kind: "tv" | "movie";
  /** 实际发出去的搜索词 (剥掉了年份/发布标记)。 */
  query: string;
  year: string | null;
  /** 最匹配的那条; null = 没搜到, 或把握太低不值得建议。 */
  hit: { key: string; title: string; year: string | null; id: number } | null;
  confidence: "high" | "medium" | "low" | "none";
  /** 搜索出错了(网络/限速): 与"没搜到"分开报。 */
  error?: string;
}

export interface BindResult {
  key: string;
  dir: string;
  /** 这次绑上的文件数。 */
  bound: number;
  /** 建出来的集数 (含之前已有的)。 */
  episodes: number;
  /** 认不出集号、绑了目录也进不了集的文件 —— 留给 `file set-episode`。 */
  stillUnparsed: string[];
}

/**
 * 把一个目录绑到 TMDB 身份上。
 *
 * 只动 `number is null` 的文件: 已经绑过的（或已经属于别的剧的）不碰 —— 静默改绑
 * 会让"我以为只绑了这一部"变成灾难。要改绑先 `file unbind`。
 */
export function bindDirectory(
  rt: Runtime,
  options: { libraryId: number; dir: string; key: string; dryRun?: boolean },
): BindResult {
  const target = parseTmdbKey(options.key);
  if (!target) {
    throw new AppError(`不是 TMDB 身份: ${options.key}`, EXIT.USAGE, {
      hint: "形如 tmdb:tv:1399 或 tmdb:movie:603",
    });
  }

  const library = rt.db.get<{ id: number; domain: string; root: string }>(
    "select id, domain, root from libraries where id = ?",
    [options.libraryId],
  );
  if (!library) throw new AppError(`库不存在: ${options.libraryId}`, EXIT.NOT_FOUND, { libraryId: options.libraryId });

  // 影视库里电影和剧集混装, 条目的类型由身份键决定, 不需要和库对齐。
  // 但番号制库不该绑 TMDB 身份 —— 那是两套完全不同的识别与来源。
  if (library.domain === "av") {
    throw new AppError("番号制库不能绑定 TMDB 身份", EXIT.USAGE, {
      libraryId: library.id,
      domain: library.domain,
      key: options.key,
      hint: "影视文件请建一个 video 域的库 (kura library add <名称> <目录> --domain video)",
    });
  }

  const dir = options.dir.replace(/[\\/]+$/, "");
  const prefix = `${dir}${sep}`;
  const files = rt.db.all<{ path: string; season: number | null; episode: number | null }>(
    `select path, season, episode from media_files
     where library_id = ? and number is null and (path = ? or path like ? || '%')
     order by path`,
    [library.id, dir, prefix],
  );

  if (files.length === 0) {
    throw new AppError(`这个目录下没有待绑定的文件: ${dir}`, EXIT.NOT_FOUND, {
      dir,
      hint: "先跑 scan, 或者确认这些文件已经属于别的条目",
    });
  }

  const key = options.key.toLowerCase();
  const stillUnparsed: string[] = [];
  const episodes: { season: number; episode: number }[] = [];
  for (const file of files) {
    // 电影本来就没有集号 —— 它不是"缺集号", 不该出现在待补清单里
    if (!file.season || !file.episode) {
      if (target.kind === "tv") stillUnparsed.push(file.path);
      continue;
    }
    episodes.push({ season: file.season, episode: file.episode });
  }

  if (options.dryRun) {
    return { key, dir, bound: files.length, episodes: episodes.length, stillUnparsed };
  }

  rt.db.exec("begin");
  try {
    // 条目占位行: 元数据由刮削填。content_type 对影视条目存空串 ——
    // 它是 av 域的概念, 而列是 NOT NULL(改它要重建表, 不值得)。
    // 条目类型(电影/剧集)来自身份键, 不是库的域。
    rt.db.run("insert or ignore into items (number, content_type, domain) values (?, '', ?)", [key, target.kind]);

    const update = rt.db.run.bind(rt.db);
    for (const file of files) {
      update("update media_files set number = ? where path = ?", [key, file.path]);
    }

    for (const entry of episodes) {
      rt.db.run("insert or ignore into episodes (number, season, episode) values (?, ?, ?)", [
        key,
        entry.season,
        entry.episode,
      ]);
    }

    rt.db.run("update items set updated_at = unixepoch() where number = ?", [key]);
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  const total = rt.db.get<{ n: number }>("select count(*) as n from episodes where number = ?", [key])?.n ?? 0;
  return { key, dir, bound: files.length, episodes: total, stillUnparsed };
}

/** 解绑: 把这个目录下的文件退回未识别。集行跟着条目走, 条目没人指向时一并删掉。 */
export function unbindDirectory(rt: Runtime, options: { libraryId: number; dir: string; key?: string }): number {
  const dir = options.dir.replace(/[\\/]+$/, "");
  const prefix = `${dir}${sep}`;
  const rows = rt.db.all<{ path: string; number: string | null }>(
    `select path, number from media_files where library_id = ? and (path = ? or path like ? || '%')`,
    [options.libraryId, dir, prefix],
  );
  const keys = new Set(rows.map((row) => row.number).filter((value): value is string => Boolean(value)));
  if (options.key) {
    const wanted = options.key.toLowerCase();
    for (const key of [...keys]) if (key !== wanted) keys.delete(key);
  }
  if (keys.size === 0) return 0;

  rt.db.exec("begin");
  try {
    rt.db.run(
      `update media_files set number = null where library_id = ? and (path = ? or path like ? || '%')`,
      [options.libraryId, dir, prefix],
    );
    // 条目没有文件指向了就删: 留着会让列表里出现"0 个文件的剧"
    for (const key of keys) {
      const left = rt.db.get<{ n: number }>("select count(*) as n from media_files where number = ?", [key])?.n ?? 0;
      if (left === 0) rt.db.run("delete from items where number = ?", [key]);
    }
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }
  return rows.length;
}

/**
 * 手工给单个文件指定集号 —— 绑定目录之后, 那些文件名里没有集号的文件走这条路。
 *
 * `episode` 必须给, `season` 不给就当第 1 季(与解析规则一致)。
 */
export function setFileEpisode(
  rt: Runtime,
  options: { path: string; season?: number; episode: number },
): { path: string; number: string | null; season: number; episode: number } {
  const row = rt.db.get<{ path: string; number: string | null; season: number | null; episode: number | null }>(
    "select path, number, season, episode from media_files where path = ?",
    [options.path],
  );
  if (!row) throw new AppError(`文件不在索引里: ${options.path}`, EXIT.NOT_FOUND, { path: options.path });

  const season = options.season ?? row.season ?? 1;
  const episode = options.episode;
  if (!Number.isInteger(episode) || episode <= 0) {
    throw new AppError(`集号必须是正整数: ${episode}`, EXIT.USAGE, { episode });
  }
  if (!Number.isInteger(season) || season < 0) {
    throw new AppError(`季号必须是非负整数: ${season}`, EXIT.USAGE, { season });
  }

  rt.db.exec("begin");
  try {
    rt.db.run("update media_files set season = ?, episode = ? where path = ?", [season, episode, row.path]);
    if (row.number) {
      rt.db.run("insert or ignore into episodes (number, season, episode) values (?, ?, ?)", [
        row.number,
        season,
        episode,
      ]);
    }
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }
  return { path: row.path, number: row.number, season, episode };
}

function parentOf(path: string): string {
  const index = path.lastIndexOf(sep);
  return index > 0 ? path.slice(0, index) : path;
}
