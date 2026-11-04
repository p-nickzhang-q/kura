import type { TmdbClient, TmdbSearchHit } from "../sources/tmdb";
import { guessTitleFromDir, matchConfidence, searchableGuess, type MatchConfidence } from "../domain/title-guess";
import { listBindableDirs, type BindingSuggestion } from "./bind";
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
  tmdb: TmdbClient;
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { index: number; total: number; dir: string }) => void;
}

export async function suggestBindings(rt: Runtime, options: SuggestOptions): Promise<BindingSuggestion[]> {
  const dirs = listBindableDirs(rt, { libraryId: options.libraryId, limit: options.limit ?? 40 });
  const out: BindingSuggestion[] = [];
  /** 同名目录(两季分开放)会撞同一个搜索词: 一轮里只查一次。 */
  const cache = new Map<string, TmdbSearchHit[]>();

  for (let index = 0; index < dirs.length; index++) {
    if (options.signal?.aborted) break;
    const dir = dirs[index]!;
    const guess = guessTitleFromDir(dir.name);
    options.onProgress?.({ index: index + 1, total: dirs.length, dir: dir.name });

    const base: BindingSuggestion = {
      dir: dir.dir,
      name: dir.name,
      files: dir.files,
      parsed: dir.parsed,
      kind: dir.kind,
      query: guess.title,
      year: guess.year,
      hit: null,
      confidence: "none",
    };

    // 片名叫不出来(比如目录叫"电影")就别瞎搜, 留给人工
    if (!searchableGuess(guess)) {
      out.push(base);
      continue;
    }

    const cacheKey = `${dir.kind}|${guess.title}|${guess.year ?? ""}`;
    try {
      let hits = cache.get(cacheKey);
      if (!hits) {
        hits = await options.tmdb.search(dir.kind, guess.title, guess.year ? { year: guess.year } : {});
        cache.set(cacheKey, hits);
      }
      const scored = hits
        .map((hit) => ({ hit, confidence: matchConfidence(guess, hit) }))
        .sort((a, b) => rank(b.confidence) - rank(a.confidence) || b.hit.score - a.hit.score);
      const best = scored[0];
      // low 不算建议: 显示一堆"可能不是它"只会让人更慢
      if (best && best.confidence !== "low") {
        out.push({
          ...base,
          hit: { key: best.hit.key, title: best.hit.title, year: best.hit.year, id: best.hit.id },
          confidence: best.confidence,
        });
      } else {
        out.push(base);
      }
    } catch (err) {
      out.push({ ...base, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return out;
}

function rank(confidence: MatchConfidence): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : confidence === "low" ? 1 : 0;
}
