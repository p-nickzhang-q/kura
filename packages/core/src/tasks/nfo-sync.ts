import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildNfo } from "../domain/materialize";
import { isAuxiliaryMedia } from "../domain/identify";
import { nfoPathFor, nfoToMetadata, parseNfo, updateNfoContent, type NfoFields } from "../domain/nfo";
import { metadataColumns, rowToMetadata, stringify, type ItemRow } from "../db/rows";
import { pruneActors, syncItemActors } from "../db/actors";
import type { Metadata } from "../domain/types";
import { createTask, runTask, type TaskRow } from "./queue";
import type { Runtime } from "../runtime";

/**
 * NFO 的双向同步 —— 与 `scan` 读 nfo 是同一件事的两个方向。
 *
 * 为什么必须成对出现: Emby / Jellyfin / Kodi 读的是 **nfo 文件**, Kura 改的是自己的库。
 * 只读不写, 播放器里永远是旧演员; 只写不读, 换机器重扫就丢了元数据。
 *
 * 一次过, 每个文件只做一件事, 规则是确定的 (没有"冲突"需要人裁决):
 *  - 库里没有网络来源 → 读 nfo 当种子(只填空字段), 库补上;
 *  - 库里有网络来源 → 用库里的值改 nfo(Kura 认识的字段, 其它标签原样保留);
 *  - 两边已经一致 → 什么都不做。
 *
 * 与 `organize` 的边界: 这里**不动视频、不改名、不建目录**, 只碰旁路文件。
 *
 * 性能注意: 用户的库常常在**网络盘**(SMB/NAS)上, 一次 open+read+close 就是一次往返。
 * 所以这里全是异步 IO + 有界并发, 并回报进度、响应取消 —— 同步 IO 串行跑 4000 个文件
 * 会把 Electron 主进程锁死几分钟, 界面直接"未响应"。
 */

export interface NfoSyncOptions {
  /** 不传 = 所有库 */
  libraryId?: number;
  /** 只处理这一条 */
  number?: string;
  /** 只处理这些番号 —— "重试失败项"用它, 免得整批再跑一遍 */
  numbers?: string[];
  /** 只写不读 */
  writeOnly?: boolean;
  /** 只读不写 */
  readOnly?: boolean;
  /** 连"没联网刮过"的条目也写(默认跳过写回, 但仍会读入) */
  includeUnscraped?: boolean;
  apply?: boolean;
  limit?: number;
  /** 并发文件数。网络盘上 8 路能明显缩短总时间, 再高对 SMB 没好处。 */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: NfoSyncProgress) => void;
}

export interface NfoSyncProgress {
  index: number;
  total: number;
  key: string;
  action: NfoSyncEntry["action"];
}

export interface NfoSyncEntry {
  number: string;
  path: string;
  nfoPath: string;
  action: "import" | "write" | "create" | "skip";
  reason?: string;
  changed: string[];
  ok?: boolean;
  error?: string;
}

export interface NfoSyncReport {
  dryRun: boolean;
  scanned: number;
  imported: number;
  written: number;
  created: number;
  skipped: number;
  errors: number;
  cancelled: boolean;
  entries: NfoSyncEntry[];
}

/** 一条条目的元数据是否真的联网刮过 —— NFO 种下的种子、手改的字段都不算。 */
export function hasNetworkSource(fieldSources: Record<string, string>): boolean {
  return Object.values(fieldSources).some((source) => source !== "nfo" && source !== "manual");
}

/** 键是 `Metadata` 的字段名(不是数据库列名 —— 原名是 titleOriginal)。 */
const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  titleOriginal: "原名",
  plot: "简介",
  release_date: "发行日期",
  duration_min: "时长",
  studio: "片商",
  label: "厂牌",
  series: "系列",
  actors: "演员",
  directors: "导演",
  tags: "标签",
};

function isFilled(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== "";
}

/**
 * 把 nfo 里**库中还空着**的字段并进来(纯函数, 不碰数据库)。
 * 已有的值不动 —— 这是"nfo 让步"的另一半: 网络值不会被旧 nfo 覆盖回来,
 * 但库里真没有的字段, 有 nfo 就该用起来。
 */
export function mergeNfoFields(current: Metadata, fields: NfoFields): { merged: Metadata; changed: string[] } {
  const seeded = nfoToMetadata(fields, current.key);
  const merged: Metadata = { ...current };
  const changed: string[] = [];

  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const column = key as keyof Metadata & string;
    if (isFilled(merged[column])) continue;
    const incoming = seeded[column];
    if (!isFilled(incoming)) continue;
    (merged as unknown as Record<string, unknown>)[column] = incoming;
    merged.fieldSources[column] = "nfo";
    changed.push(`${label} ← ${Array.isArray(incoming) ? incoming.join("、") : String(incoming)}`);
  }
  return { merged, changed };
}

/**
 * 有界并发 + 定期让出事件循环。
 *
 * 并发解决的是"网络盘上一次只能挂几个读"(IO 等待重叠); 但 cheerio 解析是 CPU 活,
 * 4000 个文件光解析就要几秒 —— 全跑在 Electron 主进程里, 期间 IPC 全部排队,
 * 窗口仍然"未响应"。所以每 24ms 主动 `setImmediate` 让一次, 让界面和「停止」按钮
 * 还能响应。总时长几乎不变, 但从"卡 5 秒"变成"每帧都能动"。
 */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  let lastYield = Date.now();
  const yieldIfNeeded = async (): Promise<void> => {
    if (Date.now() - lastYield < 24) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    lastYield = Date.now();
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index]!, index);
      await yieldIfNeeded();
    }
  });
  await Promise.all(workers);
}

/**
 * 原子替换一个文件: 先写 `<name>.kura-tmp`, 再 rename 覆盖。
 *
 * 直接 writeFile 是"先截断再写" —— 写到一半失败(占用/掉盘/权限)会留下半截 nfo,
 * 而 Emby 读的正是它。rename 在同一分区是原子的, 失败最多留下一个 .kura-tmp。
 */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.kura-tmp`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function readNfoText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function syncNfo(rt: Runtime, options: NfoSyncOptions = {}): Promise<NfoSyncReport> {
  const apply = options.apply === true;
  const limit = options.limit ?? 5000;
  const concurrency = options.concurrency ?? 8;
  const where: string[] = ["m.number is not null"];
  const params: unknown[] = [];
  if (options.libraryId !== undefined) {
    where.push("m.library_id = ?");
    params.push(options.libraryId);
  }
  if (options.number) {
    where.push("m.number = ?");
    params.push(options.number);
  }
  if (options.numbers) {
    if (options.numbers.length === 0) {
      return { dryRun: !apply, scanned: 0, imported: 0, written: 0, created: 0, skipped: 0, errors: 0, cancelled: false, entries: [] };
    }
    where.push(`m.number in (${options.numbers.map(() => "?").join(", ")})`);
    params.push(...options.numbers);
  }

  const rows = rt.db.all<ItemRow & { path: string }>(
    `select m.path, i.* from media_files m join items i on i.number = m.number
     where ${where.join(" and ")}
     order by m.path
     limit ?`,
    [...params, limit],
  );

  // 双保险: 扫描已经不再登记 Emby 的 theme_video / trailer, 但老库里还有 45 行,
  // 直接写会去改 Emby 自己的 .nfo。另外同一个 nfo 路径只处理一次(同番号多文件会重复)。
  const seenNfo = new Set<string>();
  const workRows: { row: ItemRow & { path: string }; nfoPath: string }[] = [];
  const preSkipped: NfoSyncEntry[] = [];
  for (const row of rows) {
    const nfoPath = nfoPathFor(row.path);
    if (isAuxiliaryMedia(row.path)) {
      preSkipped.push({
        number: row.number ?? row.path,
        path: row.path,
        nfoPath,
        action: "skip",
        reason: "Emby 辅助文件 (主题视频/预告片/样片), 不是影片",
        changed: [],
      });
      continue;
    }
    if (seenNfo.has(nfoPath)) {
      preSkipped.push({ number: row.number ?? row.path, path: row.path, nfoPath, action: "skip", reason: "同一份 nfo 已处理过", changed: [] });
      continue;
    }
    seenNfo.add(nfoPath);
    workRows.push({ row, nfoPath });
  }

  const total = workRows.length + preSkipped.length;
  const indexOf = new Map(workRows.map((item, index) => [item.row.path, index]));
  const entries: (NfoSyncEntry | undefined)[] = new Array(total);
  const report: NfoSyncReport = {
    dryRun: !apply,
    scanned: total,
    imported: 0,
    written: 0,
    created: 0,
    skipped: 0,
    errors: 0,
    cancelled: false,
    entries: [],
  };

  let done = 0;
  const finish = (index: number, entry: NfoSyncEntry): void => {
    entries[index] = entry;
    if (entry.error) report.errors++;
    else if (entry.action === "import") report.imported++;
    else if (entry.action === "write") report.written++;
    else if (entry.action === "create") report.created++;
    else report.skipped++;
    done++;
    options.onProgress?.({ index: done, total, key: entry.number, action: entry.action });
  };

  // ── 方向一: 库里没有网络来源 → 读 nfo 补空字段 ──
  const importRows = options.writeOnly ? [] : workRows.filter((item) => !hasNetworkSource(rowToMetadata(item.row).fieldSources));
  const importPaths = new Set(importRows.map((item) => item.row.path));
  const pendingUpdates: { number: string; merged: Metadata; changed: string[] }[] = [];

  await forEachLimit(importRows, concurrency, async ({ row, nfoPath }) => {
    const index = indexOf.get(row.path)!;
    if (options.signal?.aborted) return;
    const current = rowToMetadata(row);
    const entry: NfoSyncEntry = { number: current.key, path: row.path, nfoPath, action: "skip", changed: [] };

    const text = await readNfoText(nfoPath);
    const fields = text ? parseNfo(text) : null;
    if (!fields) {
      entry.reason = "旁边没有 nfo";
      finish(index, entry);
      return;
    }
    const { merged, changed } = mergeNfoFields(current, fields);
    if (changed.length === 0) {
      entry.reason = "库里的字段都齐了";
      finish(index, entry);
      return;
    }
    pendingUpdates.push({ number: current.key, merged, changed });
    finish(index, { ...entry, action: "import", changed });
  });

  // 读方向的落库合成一个事务: 4000 条各自提交 = 4000 次 fsync。
  if (apply && pendingUpdates.length > 0) {
    const touchedActors: string[] = [];
    rt.db.exec("begin");
    try {
      for (const update of pendingUpdates) {
        const columns = metadataColumns(update.merged);
        const names = Object.keys(columns);
        rt.db.run(
          `update items set ${names.map((name) => `${name} = ?`).join(", ")}, field_sources = ?, updated_at = unixepoch()
           where number = ?`,
          [...names.map((name) => columns[name]), stringify(update.merged.fieldSources), update.number],
        );
        if (update.changed.some((item) => item.startsWith("演员"))) touchedActors.push(update.number);
      }
      rt.db.exec("commit");
    } catch (err) {
      rt.db.exec("rollback");
      throw err;
    }
    // 演员索引在事务外重建: 它自己有提交逻辑, 塞进去会让回滚边界变糊。
    for (const number of touchedActors) syncItemActors(rt.db, number);
    if (touchedActors.length > 0) pruneActors(rt.db);
  }

  if (options.readOnly) {
    report.skipped += preSkipped.length;
    report.entries = [...preSkipped, ...entries.filter((entry): entry is NfoSyncEntry => entry !== undefined)];
    return report;
  }

  // ── 方向二: 库里有网络来源 → 用库里的值改 nfo ──
  const writeRows = workRows.filter((item) => !importPaths.has(item.row.path));
  await forEachLimit(writeRows, concurrency, async ({ row, nfoPath }) => {
    const index = indexOf.get(row.path)!;
    if (options.signal?.aborted) return;
    const metadata = rowToMetadata(row);
    const entry: NfoSyncEntry = { number: metadata.key, path: row.path, nfoPath, action: "skip", changed: [] };

    if (!metadata.title) {
      entry.reason = "还没有标题, 没有可写的内容";
      finish(index, entry);
      return;
    }
    if (!options.includeUnscraped && !hasNetworkSource(metadata.fieldSources)) {
      entry.reason = "没联网刮过 (只有 nfo/manual 来源), 回写只是抄旧值";
      finish(index, entry);
      return;
    }

    try {
      if (!existsSync(nfoPath)) {
        if (apply) await writeFileAtomic(nfoPath, buildNfo(metadata));
        finish(index, { ...entry, action: "create", changed: ["(新建)"] });
        return;
      }

      const original = await readNfoText(nfoPath);
      // 存在却读不出来(权限/占用/EISDIR)是**失败**, 不能算"跳过": 人需要看到它。
      if (original === null) throw new Error("nfo 存在但读不出来 (权限 / 被占用 / 不是文件)");
      const update = updateNfoContent(original, metadata);
      if (update.changed.length === 0) {
        finish(index, { ...entry, reason: "内容已经一致" });
        return;
      }
      if (apply) await writeFileAtomic(nfoPath, update.content);
      finish(index, { ...entry, action: "write", changed: update.changed });
    } catch (err) {
      // 单条失败不中断整批: 一个只读文件不该让 3000 个文件全白跑。
      finish(index, { ...entry, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  report.cancelled = options.signal?.aborted === true;
  report.skipped += preSkipped.length;
  report.entries = [...preSkipped, ...entries.filter((entry): entry is NfoSyncEntry => entry !== undefined)];
  return report;
}

/**
 * 带任务记录的同步 —— 与刮削/翻译同构: 一条 tasks 行 + 一份 jsonl + 进度与取消。
 *
 * 网络盘上 4000 个文件要跑几十秒到几分钟, 没有任务行的话, 关掉软件就查不到
 * "上次写回多少、哪几个失败"。
 */
export async function syncNfoTask(
  rt: Runtime,
  options: Omit<NfoSyncOptions, "signal" | "onProgress">,
  signal: AbortSignal,
  onProgress?: (progress: NfoSyncProgress) => void,
): Promise<{ task: TaskRow; result: NfoSyncReport | null }> {
  const task = createTask(rt, { type: "nfo.sync", payload: { ...describeOptions(options) }, total: 0 });

  return runTask(rt, task, signal, async (run) => {
    const report = await syncNfo(rt, {
      ...options,
      signal: run.signal,
      onProgress: (progress) => {
        // total 只有跑到 syncNfo 里才知道: 这里用 coalesce 补上。
        run.progress(progress.index, 0, progress.total);
        onProgress?.(progress);
      },
    });
    // 逐条写日志, 失败的要留在 jsonl 里给「任务详情」与「重跑失败」用。
    for (const entry of report.entries) {
      if (entry.action === "skip" && !entry.error) continue;
      run.log.write("item", {
        key: entry.number,
        ok: !entry.error,
        action: entry.action,
        changed: entry.changed.slice(0, 5),
        error: entry.error ?? null,
      });
    }
    return {
      result: report,
      // processed = 看过的文件数(含跳过的): 3883 个里跳过 3800 也说明"跑完了"。
      processed: report.scanned,
      failed: report.errors,
    };
  });
}

function describeOptions(options: NfoSyncOptions): Record<string, unknown> {
  return {
    ...(options.libraryId !== undefined ? { libraryId: options.libraryId } : {}),
    ...(options.number ? { number: options.number } : {}),
    ...(options.numbers ? { numbers: options.numbers } : {}),
    ...(options.includeUnscraped ? { includeUnscraped: true } : {}),
    ...(options.writeOnly ? { writeOnly: true } : {}),
  };
}
