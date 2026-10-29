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

/** 待翻译 = 含假名且还没被翻译过(显示值仍等于原文或原文为空)。 */
export function pendingTranslationKeys(rt: Runtime, limit = 20): string[] {
  const rows = rt.db.all<{ number: string; title: string | null; title_original: string | null }>(
    "select number, title, title_original from items where title is not null order by updated_at desc limit ?",
    [limit],
  );
  return rows
    .filter((row) => needsTranslation(row.title ?? undefined))
    .map((row) => row.number);
}
