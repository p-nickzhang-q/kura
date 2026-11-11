import { readdir, stat } from "node:fs/promises";
import { assertLibraryMounted, bindVolume } from "../db/volume";
import { AppError, EXIT } from "../exit";
import { basename, extname, join } from "node:path";
import { detectContentType, extractNumber, isAuxiliaryMedia, parseFileInfo } from "../domain/identify";
import { existsSync } from "node:fs";
import { inferEpisodesFromNames, locateEpisode, showDirOf } from "../domain/episodes";
import { nfoPathFor } from "../domain/nfo";
import { hasNetworkSource } from "./nfo-sync";
import type { Library } from "../domain/materialize";
import { metadataColumns, parsePhase, stringify, type MediaFileRow } from "../db/rows";
import type { FileInfo } from "../domain/types";
import type { Runtime } from "../runtime";

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".wmv",
  ".mov",
  ".ts",
  ".m2ts",
  ".iso",
  ".rmvb",
  // `.rm` 是 RealMedia: 老片子(尤其 2000 年代资源站转的)常见。以前漏了它,
  // 于是 `[迅雷]禁闭岛.BD1024高清中英双字.rm` 这种文件扫都扫不到, 界面上完全不存在。
  ".rm",
  ".flv",
  ".webm",
  ".m4v",
]);

/** 这个文件名是不是影片。扫描与清理共用一张表 —— 两边判断不一致就会一边搬一边删。 */
export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(name).toLowerCase());
}

export type ScanEventType = "file.added" | "file.updated" | "file.unchanged" | "file.removed" | "file.unparsed";

export interface ScanEvent {
  type: ScanEventType;
  path: string;
  number?: string | null;
}

export interface ScanReport {
  libraryId: number;
  root: string;
  dryRun: boolean;
  counts: {
    added: number;
    updated: number;
    unchanged: number;
    removed: number;
    unparsed: number;
    /** 被跳过的辅助媒体 (Emby 主题视频 / 预告片 / 样片) 个数。 */
    auxiliary: number;
    /**
     * 视频旁边有 .nfo、但库里该条目还没有网络来源的个数。
     *
     * scan 自己不再读 nfo 入库 —— 那是 `nfo sync` 的活(双向, 且共用一份实现)。
     * 这里只报数, 免得"换电脑重扫"这条路上的人不知道下一步该做什么。
     */
    nfoPending: number;
    /**
     * 影视域的"候选剧目录"个数: 一个目录 = 一部剧的候选 (电影域则是候选文件数)。
     * 它们还没有条目身份 —— 绑定到 TMDB 之后才建 items 行。
     */
    shows: number;
    /**
     * 修正了内容类型的条数。
     *
     * 内容类型按理只在建条目时落定, 但它同时决定刮削路由 —— 解析器有 bug 时
     * (把 SNIS-191 判成国产) 修完必须让旧库自愈, 否则那些条目永远只路由到
     * 一个源。只动"还没刮到任何标题"的条目: 有元数据的类型已经参与过路由,
     * 改它等于换一条来源线, 应该由人来决定。
     */
    retyped: number;
  };
  durationMs: number;
}

export interface ScanOptions {
  library: Library;
  dryRun?: boolean;
  onEvent?: (event: ScanEvent) => void;
  /**
   * 跳过"一次要移除太多"的安全阀。
   *
   * 默认不跳过: 盘没挂上、库根目录指错、网络盘只挂了一半时, 直接把索引里
   * 没看到的文件全删掉, 后果是**按库筛选的条目列表突然空了** (条目还在库里,
   * 但它的文件没了), 下次扫描再登记文件又"恢复"。这种"自己好了"的现象最坑人。
   */
  force?: boolean;
}

interface Found {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * REFRESH: 只读磁盘。登记文件、解析番号、建条目占位行 —— **不抓网、不改名**。
 * 幂等: 同一目录重复扫描, 第二次应全部 unchanged。
 */
export async function scan(rt: Runtime, opts: ScanOptions): Promise<ScanReport> {
  // 域在建库时落定, 扫描按它分流: 番号制走番号识别, 影视走目录/集号解析。
  return opts.library.domain === "av" ? scanAv(rt, opts) : scanVideo(rt, opts);
}

/** 番号制域的扫描: 从文件名抽番号, 建条目占位行。 */
async function scanAv(rt: Runtime, opts: ScanOptions): Promise<ScanReport> {
  const started = Date.now();
  const { library } = opts;
  const dryRun = opts.dryRun ?? false;
  const emit = opts.onEvent ?? (() => {});

  // 盘插对了吗、根目录还在吗 —— 两道门都在这一个函数里, 两个域共用。
  assertLibraryMounted(library);
  const bound = bindVolume(rt.db, library);

  const counts = { added: 0, updated: 0, unchanged: 0, removed: 0, unparsed: 0, auxiliary: 0, nfoPending: 0, retyped: 0, shows: 0 };
  const found: Found[] = [];
  const auxiliary = { count: 0 };
  await walk(library.root, found, auxiliary);
  counts.auxiliary = auxiliary.count;

  const known = new Map<string, MediaFileRow>();
  for (const row of rt.db.all<MediaFileRow>(
    "select path, library_id, number, size, mtime_ms, sha256, phase from media_files where library_id = ?",
    [library.id],
  )) {
    known.set(row.path, row);
  }

  const seen = new Set<string>();
  // 同一个番号可能对应多个文件, nfo 只读一次。
  const nfoChecked = new Set<string>();
  /** 每次扫描内同一条目只判一次类型。 */
  const retyped = new Set<string>();

  rt.db.exec("begin");
  try {
    for (const file of found) {
      seen.add(file.path);
      const previous = known.get(file.path);

      // 解析本身是纯函数、不花 IO, 所以每次都重算, 不跟着 size/mtime 一起跳过。
      // 这样解析器升级后, 旧库里"以前认不出"的文件重扫一次就能自愈。
      //
      // 先看文件名, 认不出再拿**相对库根的路径**兜底: 目录名带番号、文件名是 video.mp4
      // 的库很常见, 但库根以外的东西不该参与识别 —— 盘符、用户名、临时目录名里的
      // `abc123` / `kura-scanvideo-wtyk17` 都会被认成番号(后者是真实踩过的)。
      const number = extractNumber(basename(file.path)) ?? extractNumber(relativeInLibrary(library.root, file.path));
      const phase = parseFileInfo(file.path);
      if (!number) counts.unparsed++;

      // 空条目的元数据可以从旁边的 nfo 捞回来 —— 换电脑时数据库是空的, 这一步能省掉全部刮削。
      // 只数, 不读: 读 nfo 是 `nfo sync` 的事。
      if (number && !nfoChecked.has(number)) {
        nfoChecked.add(number);
        if (existsSync(nfoPathFor(file.path)) && !hasNetworkSource(fieldSourcesOf(rt, number))) counts.nfoPending++;
      }

      // 类型自愈必须在 unchanged 短路之前: 文件没变, 但解析器修好了。
      if (number && !dryRun && !retyped.has(number)) {
        retyped.add(number);
        const detected = detectContentType(number, file.path) ?? "censored";
        if (retypeUntouched(rt, number, detected)) counts.retyped++;
      }

      // 解析结果也要跟着自愈: 解析器升级后(比如分碟标记以前认不出 `你是我的命运CD2.mkv`),
      // 光看 size/mtime 会把这一行当"没变"跳过, phase 永远是旧的 —— 结果是整理计划
      // 永远拿不到 cd 号。所以 phase 变了也算更新。
      const phaseJson = stringify(phase);
      const phaseChanged = (previous?.phase ?? null) !== phaseJson;
      const untouched = previous && previous.size === file.size && previous.mtime_ms === file.mtimeMs;
      if (untouched && previous.number === number && !phaseChanged) {
        counts.unchanged++;
        emit({ type: "file.unchanged", path: file.path, number });
        continue;
      }

      if (number && !dryRun) {
        // 条目是一等公民: 有番号就先建占位行, 刮削再填字段。
        rt.db.run("insert or ignore into items (number, content_type) values (?, ?)", [
          number,
          detectContentType(number, file.path) ?? "censored",
        ]);
      }

      // sha256 留给后续去重; v0.1 不算, 否则首次扫描大库要跑几十分钟。
      const sha256 = previous?.sha256 ?? null;
      const type: ScanEventType = previous ? "file.updated" : "file.added";
      counts[type === "file.added" ? "added" : "updated"]++;

      if (!dryRun) {
        rt.db.run(
          `insert into media_files (path, library_id, number, size, mtime_ms, sha256, phase, seen_at)
           values (?, ?, ?, ?, ?, ?, ?, unixepoch())
           on conflict(path) do update set library_id = excluded.library_id, number = excluded.number,
             size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256,
             phase = excluded.phase, seen_at = excluded.seen_at`,
          [file.path, library.id, number, file.size, file.mtimeMs, sha256, phaseJson],
        );
      }
      emit({ type, path: file.path, number });
    }

    pruneMissing(rt, { library, known, seen, dryRun, force: opts.force === true, counts, emit });

    if (dryRun) rt.db.exec("rollback");
    else rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  return { libraryId: library.id, root: library.root, dryRun, counts, durationMs: Date.now() - started };
}

/** 从索引里删掉这次没看到的文件 —— 两个域共用, 安全阀也只有一份。 */
function pruneMissing(
  rt: Runtime,
  args: {
    library: Library;
    known: Map<string, MediaFileRow>;
    seen: Set<string>;
    dryRun: boolean;
    force: boolean;
    counts: ScanReport["counts"];
    emit: (event: ScanEvent) => void;
  },
): void {
  const { library, known, seen, dryRun, counts, emit } = args;
  const toRemove = [...known.keys()].filter((path) => !seen.has(path));
  const pruneGuard = !args.force && known.size >= 20 && toRemove.length / known.size > 0.3;
  if (pruneGuard) {
    // 不在这里 rollback: 外层 catch 统一回滚, 这里再回滚一次会报
    // "cannot rollback - no transaction is active"
    const percent = Math.round((toRemove.length / known.size) * 100);
    throw new AppError(
      `这次扫描要移除 ${toRemove.length} 个已登记文件 (占 ${percent}%), 库根可能没挂载完整, 已中止`,
      EXIT.NEEDS_INPUT,
      {
        libraryId: library.id,
        root: library.root,
        known: known.size,
        wouldRemove: toRemove.length,
        sample: toRemove.slice(0, 3),
        hint: `确认目录完整后重试; 确实要删就加 --force`,
      },
    );
  }

  for (const path of known.keys()) {
    if (seen.has(path)) continue;
    counts.removed++;
    if (!dryRun) rt.db.run("delete from media_files where path = ?", [path]);
    emit({ type: "file.removed", path });
  }
}

/**
 * 影视域的扫描: 登记文件 + 解析出 (剧目录, 季, 集), **不建条目**。
 *
 * 为什么不在扫描时建条目: 影视的身份是 TMDB id, 而 id 要绑定之后才知道 ——
 * 扫描时凭名字猜一个 id 写进库里, 猜错等于整季集名全错 (见 ADR 0008 决策 4)。
 * 所以这里只把"候选"准备好, 绑定由 `file bind` 完成。
 */
async function scanVideo(rt: Runtime, opts: ScanOptions): Promise<ScanReport> {
  const started = Date.now();
  const { library } = opts;
  const dryRun = opts.dryRun ?? false;
  const emit = opts.onEvent ?? (() => {});

  assertLibraryMounted(library);
  bindVolume(rt.db, library);

  const counts = { added: 0, updated: 0, unchanged: 0, removed: 0, unparsed: 0, auxiliary: 0, nfoPending: 0, retyped: 0, shows: 0 };
  const found: Found[] = [];
  const auxiliary = { count: 0 };
  await walk(library.root, found, auxiliary);
  counts.auxiliary = auxiliary.count;

  const known = new Map<string, MediaFileRow>();
  for (const row of rt.db.all<MediaFileRow>(
    "select path, library_id, number, size, mtime_ms, sha256, phase, season, episode from media_files where library_id = ?",
    [library.id],
  )) {
    known.set(row.path, row);
  }

  const seen = new Set<string>();
  const shows = new Set<string>();

  // 目录级补集号: 逐个文件认不出、看着同目录一批就能认出来的写法 (`…高清01`、`某讲座001…`)。
  // 放在扫描里而不是绑定时, 是因为"盘上有哪些集"是 media_files 的属性 —— 未识别页的
  // 候选数、详情页的集列表、整理的 SxxEyy 目标名全都从它来。
  const inferred = inferEpisodesFromNames(
    found.map((file) => file.path),
    library.root,
  );

  // 第一遍: 判定"每个目录是剧目录还是电影目录"。
  //
  // 判据是**比例**, 不是"有一个算一个": 一堆互不相关的电影里只要有一个文件名碰巧带
  // `_1`、`BD1024` 这类数字, 整目录就会被当成一部剧, 未识别页于是出现一条假剧候选
  // (33 个 B站投稿的那个目录就是这么来的)。真正的剧目录绝大多数文件都有集号。
  const dirStats = new Map<string, { files: number; parsed: number; explicit: number }>();
  for (const file of found) {
    const episodeInfo = locateEpisode(file.path, library.root);
    const dir = episodeInfo?.showDir ?? showDirOf(file.path);
    const stat = dirStats.get(dir) ?? { files: 0, parsed: 0, explicit: 0 };
    stat.files += 1;
    if (episodeInfo || inferred.has(file.path)) stat.parsed += 1;
    // `SxxEyy` 是文件自己声明的身份: 一个文件这么写, 它所在的目录就是剧目录
    if (episodeInfo?.seasonExplicit) stat.explicit += 1;
    dirStats.set(dir, stat);
  }
  const dirKinds = new Map<string, "tv" | "movie">();
  for (const [dir, stat] of dirStats) {
    const isShow =
      stat.explicit > 0 || // 文件自己写了 SxxEyy
      (stat.parsed >= 2 && stat.parsed * 2 >= stat.files) || // 大部分文件都有集号
      stat.parsed === stat.files || // 全都有集号 (单文件也算)
      (stat.parsed >= 1 && stat.files <= 3); // 小目录: 一集正片 + 特典/花絮
    dirKinds.set(dir, isShow ? "tv" : "movie");
  }

  rt.db.exec("begin");
  try {
    for (const file of found) {
      seen.add(file.path);
      const previous = known.get(file.path);

      // 解析是纯函数、不花 IO, 所以每次重算 —— 解析器升级后, 旧库里"以前认不出"的文件重扫一次就自愈。
      //
      // 影视库同时装电影和剧: 类型**按目录推断**, 不看库(库只有 av/video 两种)。
      // 目录里有文件解析出了集号 → 这是剧目录, 同目录里没集号的文件算"认不出"(等人工补);
      // 目录里一个集号都没有 → 这是电影(或还没绑的剧), 文件本身就是候选。
      const episodeInfo0 = locateEpisode(file.path, library.root);
      // 单个文件认不出时, 用整个目录的命名规律补 (见 inferEpisodesFromNames)
      const inferredInfo0 = episodeInfo0 ? null : (inferred.get(file.path) ?? null);
      // 认不出集号的文件也要归到"剧目录"(父目录是 Season 01 就再上一层), 否则它会自成
      // 一个目录、被判成电影 —— 结果就是剧目录里永远数不出"认不出"的文件。
      const dir = episodeInfo0?.showDir ?? showDirOf(file.path);
      shows.add(dir);
      if (!episodeInfo0 && !inferredInfo0 && dirKinds.get(dir) === "tv") counts.unparsed++;
      // 判成电影目录时, 那个"碰巧认出来的集号"不该留下 —— 它会让 12 部电影显示成
      // "认出 1 集的剧"。显式 `SxxEyy` 与已绑定/人工定过的季集不动。
      const isMovieDir = dirKinds.get(dir) !== "tv";
      const episodeInfo = isMovieDir ? null : episodeInfo0;
      const inferredInfo = isMovieDir ? null : inferredInfo0;
      // (季, 集) 是**绑定与人工**决定的元数据: 绑定目录时定季、「改季」改季、摊到各季定集、
      // set-episode 补集号。扫描只该给新文件一个初始猜测, 不该覆盖这些决定 ——
      // 否则重扫一次, 七季的剧又全被打回第 1 季(踩过)。
      // 唯一例外: 文件名显式写了 `SxxEyy`, 那是文件自己声明的身份, 以它为准。
      const explicit = episodeInfo0?.seasonExplicit === true;
      // 电影目录里的旧集号 (上一次扫描猜的) 也要清: 只保留已绑定的 (绑定后季集归人管)
      const staleEpisode = isMovieDir && !explicit && (previous?.number ?? null) === null;
      const parsedSeason = explicit ? episodeInfo0!.season : null;
      // 电影目录里丢掉的只是"猜出来的"集号; 文件自己写了 SxxEyy 就还是它的身份
      const parsedEpisode = explicit ? episodeInfo0!.episode : (episodeInfo?.episode ?? inferredInfo?.episode ?? null);
      const assigned =
        !staleEpisode && previous !== undefined && previous.season !== null && previous.episode !== null;
      let season: number | null;
      let episode: number | null;
      if (parsedSeason !== null) {
        season = parsedSeason;
        episode = parsedEpisode;
      } else if (assigned) {
        season = previous.season ?? null;
        episode = previous.episode ?? null;
      } else {
        // 只补集号(比如刚补了解析规则): 季沿用已有的, 新文件就用解析出来的(季目录 / 兜底 1)
        season = previous?.season ?? episodeInfo?.season ?? inferredInfo?.season ?? null;
        episode = parsedEpisode;
      }
      // phase 也算"变了": 解析器升级后(分碟标记以前认不出 `你是我的命运CD2.mkv`),
      // 文件本身一个字节都没变, 但 index 里的 phase 该更新 —— 否则整理计划永远拿不到 cd 号。
      const phase = parseFileInfo(file.path);
      const phaseJson = stringify(phase);

      const untouched =
        previous &&
        previous.size === file.size &&
        previous.mtime_ms === file.mtimeMs &&
        previous.phase === phaseJson &&
        (previous.season ?? null) === season &&
        (previous.episode ?? null) === episode;
      if (untouched) {
        counts.unchanged++;
        emit({ type: "file.unchanged", path: file.path, number: null });
        continue;
      }

      // 影视文件此刻没有身份: number 留空, 于是它自然落在"未识别"里等绑定。
      const type: ScanEventType = previous ? "file.updated" : "file.added";
      counts[type === "file.added" ? "added" : "updated"]++;

      if (!dryRun) {
        rt.db.run(
          // number 一律保留: 影视文件的身份来自**绑定**, 扫描只负责季/集与文件属性。
          // 写成 excluded.number(null) 会把已绑定的文件打回未识别 —— 重扫一次全库就得重绑。
          `insert into media_files (path, library_id, number, size, mtime_ms, sha256, phase, season, episode, seen_at)
           values (?, ?, null, ?, ?, ?, ?, ?, ?, unixepoch())
           on conflict(path) do update set library_id = excluded.library_id,
             number = coalesce(media_files.number, excluded.number),
             size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256,
             phase = excluded.phase, season = excluded.season, episode = excluded.episode, seen_at = excluded.seen_at`,
          [file.path, library.id, file.size, file.mtimeMs, previous?.sha256 ?? null, phaseJson, season, episode],
        );
      }
      emit({ type, path: file.path, number: null });
    }

    pruneMissing(rt, { library, known, seen, dryRun, force: opts.force === true, counts, emit });
    counts.shows = shows.size;

    if (dryRun) rt.db.exec("rollback");
    else rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  return { libraryId: library.id, root: library.root, dryRun, counts, durationMs: Date.now() - started };
}

export interface MediaFileView {
  path: string;
  number: string | null;
  /** 影视域的集号; av 域为 null。 */
  season: number | null;
  episode: number | null;
  libraryId: number;
  size: number;
  mtimeMs: number;
  phase: FileInfo;
}

/**
 * 索引里的文件清单。`unparsedOnly` 就是"扫到了但认不出番号"的那批 ——
 * 它们不会有 items 行, 所以在条目列表里永远看不到, 必须单独给入口。
 */
export function listFiles(
  rt: Runtime,
  options: { libraryId?: number; unparsedOnly?: boolean; limit?: number; offset?: number } = {},
): MediaFileView[] {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (options.libraryId !== undefined) {
    where.push("library_id = ?");
    params.push(options.libraryId);
  }
  if (options.unparsedOnly) where.push("number is null");

  const sql = `select path, number, library_id, size, mtime_ms, phase, season, episode from media_files
    ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
    order by path limit ? offset ?`;
  params.push(options.limit ?? 200, options.offset ?? 0);

  return rt.db.all<MediaFileRow & { library_id: number; size: number; mtime_ms: number }>(sql, params).map((row) => ({
    path: row.path,
    number: row.number,
    season: row.season ?? null,
    episode: row.episode ?? null,
    libraryId: row.library_id,
    size: row.size,
    mtimeMs: row.mtime_ms,
    phase: parsePhase(row.phase),
  }));
}

export function countFiles(
  rt: Runtime,
  options: { libraryId?: number; unparsedOnly?: boolean } = {},
): number {
  const where: string[] = [];
  const params: number[] = [];
  if (options.libraryId !== undefined) {
    where.push("library_id = ?");
    params.push(options.libraryId);
  }
  if (options.unparsedOnly) where.push("number is null");
  const sql = `select count(*) c from media_files ${where.length > 0 ? `where ${where.join(" and ")}` : ""}`;
  return rt.db.get<{ c: number }>(sql, params)?.c ?? 0;
}

/** 供 GUI / 排查用: 某个文件当前登记到的相位。 */
export function filePhase(rt: Runtime, path: string) {
  const row = rt.db.get<MediaFileRow>("select * from media_files where path = ?", [path]);
  return row ? parsePhase(row.phase) : null;
}

/**
 * 条目还空着的时候, 用视频旁边的同名 nfo 补上元数据。
 *
 * 只在 `title` 为空时动手: 库里已经有刮削结果的条目, 不该被一个旧 nfo 覆盖回去。
 */
/**
 * 没刮过网络的条目, 按当前解析器重新判定内容类型。
 *
 * 判据是"从来没被任何来源填过字段" —— `field_sources` 为空说明它身上的数据
 * 不是刮来的 (可能只是从旁边的 nfo 读回来的标题)。这类条目改类型没有损失。
 *
 * 已经真刮过字段的条目不在此列: 换类型等于换来源线, 而且 `{content_type}`
 * 目录模板会跟着变, 该由人来决定 (`kura item retype`)。
 */
function retypeUntouched(rt: Runtime, number: string, detected: string): boolean {
  const row = rt.db.get<{ content_type: string; title: string | null; field_sources: string | null }>(
    "select content_type, title, field_sources from items where number = ?",
    [number],
  );
  if (!row || row.content_type === detected) return false;
  const sources = row.field_sources;
  const scraped = Boolean(sources && sources !== "{}" && sources !== "null");
  if (scraped && row.title) return false;
  rt.db.run("update items set content_type = ?, updated_at = unixepoch() where number = ?", [detected, number]);
  return true;
}

function fieldSourcesOf(rt: Runtime, number: string): Record<string, string> {
  const row = rt.db.get<{ field_sources: string | null }>("select field_sources from items where number = ?", [number]);
  return parseFieldSources(row?.field_sources);
}

function parseFieldSources(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function walk(dir: string, out: Found[], auxiliary: { count: number }): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, out, auxiliary);
    } else if (entry.isFile()) {
      if (!VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      // Emby/Jellyfin 的主题视频与预告片不是影片: 登记了就会被当成同一番号的另一个"文件",
      // 同步 NFO 时还会去写它们的 theme_video.nfo / trailer.nfo。 (见 isAuxiliaryMedia)
      if (isAuxiliaryMedia(path)) {
        auxiliary.count++;
        continue;
      }
      const info = await stat(path);
      out.push({ path, size: info.size, mtimeMs: Math.round(info.mtimeMs) });
    }
  }
}

/**
 * 相对库根的路径, 用于番号识别的兜底。
 *
 * 不能直接 `path.relative()`: Windows 上库根与文件路径的大小写可能不一致, 那时
 * `relative` 会返回绝对路径, 等于把库根又算了进去。这里只做前缀裁剪。
 */
function relativeInLibrary(root: string, path: string): string {
  if (!path.startsWith(root)) return path;
  return path.slice(root.length).replace(/^[\\/]+/, "");
}
