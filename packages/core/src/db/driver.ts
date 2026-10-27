/**
 * SQLite 驱动适配层。
 *
 * 为什么需要这层: GUI 跑在 Node (Electron) 里, 只能用内置 `node:sqlite`;
 * CLI 用 `bun build --compile` 打成单文件二进制, Bun 只实现 `bun:sqlite`, 不认 `node:sqlite`。
 * 两者 API 形状不同 (prepare().run() vs run()), 由本文件抹平。
 *
 * 用变量说明符动态 import 是刻意的: 打包器会尝试静态解析 `bun:sqlite` 并在 Node/Electron
 * 构建期报 "Could not resolve", 变量说明符让两个内建模块都留到运行期解析。
 */
export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): void;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
}

export interface DbInfo {
  runtime: "bun" | "node";
  file: string;
}

export interface OpenDbResult {
  db: Db;
  info: DbInfo;
}

export async function openDb(file: string): Promise<OpenDbResult> {
  const isBun = Boolean((process.versions as { bun?: string }).bun);
  const spec = isBun ? "bun:sqlite" : "node:sqlite";
  const mod = (await import(spec)) as Record<string, any>;

  if (isBun) {
    const raw = new mod.Database(file, { create: true });
    // WAL + busy_timeout: GUI 与 CLI 是不同进程, 会同时写同一个库。
    raw.exec("pragma journal_mode = wal");
    raw.exec("pragma busy_timeout = 5000");
    raw.exec("pragma foreign_keys = on");
    return {
      info: { runtime: "bun", file },
      db: {
        exec: (sql) => raw.exec(sql),
        run: (sql, params = []) => raw.run(sql, ...params),
        get: (sql, params = []) => raw.query(sql).get(...params),
        all: (sql, params = []) => raw.query(sql).all(...params),
        close: () => raw.close(),
      },
    };
  }

  const raw = new mod.DatabaseSync(file);
  raw.exec("pragma journal_mode = wal");
  raw.exec("pragma busy_timeout = 5000");
  raw.exec("pragma foreign_keys = on");
  return {
    info: { runtime: "node", file },
    db: {
      exec: (sql) => raw.exec(sql),
      run: (sql, params = []) => raw.prepare(sql).run(...params),
      get: (sql, params = []) => raw.prepare(sql).get(...params),
      all: (sql, params = []) => raw.prepare(sql).all(...params),
      close: () => raw.close(),
    },
  };
}
