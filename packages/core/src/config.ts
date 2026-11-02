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
  /**
   * HTTP 代理。三种取值:
   *  - `""`   跟随系统代理(GUI) / 直连(CLI)
   *  - `auto` 运行时探测常见 Clash 端口与 WSL 网关, 不写死地址
   *  - URL    显式指定, 如 http://127.0.0.1:7890
   */
  proxy: string;
  /** OpenAI 兼容端点。空值 = 未配置, 翻译不可用。 */
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  /** 刮削后自动翻译。默认关: 翻译要花 token, 且不是所有人都要中文。 */
  translate: boolean;
  /**
   * 下载的图片是否同时存一份到视频旁边 (`片名-poster.jpg` / `片名-thumb.jpg`)。
   * 默认开: 图只躺在进程的数据目录里, 换个播放器就看不见了。
   */
  saveImages: boolean;
}

export const EMPTY_SETTINGS: Settings = {
  dmm: { apiId: "", affiliateId: "" },
  proxy: "",
  llm: { baseUrl: "", apiKey: "", model: "" },
  translate: false,
  saveImages: true,
};

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
      llm: {
        baseUrl: String(raw.llm?.baseUrl ?? ""),
        apiKey: String(raw.llm?.apiKey ?? ""),
        model: String(raw.llm?.model ?? ""),
      },
      translate: Boolean(raw.translate),
      // 旧配置文件里没有这个字段, 默认开。
      saveImages: raw.saveImages === undefined ? true : Boolean(raw.saveImages),
    };
  } catch {
    // 坏配置不能挡住启动: 退回空设置, 让调用方按"未配置"处理。
    return EMPTY_SETTINGS;
  }
}

export function saveSettings(
  paths: Paths,
  patch: {
    dmm?: Partial<Settings["dmm"]>;
    proxy?: string;
    llm?: Partial<Settings["llm"]>;
    translate?: boolean;
    saveImages?: boolean;
  },
): Settings {
  const current = loadSettings(paths);
  const next: Settings = {
    dmm: { ...current.dmm, ...(patch.dmm ?? {}) },
    proxy: patch.proxy !== undefined ? patch.proxy : current.proxy,
    llm: { ...current.llm, ...(patch.llm ?? {}) },
    translate: patch.translate !== undefined ? patch.translate : current.translate,
    saveImages: patch.saveImages !== undefined ? patch.saveImages : (current.saveImages ?? true),
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
    llm: {
      baseUrl: settings.llm?.baseUrl ?? "",
      apiKey: maskSecret(settings.llm?.apiKey ?? ""),
      model: settings.llm?.model ?? "",
    },
    translate: Boolean(settings.translate),
    saveImages: settings.saveImages ?? true,
    // 代理地址不含密钥, 原样展示便于排障。
    proxy: settings.proxy,
  };
}

/** 代理: 环境变量 > 配置文件。空串 = 不显式指定; `auto` = 运行时探测。 */
export function resolveProxy(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env.KURA_PROXY?.trim() || settings.proxy.trim();
  if (value.length === 0) return undefined;
  if (value === AUTO_PROXY) return value;
  return normalizeProxyUrl(value);
}

/**
 * 把各种手写代理地址收成 fetch 认的形式。
 *
 * 人写代理最常见的是 `127.0.0.1:7890` —— 没有 scheme。原样丢给 `fetch({proxy})`
 * 会直接报 URL 非法, 丢给 Chromium 的 proxyRules 则会被当成别的语法;
 * 而 `socks` 这种简写各处的支持又不一样, 统一成 socks5://。
 */
export function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (/^socks5h?:\/\//i.test(trimmed)) return trimmed.replace(/^socks5h?:/i, "socks5:");
  if (/^socks:\/\//i.test(trimmed)) return trimmed.replace(/^socks:/i, "socks5:");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export const AUTO_PROXY = "auto";

/** 常见本地代理端口: Clash / Clash Verge / v2ray / Shadowsocks。 */
const PROXY_PORTS = [7890, 7891, 7897, 1080, 10808, 20171];

/**
 * 探测候选: 本机 + WSL 网关。
 * WSL2 里 Clash 跑在 Windows 上, `127.0.0.1` 指不到它, 必须用网关地址;
 * 而网关在每次重启后会变, 所以只能运行时算, 不能写进配置。
 */
export function proxyCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const hosts = new Set<string>(["127.0.0.1"]);
  if (platform === "linux") {
    const gateway = wslGateway();
    if (gateway) hosts.add(gateway);
  }
  return [...hosts].flatMap((host) => PROXY_PORTS.map((port) => `http://${host}:${port}`));
}

function wslGateway(): string | null {
  try {
    const route = readFileSync("/proc/net/route", "utf8");
    for (const line of route.split("\n").slice(1)) {
      const [iface, destination, gateway] = line.split("\t");
      if (!iface || destination !== "00000000" || !gateway) continue;
      // /proc/net/route 里是小端十六进制
      const bytes = gateway.match(/../g)?.reverse().join("") ?? "";
      const value = Number.parseInt(bytes, 16);
      if (!Number.isFinite(value)) continue;
      return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
    }
  } catch {
    // 非 Linux 或容器里没有 /proc/net/route: 只探测本机。
  }
  return null;
}

export interface ProbeOptions {
  /** 注入探测实现, 便于测试。返回 true 表示该代理可用。 */
  probe?: (candidate: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  /** 探测总预算; 逐个试满 12 个端口最坏要 30s, CLI 启动扛不住。 */
  budgetMs?: number;
}

let autoCache: string | undefined | null = null;

/**
 * 把配置里的 proxy 解析成真实地址。
 * `auto` 只在 Bun/CLI 侧探测 —— Electron 侧走系统代理, 不需要这一步。
 */
export async function resolveProxyUrl(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
  options: ProbeOptions = {},
): Promise<string | undefined> {
  const value = resolveProxy(settings, env);
  if (!value) return undefined;
  if (value !== AUTO_PROXY) return value;

  if (autoCache !== null) return autoCache;

  const probe = options.probe ?? defaultProxyProbe;
  // 串行探测并短路: 并发打 12 个代理端口既慢又可能把首个 TLS 握手挤到超时。
  const deadline = Date.now() + (options.budgetMs ?? 6000);
  for (const candidate of proxyCandidates(options.platform)) {
    if (Date.now() > deadline) break;
    if (await probe(candidate)) {
      autoCache = candidate;
      return autoCache;
    }
  }
  autoCache = undefined;
  return autoCache;
}

/** 通过候选代理请求一个 204 端点。必须真的走代理, 否则探测没有意义。 */
async function defaultProxyProbe(candidate: string): Promise<boolean> {
  if (!isBun()) return false;
  try {
    const response = await fetch("https://www.gstatic.com/generate_204", {
      proxy: candidate,
      signal: AbortSignal.timeout(2500),
    } as RequestInit);
    return response.status === 204 || response.ok;
  } catch {
    return false;
  }
}

function isBun(): boolean {
  return Boolean((process.versions as { bun?: string }).bun);
}

/** 测试用: 清掉进程内缓存。 */
export function resetProxyCache(): void {
  autoCache = null;
}

export function isDmmConfigured(env: DmmEnv): boolean {
  return Boolean(env.apiId && env.affiliateId);
}

/** 翻译配置: 环境变量 > 配置文件。三者齐了才算可用。 */
export function resolveLlm(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
): { baseUrl: string; apiKey: string; model: string } | null {
  const baseUrl = env.KURA_LLM_BASE_URL?.trim() || settings.llm.baseUrl.trim();
  const apiKey = env.KURA_LLM_API_KEY?.trim() || settings.llm.apiKey.trim();
  const model = env.KURA_LLM_MODEL?.trim() || settings.llm.model.trim();
  return baseUrl && model ? { baseUrl, apiKey, model } : null;
}

export function translateEnabled(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.KURA_TRANSLATE?.trim();
  if (flag !== undefined && flag !== "") return flag === "1" || flag.toLowerCase() === "true";
  return settings.translate;
}
