import type { Runtime } from "../runtime";
import type { TmdbClient } from "../sources/tmdb";
import { AppError } from "../exit";
import { bindDirectory } from "./bind";
import { createTask, getTask, runTask, type TaskRow } from "./queue";
import { scrapeShow } from "./scrape-show";

/**
 * 「绑定并刮削」一条任务行。
 *
 * 以前这一步是 IPC 里一个 for 循环: 绑 64 个目录 + 每个刮一次 TMDB, 要好几分钟,
 * 而「任务」页里什么都没有 —— 关掉窗口就再也不知道跑到哪、哪几个失败了。
 * 绑定是不可逆的(文件从此归属某个 TMDB 条目), 更该留痕。
 */
export interface BindManyItem {
  dir: string;
  key: string;
  paths?: string[];
}

export interface BindManyResultItem {
  dir: string;
  key: string;
  ok: boolean;
  bound?: number;
  episodes?: number;
  stillUnparsed?: number;
  declared?: number;
  missing?: number;
  error?: string;
}

export interface BindManyOptions {
  libraryId: number;
  items: BindManyItem[];
  /** 绑完顺手刮一次; 没配 TMDB 时传 null, 只绑不刮。 */
  tmdb: TmdbClient | null;
  saveImages?: boolean;
}

export async function bindManyTask(
  rt: Runtime,
  options: BindManyOptions,
  signal: AbortSignal,
  onProgress?: (progress: { index: number; total: number; dir: string }) => void,
): Promise<{ task: TaskRow; results: BindManyResultItem[]; cancelled: boolean }> {
  const task = createTask(rt, {
    type: "bind.many",
    payload: { libraryId: options.libraryId, count: options.items.length },
    total: options.items.length,
  });

  const results: BindManyResultItem[] = [];
  let failed = 0;

  const { result } = await runTask(rt, task, signal, async (run) => {
    for (const [index, item] of options.items.entries()) {
      if (run.signal.aborted) break;
      try {
        const bound = bindDirectory(rt, {
          libraryId: options.libraryId,
          dir: item.dir,
          key: item.key,
          ...(item.paths ? { paths: item.paths } : {}),
        });
        const scraped = options.tmdb
          ? await scrapeShow(rt, {
              key: bound.key,
              tmdb: options.tmdb,
              saveImages: options.saveImages === true,
              signal: run.signal,
            })
          : null;
        results.push({
          dir: item.dir,
          key: item.key,
          ok: true,
          bound: bound.bound,
          episodes: bound.episodes,
          stillUnparsed: bound.stillUnparsed.length,
          ...(scraped ? { declared: scraped.declared, missing: scraped.missing } : {}),
        });
      } catch (err) {
        failed++;
        results.push({
          dir: item.dir,
          key: item.key,
          ok: false,
          error: err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err),
        });
      }
      run.progress(index + 1, failed, options.items.length);
      run.log.write("item", { index: index + 1, dir: item.dir, key: item.key, ok: results.at(-1)?.ok });
      onProgress?.({ index: index + 1, total: options.items.length, dir: item.dir });
    }
    return { result: results, processed: results.length, failed };
  });

  return { task: getTask(rt, task.id) ?? task, results: result ?? [], cancelled: signal.aborted };
}
