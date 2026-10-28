import { AppError, EXIT } from "../exit";
import { aggregate, mergeWithPinned } from "../domain/aggregate";
import type { ItemKey, Metadata, SourceRecord } from "../domain/types";
import { metadataColumns, parseJson, pinnedFields, rowToMetadata, stringify, type ItemRow } from "../db/rows";
import type { Runtime } from "../runtime";
import { routeFor, type Registry } from "../sources";

export interface ScrapeOptions {
  key: ItemKey;
  registry: Registry;
  fixturesDir?: string | null;
  /** 显式覆盖路由, 顺序即优先级。`--source fixture` 用它。 */
  sources?: string[];
  dryRun?: boolean;
}

export interface ScrapeReport {
  key: string;
  contentType: string;
  /** 实际参与的来源(按优先级)。 */
  route: string[];
  /** 路由里声明了但还没实现的来源。 */
  skipped: string[];
  filled: string[];
  empty: string[];
  failures: { site: string; error: string }[];
  metadata: Metadata | null;
  dryRun: boolean;
}

/**
 * SCRAPE: 只读网络, 不动文件。
 * 一个源失败不让整次刮削失败 —— 这是"站点是易碎品"的直接体现。
 */
export async function scrape(rt: Runtime, opts: ScrapeOptions): Promise<ScrapeReport> {
  const dryRun = opts.dryRun ?? false;
  const declared = routeFor(opts.registry, opts.key.contentType, opts.sources);
  const usable = declared.filter((source) => source.status === "ready");
  const skipped = declared.filter((source) => source.status !== "ready").map((source) => source.id);

  if (usable.length === 0) {
    throw new AppError(
      `没有可用来源 (路由: ${declared.map((s) => s.id).join(" → ") || "空"})`,
      EXIT.NEEDS_INPUT,
      { contentType: opts.key.contentType, skipped },
    );
  }

  const settled = await Promise.allSettled(
    usable.map((source) => source.fetch(opts.key, { fixturesDir: opts.fixturesDir ?? null })),
  );

  const records: SourceRecord[] = [];
  const failures: { site: string; error: string }[] = [];

  settled.forEach((result, index) => {
    const site = usable[index]!.id;
    if (result.status === "rejected") {
      failures.push({ site, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      return;
    }
    if (result.value) records.push({ site, fields: result.value });
  });

  const incoming = aggregate(records, usable.map((source) => source.id));

  const existingRow = rt.db.get<ItemRow>("select * from items where number = ?", [opts.key.value]);
  const existing = existingRow ? rowToMetadata(existingRow) : null;
  const pinned = existing ? pinnedFields(rt.db, opts.key.value) : [];
  const merged = mergeWithPinned(incoming, existing ?? {}, pinned);

  const metadata: Metadata = {
    key: opts.key.value,
    number: opts.key.number,
    contentType: opts.key.contentType,
    ...merged.fields,
    fieldSources: merged.fieldSources,
  };

  if (!dryRun) persist(rt, metadata, records);

  const filled = Object.entries(merged.fields)
    .filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0))
    .map(([key]) => key);

  return {
    key: opts.key.value,
    contentType: opts.key.contentType,
    route: usable.map((source) => source.id),
    skipped,
    filled,
    empty: ["title", "plot", "release_date", "duration_min", "studio", "label", "series", "directors", "actors", "tags"].filter(
      (key) => !filled.includes(key),
    ),
    failures,
    metadata: dryRun ? null : metadata,
    dryRun,
  };
}

function persist(rt: Runtime, metadata: Metadata, records: SourceRecord[]): void {
  const columns = metadataColumns(metadata);
  const names = Object.keys(columns);

  rt.db.exec("begin");
  try {
    rt.db.run(
      `insert into items (${names.join(", ")}, updated_at) values (${names.map(() => "?").join(", ")}, unixepoch())
       on conflict(number) do update set ${names
         .filter((name) => name !== "number")
         .map((name) => `${name} = excluded.${name}`)
         .join(", ")}, updated_at = unixepoch()`,
      names.map((name) => columns[name]),
    );

    for (const record of records) {
      rt.db.run(
        `insert into snapshots (number, site, fields, fetched_at) values (?, ?, ?, unixepoch())
         on conflict(number, site) do update set fields = excluded.fields, fetched_at = unixepoch()`,
        [metadata.key, record.site, JSON.stringify(record.fields)],
      );
    }
    rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }
}

/** 待刮削 = 有番号但还没有标题的条目。 */
export function pendingKeys(rt: Runtime, limit = 50): ItemKey[] {
  const rows = rt.db.all<{ number: string; content_type: string }>(
    "select number, content_type from items where title is null or title = '' order by number limit ?",
    [limit],
  );
  return rows.map((row) => ({
    value: row.number,
    number: row.number,
    contentType: row.content_type as ItemKey["contentType"],
  }));
}

export interface ItemView extends Metadata {
  pinned: string[];
}

export function getItem(rt: Runtime, key: string): ItemView | null {
  const row = rt.db.get<ItemRow>("select * from items where number = ?", [key]);
  if (!row) return null;
  return { ...rowToMetadata(row), pinned: pinnedFields(rt.db, key) };
}

export function listItems(rt: Runtime, options: { limit?: number; type?: string } = {}): ItemView[] {
  const limit = options.limit ?? 50;
  const rows = options.type
    ? rt.db.all<ItemRow>("select * from items where content_type = ? order by updated_at desc limit ?", [
        options.type,
        limit,
      ])
    : rt.db.all<ItemRow>("select * from items order by updated_at desc limit ?", [limit]);
  return rows.map((row) => ({ ...rowToMetadata(row), pinned: parseJson<string[]>(row.pinned) ?? [] }));
}
