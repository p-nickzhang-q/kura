import { mkdirSync } from "node:fs";
import { openDb, type Db, type DbInfo } from "./db/driver";
import { migrate } from "./db/schema";
import { loadSettings, type Settings } from "./config";
import { recoverInterrupted } from "./tasks/queue";
import { resolvePaths, type Paths } from "./paths";

/**
 * 组合根 (composition root)。
 *
 * GUI 与 CLI 都从这里进入, 谁都不许绕过去自己 new 数据库。
 * 这里也是"无守护进程"架构的唯一粘合点: 没有 HTTP 服务, 没有单例,
 * 一次进程 = 一个 Runtime, 用完 close。
 */
export interface Runtime {
  readonly paths: Paths;
  readonly db: Db;
  readonly dbInfo: DbInfo;
  readonly schemaVersion: number;
  /** 启动时读一次; 改设置后重新 openRuntime 或直接用新值, 不做热更新。 */
  readonly settings: Settings;
  close(): void;
}

export interface RuntimeOptions {
  dataDir?: string;
}

export async function openRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  const paths = resolvePaths(opts.dataDir ? { ...process.env, KURA_DATA_DIR: opts.dataDir } : process.env);
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });

  const { db, info } = await openDb(paths.dbFile);
  try {
    const schemaVersion = migrate(db);
    const runtime: Runtime = {
      paths,
      db,
      dbInfo: info,
      schemaVersion,
      settings: loadSettings(paths),
      close: () => db.close(),
    };
    // 上次被强杀的任务会停在 running, 这里改成 interrupted, 否则界面上永远显示"还在跑"。
    recoverInterrupted(runtime);
    return runtime;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** 一次性进程的标准写法: 保证 close 一定发生, 即使抛错。 */
export async function withRuntime<T>(fn: (rt: Runtime) => Promise<T>, opts: RuntimeOptions = {}): Promise<T> {
  const rt = await openRuntime(opts);
  try {
    return await fn(rt);
  } finally {
    rt.close();
  }
}
