import type { Runtime } from "../runtime";
import { findLibrary, listLibraries } from "../db/rows";
import { countUnrecognized } from "./bind";
import { syncNfo } from "./nfo-sync";
import { exportTvNfo } from "./nfo-tv";
import { organize } from "./organize";
import { organizeVideo } from "./organize-video";
import { recoverFromNfo } from "./nfo-recover";
import { countFiles } from "./scan";
import { countPending } from "./scrape";
import { countPendingTranslation } from "./translate";

/**
 * "待办"页要的数字。
 *
 * 拆成两次调用是刻意的: 便宜的(数行/数目录)立刻返回, 贵的(要读磁盘算整理计划、
 * 要逐个读 .nfo 比对)在旁边慢慢补 —— 首页不该为了一个数字卡住几百毫秒, 尤其库在
 * 移动硬盘上时。
 */

/** 便宜的: 全是 SQL 计数, 毫秒级。 */
export interface TodoCounts {
  /** 认不出番号/片名的目录数 (影视: 一个目录 = 一部; 番号制: 无意义的 0)。 */
  unparsedDirs: number;
  unparsedFiles: number;
  pendingScrape: number;
  pendingTranslate: number;
  /** 范围内的库里有几个允许整理 —— 全关了就不显示"可整理"这一行。 */
  organizeLibraries: number;
}

/** 贵的: 要读磁盘。 */
export interface TodoPlans {
  /** 整理会动多少 (dry run); 没有允许整理的库时为 null。 */
  organize: { move: number; writeNfo: number; copyImage: number; skip: number } | null;
  /** nfo 与库不一致的条数; 算不出来(异常)时为 null。 */
  nfo: { created: number; written: number } | null;
}

/**
 * "从 NFO 恢复"能恢复多少。
 *
 * 单独一个函数而不是塞进 `todoPlans`: 那边要跑整理计划(遍历全部文件)+ nfo 比对,
 * 在移动硬盘上实测 **11.9 秒** —— 而这一行是"换电脑第一眼要看的东西", 压在后面
 * 就等于看不到。这里只读未绑定文件旁边的 nfo, 一两秒。
 */
export async function todoRecover(
  rt: Runtime,
  options: { libraryId?: number } = {},
): Promise<{ shows: number; movies: number; locals: number; files: number; unbound: number; needsScan: boolean }> {
  let shows = 0;
  let movies = 0;
  let locals = 0;
  let files = 0;
  let unbound = 0;
  let needsScan = false;
  for (const library of scopeLibraries(rt, options.libraryId)) {
    if (library.domain !== "video") continue;
    const report = await recoverFromNfo(rt, { libraryId: library.id });
    shows += report.shows;
    movies += report.movies;
    locals += report.locals;
    files += report.files;
    unbound += report.unbound;
    needsScan = needsScan || report.needsScan;
  }
  return { shows, movies, locals, files, unbound: needsScan ? 0 : unbound, needsScan };
}

/** 待办数字里的"库范围": 侧栏选中哪个库就只看哪个, 没选就是全部。 */
function scopeLibraries(rt: Runtime, libraryId?: number) {
  if (libraryId === undefined) return listLibraries(rt.db);
  const library = findLibrary(rt.db, String(libraryId));
  return library ? [library] : [];
}

export function todoCounts(rt: Runtime, options: { libraryId?: number } = {}): TodoCounts {
  const libraries = scopeLibraries(rt, options.libraryId);

  // 两个域的"未识别"粒度不同: 影视按目录(= 一部剧/一部片), 番号制按文件。
  // 混着算会出现"未识别 0 个目录"但列表里躺着 40 个文件的自相矛盾。
  let unparsedDirs = 0;
  let unparsedFiles = 0;
  for (const library of libraries) {
    if (library.domain === "video") {
      const counted = countUnrecognized(rt, { libraryId: library.id });
      unparsedDirs += counted.dirs;
      unparsedFiles += counted.files;
    } else {
      unparsedFiles += countFiles(rt, { libraryId: library.id, unparsedOnly: true });
    }
  }

  return {
    unparsedDirs,
    unparsedFiles,
    pendingScrape: countPending(rt, options.libraryId === undefined ? {} : { libraryId: options.libraryId }),
    pendingTranslate: countPendingTranslation(rt),
    organizeLibraries: libraries.filter((library) => library.organizeEnabled !== false).length,
  };
}

export async function todoPlans(rt: Runtime, options: { libraryId?: number } = {}): Promise<TodoPlans> {
  const libraries = scopeLibraries(rt, options.libraryId).filter((library) => library.organizeEnabled !== false);

  const total = { move: 0, writeNfo: 0, copyImage: 0, skip: 0 };
  for (const library of libraries) {
    const report =
      library.domain === "video" ? await organizeVideo(rt, { library }) : await organize(rt, { library });
    total.move += report.plan.summary.move;
    total.writeNfo += report.plan.summary.writeNfo;
    total.copyImage += report.plan.summary.copyImage;
    total.skip += report.plan.summary.skip;
  }

  // 整库干跑一次只为了数"有多少份 nfo 落后": 这里不写盘, 也不改库。
  // 两个域两套 nfo, 必须分开算 —— 拿 av 那套去数影视, 数字会永远清不掉。
  let nfo: TodoPlans["nfo"] = null;
  try {
    let created = 0;
    let written = 0;
    for (const library of scopeLibraries(rt, options.libraryId)) {
      if (library.domain === "av") {
        const report = await syncNfo(rt, { libraryId: library.id });
        created += report.created;
        written += report.written;
      } else {
        const report = await exportTvNfo(rt, { libraryId: library.id, apply: false });
        created += report.created;
        written += report.updated;
      }
    }
    nfo = { created, written };
  } catch {
    // 数不出来就不显示数字 —— 首页不能因为一个可选提示变红。
    nfo = null;
  }

  return { organize: libraries.length === 0 ? null : total, nfo };
}
