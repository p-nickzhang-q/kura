import { AppError, EXIT } from "../exit";
import { needsTranslation, type Translator } from "../llm/translate";
import { metadataColumns, rowToMetadata, type ItemRow } from "../db/rows";
import type { Metadata } from "../domain/types";
import type { Runtime } from "../runtime";

export interface TranslateReport {
  key: string;
  translated: string[];
  skipped?: string;
}

/**
 * 翻译单条条目: 覆盖 `title` / `plot` 的显示值, 原文写进 `*_original`。
 *
 * 与刮削分开是因为: 刮削读网络、翻译读模型, 两件事的失败原因和重试策略都不同。
 * 翻译失败不写库, 下次还能再来一遍。
 */
export async function translateItem(
  rt: Runtime,
  key: string,
  translator: Translator,
): Promise<TranslateReport> {
  const row = rt.db.get<ItemRow>("select * from items where number = ?", [key]);
  if (!row) throw new AppError(`条目不存在: ${key}`, EXIT.NOT_FOUND, { key });

  const metadata = rowToMetadata(row);
  const title = needsTranslation(metadata.title) ? await translator.translate("title", metadata.title!) : null;
  const plot = needsTranslation(metadata.plot) ? await translator.translate("plot", metadata.plot!) : null;

  const translated: string[] = [];
  if (title) translated.push("title");
  if (plot) translated.push("plot");

  if (translated.length === 0) {
    return { key, translated, skipped: "没有需要翻译的日文文本 (或模型返回空)" };
  }

  const next: Metadata = {
    ...metadata,
    title: title ?? metadata.title,
    plot: plot ?? metadata.plot,
    // 只在第一次翻译时记录原文, 之后重译不会把中文当原文。
    titleOriginal: metadata.titleOriginal ?? metadata.title,
    plotOriginal: metadata.plotOriginal ?? metadata.plot,
  };

  const columns = metadataColumns(next);
  rt.db.run(
    `update items set ${Object.keys(columns).map((name) => `${name} = ?`).join(", ")}, updated_at = unixepoch()
     where number = ?`,
    [...Object.values(columns), key],
  );

  return { key, translated };
}

/**
 * 待翻译 = 标题里还有假名, 且 `title_original` 为空 (从没翻过)。
 *
 * 用后者的原因: 翻译后 `title` 是中文、`title_original` 是日文原文,
 * 这样"翻过没有"是一个确定的布尔值, 不用去比较两个字符串。
 */
export function pendingTranslationKeys(rt: Runtime, limit = 1000): string[] {
  const rows = rt.db.all<{ number: string; title: string | null; title_original: string | null }>(
    "select number, title, title_original from items where title is not null and (title_original is null or title_original = '') order by updated_at desc limit ?",
    [limit],
  );
  return rows
    .filter((row) => needsTranslation(row.title ?? undefined))
    .map((row) => row.number);
}

/** 界面上显示"还有 N 条可翻译"。 */
export function countPendingTranslation(rt: Runtime): number {
  return pendingTranslationKeys(rt).length;
}

/**
 * 翻译进度一览。分开统计"已翻译"是因为界面上要能回答
 * "我翻了半天, 到底落了没有" —— 只看待翻译数说不清。
 */
export function translationStats(rt: Runtime): { translated: number; pending: number } {
  const row = rt.db.get<{ c: number }>(
    "select count(*) c from items where title_original is not null and title_original <> ''",
  );
  return { translated: row?.c ?? 0, pending: countPendingTranslation(rt) };
}

export interface RepairReport {
  key: string;
  fields: string[];
}

/**
 * 用本地缓存修复"其实早就翻过、但库里没记录"的条目。
 *
 * 为什么需要: 4.x 早期版本重新刮削会把 title_original 冲成 null, 条目于是重新变成
 * "待翻译", 而译文一直躺在 translations.db 里。这个函数不发任何网络请求,
 * 只是把缓存里的译文搬回条目上, 顺便补回原文。
 */
export function repairTranslations(
  rt: Runtime,
  translator: Translator,
): { repaired: number; reports: RepairReport[] } {
  if (!translator.lookup) return { repaired: 0, reports: [] };

  const rows = rt.db.all<{
    number: string;
    title: string | null;
    plot: string | null;
    title_original: string | null;
    plot_original: string | null;
  }>(
    `select number, title, plot, title_original, plot_original from items
     where (title_original is null or title_original = '') and title is not null`,
  );

  const reports: RepairReport[] = [];
  for (const row of rows) {
    const titleHit = row.title ? translator.lookup("title", row.title) : null;
    if (!titleHit) continue;

    const fields = ["title"];
    const patch: { title: string; title_original: string; plot?: string; plot_original?: string } = {
      title: titleHit,
      title_original: row.title!,
    };

    // 简介如果也翻过, 一起恢复
    if (row.plot && (!row.plot_original || row.plot_original === "")) {
      const plotHit = translator.lookup("plot", row.plot);
      if (plotHit) {
        patch.plot = plotHit;
        patch.plot_original = row.plot;
        fields.push("plot");
      }
    }

    rt.db.run(
      `update items set title = ?, title_original = ?${
        patch.plot !== undefined ? ", plot = ?, plot_original = ?" : ""
      }, updated_at = unixepoch() where number = ?`,
      patch.plot !== undefined
        ? [patch.title, patch.title_original, patch.plot, patch.plot_original!, row.number]
        : [patch.title, patch.title_original, row.number],
    );
    reports.push({ key: row.number, fields });
  }

  return { repaired: reports.length, reports };
}

export interface TranslateProgress {
  index: number;
  total: number;
  key: string;
  translated: string[];
  error?: string;
}

export interface TranslateBatchOptions {
  translator: Translator;
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TranslateProgress) => void;
}

/**
 * 批量翻译。与 scrape 分开是因为失败原因不同: 模型限流/超时不影响已翻好的条目,
 * 所以逐条 catch, 一条失败不中断整批。
 */
export interface TranslateBatchResult {
  count: number;
  cancelled: boolean;
  reports: TranslateProgress[];
  /** 真的写进库的条数。界面必须显示这个 —— 只报 count 会把"全部失败"显示成"翻译完成"。 */
  translated: number;
  failed: number;
  /** 有日文可翻但模型返回空 (或被判定不用翻) 的条数。 */
  skipped: number;
}

export async function translatePending(
  rt: Runtime,
  options: TranslateBatchOptions,
): Promise<TranslateBatchResult> {
  const keys = pendingTranslationKeys(rt, options.limit ?? 1000);
  const reports: TranslateProgress[] = [];
  let translated = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, key] of keys.entries()) {
    if (options.signal?.aborted) {
      return { count: reports.length, cancelled: true, reports, translated, failed, skipped };
    }
    try {
      const errorsBefore = options.translator.errors.length;
      const report = await translateItem(rt, key, options.translator);
      // 模型报错时 translate 返回 null, translateItem 不抛异常 ——
      // 所以"失败"要靠 translator.errors 的变化来识别, 否则会把失败算成"无变化"。
      const newErrors = options.translator.errors.slice(errorsBefore);

      if (report.translated.length > 0) {
        translated++;
      } else if (newErrors.length > 0) {
        failed++;
      } else {
        skipped++;
      }

      const progress = {
        index: index + 1,
        total: keys.length,
        key,
        translated: report.translated,
        ...(newErrors.length > 0 && report.translated.length === 0 ? { error: newErrors.at(-1) } : {}),
      };
      reports.push(progress);
      options.onProgress?.(progress);
    } catch (err) {
      failed++;
      const progress = {
        index: index + 1,
        total: keys.length,
        key,
        translated: [],
        error: err instanceof Error ? err.message : String(err),
      };
      reports.push(progress);
      options.onProgress?.(progress);
    }
  }

  return { count: reports.length, cancelled: false, reports, translated, failed, skipped };
}
