import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DmmEnv } from "./sources/dmm";
import type { Paths } from "./paths";

/**
 * 用户级设置。存在 `dataDir/config.json`, 不进环境变量 ——
 * 打包后的 GUI 用户没有终端, 不可能去 export 变量。
 *
 * 优先级: 环境变量 > 配置文件。CI 与脚本能临时覆盖, 但普通用户只需要改文件。
 */
export interface Settings {
  dmm: {
    apiId: string;
    affiliateId: string;
  };
  /** HTTP 代理, 如 http://127.0.0.1:7890。空串表示直连/GUI 跟随系统代理。 */
  proxy: string;
}

export const EMPTY_SETTINGS: Settings = { dmm: { apiId: "", affiliateId: "" }, proxy: "" };

export function settingsPath(paths: Paths): string {
  return join(paths.dataDir, "config.json");
}

export function loadSettings(paths: Paths): Settings {
  const file = settingsPath(paths);
  if (!existsSync(file)) return EMPTY_SETTINGS;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;
    return {
      dmm: {
        apiId: String(raw.dmm?.apiId ?? ""),
        affiliateId: String(raw.dmm?.affiliateId ?? ""),
      },
      proxy: String(raw.proxy ?? ""),
    };
  } catch {
    // 坏配置不能挡住启动: 退回空设置, 让调用方按"未配置"处理。
    return EMPTY_SETTINGS;
  }
}

export function saveSettings(
  paths: Paths,
  patch: { dmm?: Partial<Settings["dmm"]>; proxy?: string },
): Settings {
  const current = loadSettings(paths);
  const next: Settings = {
    dmm: { ...current.dmm, ...(patch.dmm ?? {}) },
    proxy: patch.proxy !== undefined ? patch.proxy : current.proxy,
  };

  mkdirSync(paths.dataDir, { recursive: true });
  // 0600: 里面有 API 密钥。
  writeFileSync(settingsPath(paths), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return next;
}

/** 环境变量优先, 便于 CI / 临时覆盖。 */
export function resolveDmmEnv(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
): DmmEnv {
  return {
    apiId: env.KURA_DMM_API_ID?.trim() || settings.dmm.apiId || undefined,
    affiliateId: env.KURA_DMM_AFFILIATE_ID?.trim() || settings.dmm.affiliateId || undefined,
  };
}

/** 只留后四位。`config get` 与 GUI 都拿它, 避免把密钥回显到日志或界面。 */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

export function maskSettings(settings: Settings): Settings {
  return {
    dmm: {
      apiId: maskSecret(settings.dmm.apiId),
      affiliateId: maskSecret(settings.dmm.affiliateId),
    },
    // 代理地址不含密钥, 原样展示便于排障。
    proxy: settings.proxy,
  };
}

/** 代理: 环境变量 > 配置文件。空串 = 不显式指定。 */
export function resolveProxy(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env.KURA_PROXY?.trim() || settings.proxy.trim();
  return value.length > 0 ? value : undefined;
}

export function isDmmConfigured(env: DmmEnv): boolean {
  return Boolean(env.apiId && env.affiliateId);
}
