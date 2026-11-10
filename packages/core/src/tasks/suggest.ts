import type { AliasEngine } from "../llm/ai-title";
import type { TmdbClient, TmdbSearchHit } from "../sources/tmdb";
import { guessTitleFromDir, guessTitleFromFile, matchConfidence, searchableGuess, type MatchConfidence } from "../domain/title-guess";
import { sep } from "node:path";
import { listBindableDirs, type BindingSuggestion } from "./bind";
import { createTask, getTask, runTask, type TaskRow } from "./queue";
import type { Runtime } from "../runtime";

/**
 * 为"待绑定的目录"批量生成搜索建议。
 *
 * **这是建议, 不是决定**: 只把 TMDB 搜索跑一遍并按把握排序, 绑哪个永远由人确认
 * (ADR 0008 决策 4 —— 猜错 TMDB id 等于整季集名全错)。
 * 省掉的是"输入名字 → 等搜索 → 翻结果"三次交互, 留下的是一次扫视 + 确认。
 */

export interface SuggestOptions {
  libraryId?: number;
  /** 只对这类候选搜索 (默认全部): 真库里电影候选可能几百个, 不该一起搜。 */
  kind?: "tv" | "movie";
  /**
   * 只搜这些目录 (未识别页勾选的候选)。省略 = 按 kind/limit 全量。
   *
   * 勾选一个目录时, 它下面的**每个**候选都算选中 —— 电影候选的 key 是文件路径,
   * tv 候选的 key 是目录, 两种粒度都得被"勾了这个目录"覆盖到。
   */
  dirs?: string[];
  tmdb: TmdbClient;
  /**
   * 配了就给"一个都没搜到"的候选补一轮别名搜索(ADR 0010)。
   *
   * 只补 0 命中的: 已经把 TMDB 搜到的候选不再花模型调用。
   */
  aliases?: AliasEngine | null;
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { index: number; total: number; dir: string }) => void;
}

/**
 * 这次要搜哪些候选。
 *
 * `suggestBindings` 与 `suggestBindingsTask`(算 total) 必须用同一份清单,
 * 否则进度条的分母会和实际跑的数量对不上。
 */
export function suggestTargets(rt: Runtime, options: SuggestOptions): ReturnType<typeof listBindableDirs> {
  const limit = options.limit ?? 100;
  const checked = (options.dirs ?? []).map((dir) => dir.replace(/[\\/]+$/, "")).filter(Boolean);
  // 勾选时先取全量再过滤: 先截断再筛, 勾中的目录可能已经掉在 100 条之外了
  const candidates = listBindableDirs(rt, {
    libraryId: options.libraryId,
    ...(options.kind ? { kind: options.kind } : {}),
    limit: checked.length > 0 ? Number.MAX_SAFE_INTEGER : limit,
  });
  if (checked.length === 0) return candidates;
  // 勾选是**人明确指定的范围**, 不再拿 100 截断: 勾了 13 个目录却只搜前 100 个候选,
  // 剩下的会静默消失 (实测 158 个候选只搜了 100 个)。
  return candidates.filter((candidate) => inChecked(candidate.dir, checked));
}

/** 候选的 key 是目录(tv) 或文件路径(movie) —— 两种都要被"勾了这个目录"覆盖。 */
function inChecked(candidateDir: string, checked: string[]): boolean {
  return checked.some((dir) => candidateDir === dir || candidateDir.startsWith(`${dir}${sep}`));
}

export async function suggestBindings(rt: Runtime, options: SuggestOptions): Promise<BindingSuggestion[]> {
  const dirs = suggestTargets(rt, options);
  const out: (BindingSuggestion | null)[] = new Array(dirs.length).fill(null);
  /** 同名目录(两季分开放)会撞同一个搜索词: 一轮里只查一次。 */
  const cache = new Map<string, TmdbSearchHit[]>();
  const inFlight = new Map<string, Promise<TmdbSearchHit[]>>();
  let started = 0;

  const searchOnce = async (kind: "tv" | "movie", title: string, year: string | null): Promise<TmdbSearchHit[]> => {
    const cacheKey = `${kind}|${title}|${year ?? ""}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    // 同一个词的并发请求合成一个, 别把同样的查询发两遍
    const running = inFlight.get(cacheKey);
    if (running) return running;
    const task = options.tmdb
      .search(kind, title, year ? { year } : {})
      .then((hits) => {
        cache.set(cacheKey, hits);
        return hits;
      })
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, task);
    return task;
  };

  /** 一个目录 → 一条建议。抽出来是为了能并发跑。 */
  const suggestOne = async (dir: (typeof dirs)[number]): Promise<BindingSuggestion> => {
    // 电影候选的 name 是**文件名**, 比目录名脏得多(发布站前缀 + 画质/语言标记粘在片名后面);
    // 拿整串去搜 TMDB 是 0 命中, 而 0 命中看起来像"库里没这片"。
    const guess = dir.kind === "tv" ? guessTitleFromDir(dir.name) : guessTitleFromFile(dir.name);

    const base: BindingSuggestion = {
      dir: dir.dir,
      name: dir.name,
      files: dir.files,
      parsed: dir.parsed,
      kind: dir.kind,
      paths: dir.paths,
      query: guess.title,
      year: guess.year,
      hit: null,
      confidence: "none",
    };

    // 名字像同一部剧散集的文件不搜: 把其中一集绑成一部"电影"或"1 集的剧"都是错的,
    // 正确做法是补集号后重扫 (文件上是 EP/集 的写法没被认出来)
    if (dir.suspectSeries) return base;

    // 片名叫不出来(比如目录叫"电影")就别瞎搜, 留给人工
    if (!searchableGuess(guess)) return base;

    // unknown 的候选没有"整体"语义, 只能按电影搜
    const searchKind: "tv" | "movie" = dir.kind === "tv" ? "tv" : "movie";
    try {
      const hits = await searchOnce(searchKind, guess.title, guess.year);
      const scored = hits
        .map((hit) => ({ hit, confidence: matchConfidence(guess, hit) }))
        .sort((a, b) => rank(b.confidence) - rank(a.confidence) || b.hit.score - a.hit.score);
      const best = scored[0];
      // low 不算建议: 显示一堆"可能不是它"只会让人更慢
      if (best && best.confidence !== "low") {
        return {
          ...base,
          hit: { key: best.hit.key, title: best.hit.title, year: best.hit.year, id: best.hit.id },
          confidence: best.confidence,
        };
      }
      return base;
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  };

  // 4 并发: 串行跑 23 个目录要一分多钟, 而这只是"查一查", 没有任何写操作。
  // TMDB 的额度是 50 req/s, 4 并发远低于上限。
  const CONCURRENCY = 4;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return;
      const index = started++;
      const dir = dirs[index];
      if (!dir) return;
      out[index] = await suggestOne(dir);
      options.onProgress?.({ index: out.filter(Boolean).length, total: dirs.length, dir: dir.name });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dirs.length) }, worker));

  const results = out.filter((entry): entry is BindingSuggestion => entry !== null);

  // 第二批: 一条都没搜到的候选, 问模型"它还可能叫什么", 再各搜一次。
  // 只做 0 命中的 —— 已经有 high 命中的候选不该再烧模型调用。
  if (options.aliases && !options.signal?.aborted) {
    const misses = results.filter(
      (entry) => !entry.hit && !entry.error && !entry.suspectSeries && searchableGuess({ title: entry.query, year: entry.year }),
    );
    if (misses.length > 0) {
      const names = [...new Set(misses.map((entry) => entry.query).filter((name) => name.length > 0))];
      const guesses = await options.aliases.suggest(names).catch(() => new Map());
      await Promise.all(
        misses.map(async (entry) => {
          const guess = guesses.get(entry.query);
          if (!guess) return;
          const queries = [guess.title, ...guess.aliases].filter((value): value is string => Boolean(value));
          for (const query of queries) {
            if (options.signal?.aborted) return;
            let hits: TmdbSearchHit[];
            try {
              // **不带年份**: 模型给的年份可能差一年, 而 TMDB 的 year 过滤会让整个搜索变空
              // (实测 `告白 2010` → 0 条, `告白` → 20 条)。
              hits = await searchOnce("movie", query, null);
            } catch {
              continue;
            }
            const scored = hits
              .map((hit) => ({ hit, confidence: matchConfidence({ title: query, year: guess.year }, hit) }))
              .sort((a, b) => rank(b.confidence) - rank(a.confidence) || b.hit.score - a.hit.score);
            const best = scored[0];
            if (!best || best.confidence === "low") continue;
            entry.hit = { key: best.hit.key, title: best.hit.title, year: best.hit.year, id: best.hit.id };
            // 别名找到的一律降一档: 不是文件名直接对上的, 让人多看一眼
            entry.confidence = best.confidence === "high" ? "medium" : best.confidence;
            entry.viaAlias = query;
            return;
          }
        }),
      );
    }
  }

  return results;
}

function rank(confidence: MatchConfidence): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : confidence === "low" ? 1 : 0;
}

/**
 * 批量找建议走任务:
 * 一个目录 = 一次 TMDB 搜索, 40 个目录就是 40 次往返 (per-host 漏桶是串行的)。
 * 没有进度条的话, 界面上就是"点了没反应" —— 而这活儿最容易被当成卡死。
 */
export async function suggestBindingsTask(
  rt: Runtime,
  options: SuggestOptions,
  signal: AbortSignal,
): Promise<{ task: TaskRow; result: BindingSuggestion[] | null; cancelled: boolean }> {
  const total = suggestTargets(rt, options).length;
  const task = createTask(rt, {
    type: "bind.suggest",
    payload: { libraryId: options.libraryId ?? null, dirs: options.dirs ?? null },
    total,
  });

  const { result } = await runTask(rt, task, signal, async (run) => {
    const suggestions = await suggestBindings(rt, {
      ...options,
      signal: run.signal,
      onProgress: (progress) => {
        // 失败数在任务里没意义(建议失败不算条目失败), 只推进度
        run.progress(progress.index, 0, progress.total);
        run.log.write("item", { ...progress });
        options.onProgress?.(progress);
      },
    });
    return { result: suggestions, processed: suggestions.length, failed: 0 };
  });

  // runTask 已经把行更新到终态, 这里读回最新的一份
  return { task: getTask(rt, task.id) ?? task, result, cancelled: signal.aborted };
}
