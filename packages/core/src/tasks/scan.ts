import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { AppError, EXIT } from "../exit";
import type { Runtime } from "../runtime";

export type ScanEventType = "file.added" | "file.updated" | "file.unchanged" | "file.removed";

export interface ScanEvent {
  type: ScanEventType;
  path: string;
  size?: number;
}

export interface ScanReport {
  root: string;
  dryRun: boolean;
  counts: { added: number; updated: number; unchanged: number; removed: number };
  durationMs: number;
}

export interface ScanOptions {
  root: string;
  dryRun?: boolean;
  /** 流式事件, CLI 的 --stream 与 GUI 的进度条都吃这个, 不要额外造一套回调。 */
  onEvent?: (event: ScanEvent) => void;
}

interface ItemRow {
  path: string;
  size: number;
  mtime_ms: number;
  sha256: string;
}

interface Found {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * 扫描目录并把文件指纹写入库。幂等: 同一目录重复扫描, 第二次应全部 unchanged。
 * 只比较 size + mtime 决定是否需要重新 hash —— 大库重扫的主要成本在这里。
 */
export async function scan(rt: Runtime, opts: ScanOptions): Promise<ScanReport> {
  const started = Date.now();
  const root = opts.root;
  const dryRun = opts.dryRun ?? true;
  const emit = opts.onEvent ?? (() => {});

  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new AppError(`不是目录: ${root}`, EXIT.NOT_FOUND, { root });
  }

  const known = new Map<string, ItemRow>();
  for (const row of rt.db.all<ItemRow>("select path, size, mtime_ms, sha256 from items")) {
    known.set(row.path, row);
  }

  const found: Found[] = [];
  await walk(root, found);

  const counts = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  const seen = new Set<string>();

  rt.db.exec("begin");
  try {
    for (const file of found) {
      seen.add(file.path);
      const prev = known.get(file.path);

      if (prev && prev.size === file.size && prev.mtime_ms === file.mtimeMs) {
        counts.unchanged++;
        emit({ type: "file.unchanged", path: file.path, size: file.size });
        continue;
      }

      const sha256 = await hashFile(file.path);
      if (prev && prev.sha256 === sha256) {
        counts.unchanged++;
        if (!dryRun) touch(rt, file);
        emit({ type: "file.unchanged", path: file.path, size: file.size });
        continue;
      }

      const type: ScanEventType = prev ? "file.updated" : "file.added";
      counts[type === "file.added" ? "added" : "updated"]++;
      if (!dryRun) upsert(rt, file, sha256);
      emit({ type, path: file.path, size: file.size });
    }

    for (const [path] of known) {
      if (seen.has(path)) continue;
      counts.removed++;
      if (!dryRun) rt.db.run("delete from items where path = ?", [path]);
      emit({ type: "file.removed", path });
    }

    if (dryRun) rt.db.exec("rollback");
    else rt.db.exec("commit");
  } catch (err) {
    rt.db.exec("rollback");
    throw err;
  }

  return { root, dryRun, counts, durationMs: Date.now() - started };
}

function upsert(rt: Runtime, file: Found, sha256: string): void {
  rt.db.run(
    `insert into items (path, size, mtime_ms, sha256, seen_at) values (?, ?, ?, ?, unixepoch())
     on conflict(path) do update set size = excluded.size, mtime_ms = excluded.mtime_ms,
       sha256 = excluded.sha256, seen_at = excluded.seen_at`,
    [file.path, file.size, file.mtimeMs, sha256],
  );
}

function touch(rt: Runtime, file: Found): void {
  rt.db.run("update items set mtime_ms = ?, seen_at = unixepoch() where path = ?", [file.mtimeMs, file.path]);
}

async function walk(dir: string, out: Found[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, out);
    } else if (entry.isFile()) {
      const info = await stat(path);
      out.push({ path, size: info.size, mtimeMs: Math.round(info.mtimeMs) });
    }
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** 供 GUI 展示用: 把绝对路径转成相对库根的展示路径。 */
export function displayPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}
