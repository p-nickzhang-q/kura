import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  /** 进程自管目录: 数据库、日志、缓存。同步读写即可, 不涉及用户媒体目录。 */
  dataDir: string;
  dbFile: string;
  logDir: string;
}

/**
 * 数据目录只解析一次, 由运行时持有; 下游函数通过参数接收, 不读全局环境变量。
 * 这样测试和"多库"场景只需要传不同 Paths。
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const dataDir = env.KURA_DATA_DIR?.trim() || defaultDataDir(env);
  return {
    dataDir,
    dbFile: join(dataDir, "kura.db"),
    logDir: join(dataDir, "logs"),
  };
}

function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "kura");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "kura");
  }
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kura");
}
