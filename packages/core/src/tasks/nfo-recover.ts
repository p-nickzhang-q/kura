import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { Runtime } from "../runtime";
import type { Metadata } from "../domain/types";
import { AppError, EXIT } from "../exit";
import { metadataColumns, rowToMetadata, type ItemRow } from "../db/rows";
import { setItemActors } from "../db/actors";
import { nfoPathFor } from "../domain/nfo";
import { parseTvNfo, type ParsedTvNfo } from "../domain/nfo-tv-read";
import { parseTmdbKey } from "../sources/tmdb";

/**
 * 从盘上的 nfo 把影视库恢复回来。
 *
 * 场景: 一块刮削好的移动硬盘接到另一台电脑 —— 库里是空的, 但每个剧目录都有
 * `tvshow.nfo`、每部电影旁边都有 `<片名>.nfo`, 里面带着 `<uniqueid type="tmdb">`。
 * 身份就在文件里, 不用联网重新找。
 *
 * 与 av 域的 `nfo sync` 同一套哲学: **nfo 是种子, 只填空字段**。拉到一半的库、
 * 或者已经刮过的库, 重跑它都不会覆盖网络来源。
 *
 * 只认未绑定的文件(`media_files.number is null`): 已绑定的条目说明库里已经知道身份,
 * 那是 `nfo sync` / 刮削的事, 不归这里管。
 */
export interface NfoRecoverEntry {
  kind: "tv" | "movie";
  key: string;
  /** 剧 = 剧目录; 电影 = 那个文件的路径。 */
  target: string;
  files: number;
  title: string | null;
  /** false = 库里这条已经有条目了, 这次只补空字段。 */
  created: boolean;
  /** 集级 nfo 里读回来多少集名/简介。 */
  episodes: number;
}

export interface NfoRecoverReport {
  libraryId: number;
  dryRun: boolean;
  shows: number;
  movies: number;
  /** 会(或已经)绑定上的文件总数。 */
  files: number;
  done: NfoRecoverEntry[];
  /** 有 nfo 但读不出 TMDB id 的目录 —— 只能靠"找建议"猜片名, 这里明确列出来。 */
  noTmdbId: string[];
}

export async function recoverFromNfo(
  rt: Runtime,
  options: { libraryId: number; apply?: boolean; signal?: AbortSignal },
): Promise<NfoRecoverReport> {
  const library = rt.db.get<{ id: number; domain: string; root: string }>(
    "select id, domain, root from libraries where id = ?",
    [options.libraryId],
  );
  if (!library) throw new AppError(`库不存在: ${options.libraryId}`, EXIT.NOT_FOUND, { libraryId: options.libraryId });
  if (library.domain !== "video") {
    throw new AppError("只有影视库能从 nfo 恢复 (番号制库用 nfo sync)", EXIT.USAGE, {
      libraryId: library.id,
      domain: library.domain,
      hint: "番号制库: kura nfo sync <库>",
    });
  }

  const apply = options.apply === true;

  const files = rt.db.all<{ path: string }>(
    "select path from media_files where library_id = ? and number is null order by path",
    [library.id],
  );

  // 一个目录只读一次 tvshow.nfo: 剧目录下可能有几百集, 每集都去 stat 一次是白费的。
  const dirCache = new Map<string, ParsedTvNfo | null>();
  const readCached = async (path: string): Promise<ParsedTvNfo | null> => {
    if (dirCache.has(path)) return dirCache.get(path) ?? null;
    const parsed = await readNfoFile(path);
    dirCache.set(path, parsed);
    return parsed;
  };

  // 第一步: 分组。剧 = 所在目录, 电影 = 那个文件本身。
  const tvDirs = new Map<string, { nfo: ParsedTvNfo; paths: string[] }>();
  const movieFiles: Array<{ path: string; nfo: ParsedTvNfo }> = [];
  const noTmdbId = new Set<string>();

  // 只在剧目录的最外层读 tvshow.nfo: 子目录(Season 01 之类)通常没有, 有也属于同一个剧。
  const tvshowByDir = new Map<string, ParsedTvNfo | null>();
  for (const file of files) {
    if (options.signal?.aborted) break;
    const dir = parentOf(file.path);
    if (!tvshowByDir.has(dir)) {
      const tvshowPath = join(dir, "tvshow.nfo");
      tvshowByDir.set(dir, existsSync(tvshowPath) ? await readCached(tvshowPath) : null);
    }
    const dirNfo = tvshowByDir.get(dir) ?? null;

    if (dirNfo?.root === "tvshow") {
      if (!dirNfo.tmdbId) {
        noTmdbId.add(dir);
        continue;
      }
      const group = tvDirs.get(dir) ?? { nfo: dirNfo, paths: [] };
      group.paths.push(file.path);
      tvDirs.set(dir, group);
      continue;
    }

    // 没有剧级 nfo: 看看这个文件旁边有没有自己的 movie nfo。
    const own = await readCached(nfoPathFor(file.path));
    if (own?.root === "movie") {
      if (!own.tmdbId) {
        noTmdbId.add(nfoPathFor(file.path));
        continue;
      }
      movieFiles.push({ path: file.path, nfo: own });
    }
  }

  const report: NfoRecoverReport = {
    libraryId: library.id,
    dryRun: !apply,
    shows: tvDirs.size,
    movies: movieFiles.length,
    files: [...tvDirs.values()].reduce((sum, group) => sum + group.paths.length, 0) + movieFiles.length,
    done: [],
    noTmdbId: [...noTmdbId].sort(),
  };

  if (!apply) return report;

  // 第二步: 建条目 + 绑定 + 补元数据。整批一个事务 —— 中途失败不留半截库。
  rt.db.exec("begin");
  try {
    for (const [dir, group] of tvDirs) {
      const entry = await bindOne(rt, {
        kind: "tv",
        key: `tmdb:tv:${group.nfo.tmdbId}`,
        target: dir,
        paths: group.paths,
        nfo: group.nfo,
      });
      report.done.push(entry);
    }
    for (const movie of movieFiles) {
      const entry = await bindOne(rt, {
        kind: "movie",
        key: `tmdb:movie:${movie.nfo.tmdbId}`,
        target: movie.path,
        paths: [movie.path],
        nfo: movie.nfo,
      });
      report.done.push(entry);
    }
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  return report;
}

/**
 * 一个剧目录 / 一部电影: 建占位条目 → 绑文件 → 补字段(只填空) → 收集级 nfo。
 *
 * 不用 `bindDirectory`: 那个函数负责"从文件名推季集 + 写 media_files", 这里还要
 * 一并处理元数据和 episodes, 走两条路会把季集逻辑复制一遍。
 */
async function bindOne(
  rt: Runtime,
  input: { kind: "tv" | "movie"; key: string; target: string; paths: string[]; nfo: ParsedTvNfo },
): Promise<NfoRecoverEntry> {
  const existingBefore = rt.db.get<{ number: string }>("select number from items where number = ?", [input.key]);
  // content_type 对影视条目存空串(它是 av 域的概念, 列却是 NOT NULL); 类型来自身份键。
  rt.db.run("insert or ignore into items (number, content_type, domain) values (?, '', ?)", [input.key, input.kind]);

  // 季集: 优先用集级 nfo 自己声明的 (season, episode), 没有就保留扫描时解析出来的。
  let episodeCount = 0;
  for (const path of input.paths) {
    const own = await readNfoFile(nfoPathFor(path));
    const fromNfo = own?.root === "episodedetails" ? own : null;
    const current = rt.db.get<{ season: number | null; episode: number | null }>(
      "select season, episode from media_files where path = ?",
      [path],
    );
    const season = fromNfo?.season ?? current?.season ?? (input.kind === "tv" ? 1 : null);
    const episode = fromNfo?.episode ?? current?.episode ?? null;
    rt.db.run("update media_files set number = ?, season = ?, episode = ? where path = ?", [
      input.key,
      season,
      episode,
      path,
    ]);

    // episodes 表只装"来源声明的集" —— nfo 就是一种来源, 它写了什么就记什么。
    if (fromNfo && season !== null && episode !== null) {
      rt.db.run(
        `insert into episodes (number, season, episode, title, plot, air_date, duration_min, field_sources)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(number, season, episode) do update set
           title = coalesce(episodes.title, excluded.title),
           plot = coalesce(episodes.plot, excluded.plot),
           air_date = coalesce(episodes.air_date, excluded.air_date),
           duration_min = coalesce(episodes.duration_min, excluded.duration_min)`,
        [
          input.key,
          season,
          episode,
          fromNfo.title ?? null,
          fromNfo.plot ?? null,
          fromNfo.premiered ?? null,
          fromNfo.runtimeMin ?? null,
          JSON.stringify({ title: "nfo", plot: "nfo", air_date: "nfo" }),
        ],
      );
      episodeCount++;
    }
  }

  fillGaps(rt, input.key, input.nfo);

  return {
    kind: input.kind,
    key: input.key,
    target: input.target,
    files: input.paths.length,
    title: input.nfo.title ?? input.nfo.originalTitle ?? null,
    created: !existingBefore,
    episodes: episodeCount,
  };
}

/**
 * 只填空字段。
 *
 * 不能整行覆盖: 盘上的 nfo 可能是半年前的, 而库里刚刮过 —— 用 nfo 盖掉网络来源等于
 * 把新数据换成旧数据。av 域的 `syncNfo` 用的是同一条规则。
 */
function fillGaps(rt: Runtime, key: string, nfo: ParsedTvNfo): void {
  const row = rt.db.get<ItemRow>("select * from items where number = ?", [key]);
  if (!row) return;
  const current = rowToMetadata(row);

  const genres = nfo.genres.length > 0 ? nfo.genres : undefined;
  const patch: Metadata = {
    ...current,
    key,
    number: key,
    contentType: current.contentType,
    title: current.title ?? nfo.title ?? nfo.originalTitle,
    titleOriginal: current.titleOriginal ?? nfo.originalTitle,
    plot: current.plot ?? nfo.plot,
    release_date: current.release_date ?? nfo.premiered,
    duration_min: current.duration_min ?? nfo.runtimeMin,
    studio: current.studio ?? nfo.studio,
    tags: current.tags?.length ? current.tags : genres,
    actors: current.actors?.length ? current.actors : nfo.actors.length > 0 ? nfo.actors : undefined,
  };

  // 来源标记: 只给"这次真的填上了"的字段记 nfo, 免得界面把网络来源误记成 nfo。
  const sources = { ...current.fieldSources };
  for (const field of ["title", "plot", "release_date", "duration_min", "studio", "tags"] as const) {
    const before = current[field];
    const after = patch[field];
    const filled = Array.isArray(after) ? after.length > 0 : after !== undefined && after !== null && after !== "";
    const hadBefore = Array.isArray(before) ? before !== undefined && before.length > 0 : before !== undefined && before !== null && before !== "";
    if (filled && !hadBefore) sources[field] = "nfo";
  }
  patch.fieldSources = sources;

  const columns = metadataColumns(patch);
  // 演员单独走 setItemActors(硬性约束: items.actors 只有一个写入口, 否则索引漂移)。
  const actors = columns.actors;
  delete columns.actors;
  const assignments = Object.keys(columns)
    .filter((column) => column !== "number")
    .map((column) => `${column} = ?`);
  rt.db.run(`update items set ${assignments.join(", ")}, updated_at = unixepoch() where number = ?`, [
    ...Object.entries(columns)
      .filter(([column]) => column !== "number")
      .map(([, value]) => value),
    key,
  ]);
  if (typeof actors === "string") setItemActors(rt.db, key, JSON.parse(actors) as string[]);
}

async function readNfoFile(path: string): Promise<ParsedTvNfo | null> {
  if (!existsSync(path)) return null;
  try {
    return parseTvNfo(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function parentOf(path: string): string {
  const index = path.lastIndexOf(sep);
  return index > 0 ? path.slice(0, index) : path;
}

/** `tmdb:tv:1399` 这样的身份键。nfo 里没有 id 就返回 null。 */
export function tmdbKeyOf(nfo: ParsedTvNfo, kind: "tv" | "movie"): string | null {
  if (!nfo.tmdbId) return null;
  const parsed = parseTmdbKey(`tmdb:${kind}:${nfo.tmdbId}`);
  return parsed ? `tmdb:${parsed.kind}:${parsed.id}` : null;
}
