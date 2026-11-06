import { sep } from "node:path";
import { AppError, EXIT } from "../exit";
import { basename } from "node:path";
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
  /**
   * 候选键:
   *  - 剧集 → 剧目录 (传 `某个剧` 就绑这整个剧)
   *  - 电影 → **文件路径本身** (一个文件就是一部片)
   */
  dir: string;
  /** 给界面直接显示: 剧目录名, 或电影文件名。 */
  name: string;
  /** 这次绑上会涉及多少个文件。 */
  files: number;
  /** 其中能解析出集号的文件数 (电影恒为 0)。 */
  parsed: number;
  seasons: number[];
  /**
   * 从文件名推断的类型。
   *
   * `unknown` = 一个目录里多个文件, 却一个集号都认不出 —— **不能**当成一部电影绑,
   * 否则整目录十几个文件会被写进同一个 TMDB id。它要么是命名没被认出来的剧
   * (补集号后重扫), 要么是一堆彼此无关的视频 (逐个按电影绑)。
   */
  kind: "tv" | "movie" | "unknown";
  /** 绑定时会动到的文件。 */
  paths: string[];
  /**
   * 这个文件来自"多文件、无集号"的目录, 且同目录的文件名共享同一前缀 ——
   * 大概率是同一部剧的散集, 只是命名没被认出来。**只是提示**: 仍然按单文件(电影)绑,
   * 不会把整目录写进同一个 TMDB id。
   */
  suspectSeries?: boolean;
}

/** 未识别页要的清单: 有哪些东西等着绑定。 */
export function listBindableDirs(
  rt: Runtime,
  options: { libraryId?: number; limit?: number; offset?: number; kind?: "tv" | "movie" } = {},
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

  interface Bucket {
    dir: string;
    name: string;
    paths: string[];
    parsed: number;
    seasonSet: Set<number>;
  }
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const located = locateEpisode(row.path, roots.get(row.library_id) ?? "");
    // 认不出集号的文件也归到"剧目录"(父目录是 Season 01 就再上一层)
    const dir = located?.showDir ?? showDirOf(row.path);
    const bucket =
      buckets.get(dir) ??
      ({
        dir,
        name: basename(dir) || dir || "（库根目录）",
        paths: [],
        parsed: 0,
        seasonSet: new Set<number>(),
      } as Bucket);
    bucket.paths.push(row.path);
    if (row.season !== null) {
      bucket.parsed++;
      bucket.seasonSet.add(row.season);
    }
    buckets.set(dir, bucket);
  }

  const out: BindableDir[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.parsed > 0) {
      // 剧: 整个目录一起绑
      out.push({
        dir: bucket.dir,
        name: bucket.name || "（库根目录）",
        files: bucket.paths.length,
        parsed: bucket.parsed,
        seasons: [...bucket.seasonSet].sort((a, b) => a - b),
        kind: "tv",
        paths: bucket.paths,
      });
      continue;
    }
    if (bucket.paths.length === 1) {
      // 单文件: 这就是一部电影 (目录名带不带年份都无所谓)
      const file = bucket.paths[0]!;
      out.push({
        dir: file,
        name: basename(file),
        files: 1,
        parsed: 0,
        seasons: [],
        kind: "movie",
        paths: [file],
      });
      continue;
    }
    // 多文件却一个集号都认不出: 可能是"一目录多部片", 也可能是"一部剧的散集没认出来"。
    // 分不清就**按文件给候选** —— 绑一个文件只影响一个文件, 绝不会把 165 个文件写进同一个 id。
    // 名字像同一部剧时打个标记, 界面上提示"补集号可能更好"。
    const suspect = sharedPrefix(bucket.paths) !== "";
    for (const file of bucket.paths) {
      out.push({
        dir: file,
        name: basename(file),
        files: 1,
        parsed: 0,
        seasons: [],
        kind: "movie",
        paths: [file],
        ...(suspect ? { suspectSeries: true } : {}),
      });
    }
  }

  // 剧在前: 一部剧一条候选, 电影可能上百条, 混在一起会把剧埋掉
  const kindRank = (kind: BindableDir["kind"]) => (kind === "tv" ? 0 : kind === "movie" ? 1 : 2);
  const filtered = options.kind
    ? out.filter((entry) => (options.kind === "tv" ? entry.kind === "tv" : entry.kind !== "tv"))
    : out;
  return filtered
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.dir.localeCompare(b.dir))
    .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 200));
}

export function countBindableDirs(
  rt: Runtime,
  options: { libraryId?: number; kind?: "tv" | "movie" } = {},
): number {
  return listBindableDirs(rt, { ...options, limit: Number.MAX_SAFE_INTEGER }).length;
}

/** 候选分类计数 —— 界面要说"35 部剧 / 920 部电影", 而不是一个笼统的总数。 */
export function countBindableKinds(
  rt: Runtime,
  options: { libraryId?: number } = {},
): { total: number; tv: number; movie: number } {
  const all = listBindableDirs(rt, { ...options, limit: Number.MAX_SAFE_INTEGER });
  return {
    total: all.length,
    tv: all.filter((dir) => dir.kind === "tv").length,
    movie: all.filter((dir) => dir.kind !== "tv").length,
  };
}

export interface BindingSuggestion {
  dir: string;
  name: string;
  files: number;
  parsed: number;
  kind: "tv" | "movie" | "unknown";
  /** 绑定时会动到的文件 (电影候选就一个)。 */
  paths: string[];
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
  options: {
    libraryId: number;
    /** 剧: 剧目录。电影: 那一集文件的路径 (候选的 `dir` 字段)。 */
    dir: string;
    key: string;
    /** 只想绑这些文件时显式给出 (电影候选 = 单个文件)。 */
    paths?: string[];
    /**
     * 强制指定季号 (覆盖从文件名/目录解析出来的季)。
     *
     * 用在同一部剧被拆成多个目录时: `仁医` 与 `仁医2` 都绑同一个 TMDB 身份, 但前者是
     * 第 1 季、后者是第 2 季 —— 文件名里没有季号时, 解析结果会全都落在第 1 季,
     * 于是两季的集号撞在一起。
     */
    season?: number;
    dryRun?: boolean;
  },
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
  // 显式 paths 优先: 电影候选就是一个文件, 用目录前缀会把同目录的其它片子一起绑进去
  const files = options.paths
    ? rt.db.all<{ path: string; season: number | null; episode: number | null }>(
        `select path, season, episode from media_files where library_id = ? and number is null and path in (${options.paths
          .map(() => "?")
          .join(", ")}) order by path`,
        [library.id, ...options.paths],
      )
    : rt.db.all<{ path: string; season: number | null; episode: number | null }>(
        `select path, season, episode from media_files
         where library_id = ? and number is null and (path = ? or path like ? || '%')
         order by path`,
        [library.id, dir, prefix],
      );

  if (files.length === 0) {
    throw new AppError(`没有待绑定的文件: ${dir}`, EXIT.NOT_FOUND, {
      dir,
      hint: "先跑 scan, 或者确认这些文件已经属于别的条目",
    });
  }

  const key = options.key.toLowerCase();
  if (options.season !== undefined && (!Number.isInteger(options.season) || options.season < 0)) {
    throw new AppError(`季号必须是非负整数: ${options.season}`, EXIT.USAGE, { season: options.season });
  }
  const stillUnparsed: string[] = [];
  const episodes: { season: number; episode: number; path: string }[] = [];
  for (const file of files) {
    // 电影本来就没有集号 —— 它不是"缺集号", 不该出现在待补清单里
    if (!file.episode) {
      if (target.kind === "tv") stillUnparsed.push(file.path);
      continue;
    }
    // 季号: 显式给的优先, 否则用解析出来的 (解析不出时 scan 已经写成 1)
    const season = options.season ?? file.season ?? 1;
    episodes.push({ season, episode: file.episode, path: file.path });
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

    for (const file of files) {
      // 季号可能要改 (同一部剧拆成多个目录的常见情形), 所以和 number 一起写
      rt.db.run("update media_files set number = ?, season = coalesce(?, season) where path = ?", [
        key,
        options.season ?? null,
        file.path,
      ]);
    }

    // 这里**不写** episodes: 那张表是"来源声明的集", 不是"盘上有哪些集"。
    // 混着写会让声明集数虚高(成长的烦恼: 真声明 166, 加上 165 个文件行变成 310)。

    rt.db.run("update items set updated_at = unixepoch() where number = ?", [key]);
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  const total = rt.db.get<{ n: number }>("select count(*) as n from episodes where number = ?", [key])?.n ?? 0;
  return { key, dir, bound: files.length, episodes: total, stillUnparsed };
}

export interface RebindResult {
  /** 旧身份 → 新身份。 */
  from: string;
  to: string;
  /** 这次跟着改绑的文件数。 */
  moved: number;
  /** 旧条目是否被删掉(没有别的文件指向它)。 */
  oldRemoved: boolean;
  /** 重新绑定的结果(集数等)。 */
  bound: BindResult | null;
}

/**
 * 改绑: 把一个已绑定的条目换到另一个 TMDB 身份。
 *
 * 为什么需要: 绑定这一步是**人挑的**, 挑错是常态(同名剧、重拍版、季数对不上)。
 * 之前只能"删库重来"或去 CLI 手敲 unbind, 等于把错绑变成了不可逆操作。
 *
 * 语义: 旧条目的文件全部转到新身份, 旧条目的集行与占位行一起清掉(没有别的文件指向时)。
 */
export function rebindItem(rt: Runtime, options: { key: string; newKey: string; libraryId?: number }): RebindResult {
  const from = options.key.toLowerCase();
  const to = options.newKey.toLowerCase();
  if (from === to) throw new AppError("新旧身份相同, 不需要改绑", EXIT.USAGE, { key: from });

  const target = parseTmdbKey(to);
  if (!target) throw new AppError(`不是 TMDB 身份: ${options.newKey}`, EXIT.USAGE, { key: options.newKey });

  const files = rt.db.all<{ path: string; library_id: number }>(
    "select path, library_id from media_files where number = ? order by path",
    [from],
  );
  if (files.length === 0) {
    throw new AppError(`条目 ${from} 没有登记到任何文件, 无从改绑`, EXIT.NOT_FOUND, { key: from });
  }
  const libraryId = options.libraryId ?? files[0]!.library_id;
  for (const file of files) {
    if (file.library_id !== libraryId) {
      throw new AppError("这个条目的文件分散在多个库里, 改绑请分开处理", EXIT.USAGE, { key: from });
    }
  }

  rt.db.exec("begin");
  try {
    rt.db.run("update media_files set number = null where number = ?", [from]);
    rt.db.run("delete from episodes where number = ?", [from]);
    rt.db.run("delete from items where number = ?", [from]);
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  const bound = bindDirectory(rt, {
    libraryId,
    dir: files[0]!.path,
    key: to,
    paths: files.map((file) => file.path),
  });

  return { from, to, moved: files.length, oldRemoved: true, bound };
}

export interface ItemDir {
  dir: string;
  files: number;
  episodeFrom: number | null;
  episodeTo: number | null;
  season: number | null;
}

/** 一个已绑定条目由哪些文件夹提供 (同一部剧被拆成多个目录时用得上)。 */
export function listItemDirs(rt: Runtime, key: string): ItemDir[] {
  const rows = rt.db.all<{ path: string; season: number | null; episode: number | null }>(
    "select path, season, episode from media_files where number = ? order by path",
    [key.toLowerCase()],
  );
  const buckets = new Map<string, ItemDir>();
  for (const row of rows) {
    const dir = showDirOf(row.path);
    const entry = buckets.get(dir) ?? { dir, files: 0, episodeFrom: null, episodeTo: null, season: row.season ?? null };
    entry.files++;
    if (row.episode !== null) {
      entry.episodeFrom = entry.episodeFrom === null ? row.episode : Math.min(entry.episodeFrom, row.episode);
      entry.episodeTo = entry.episodeTo === null ? row.episode : Math.max(entry.episodeTo, row.episode);
    }
    buckets.set(dir, entry);
  }
  return [...buckets.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * 把某个目录下的文件整批改成第 N 季。
 *
 * 用在同一部剧被拆成多个目录、而文件名里没有季号的情况: `仁医` 与 `仁医2` 都绑同一个
 * TMDB 身份, 但后者是第二季。不改的话两季的集号会撞在第 1 季上(每集两个文件)。
 */
export function setDirectorySeason(
  rt: Runtime,
  options: { dir: string; season: number; key?: string; libraryId?: number },
): { files: number; season: number } {
  if (!Number.isInteger(options.season) || options.season < 0) {
    throw new AppError(`季号必须是非负整数: ${options.season}`, EXIT.USAGE, { season: options.season });
  }
  const dir = options.dir.replace(/[\\/]+$/, "");
  const prefix = `${dir}${sep}`;
  const where = ["(path = ? or path like ? || '%')", "number is not null"];
  const params: (string | number)[] = [dir, prefix];
  if (options.key) {
    where.push("number = ?");
    params.push(options.key.toLowerCase());
  }
  if (options.libraryId !== undefined) {
    where.push("library_id = ?");
    params.push(options.libraryId);
  }

  const files = rt.db.all<{ path: string; number: string; episode: number | null }>(
    `select path, number, episode from media_files where ${where.join(" and ")} order by path`,
    params,
  );
  if (files.length === 0) {
    throw new AppError(`这个目录下没有已绑定的文件: ${dir}`, EXIT.NOT_FOUND, { dir });
  }

  rt.db.exec("begin");
  try {
    rt.db.run(
      `update media_files set season = ? where ${where.join(" and ")}`,
      [options.season, ...params],
    );
    // 同样不写 episodes —— 那是声明集。改季只动文件。
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }
  return { files: files.length, season: options.season };
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

/**
 * 同目录多个文件的"公共前缀"(去掉扩展名后)。用来猜它们是不是同一部剧的散集。
 *
 * 要求至少 2 个字符: 一个字符的前缀几乎总能撞上, 提示就成了噪声。
 */
function sharedPrefix(paths: string[]): string {
  if (paths.length < 2) return "";
  const stems = paths.map((path) => basename(path).replace(/\.[^.]+$/, ""));
  let prefix = stems[0] ?? "";
  for (const stem of stems.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < stem.length && prefix[index] === stem[index]) index++;
    prefix = prefix.slice(0, index);
    if (prefix.length < 2) return "";
  }
  return prefix.trim();
}

function parentOf(path: string): string {
  const index = path.lastIndexOf(sep);
  return index > 0 ? path.slice(0, index) : path;
}
