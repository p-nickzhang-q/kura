import { AppError, EXIT } from "../exit";

/** 可注入的 fetch。CLI 用 Bun 的; Electron 用 `net.fetch`(跟随系统代理)。 */
export interface FetchInit {
  headers: Record<string, string>;
  signal: AbortSignal;
  proxy?: string;
  method?: string;
  /** 已序列化的 JSON 字符串。 */
  body?: string;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export interface RequestOptions {
  headers?: Record<string, string>;
  method?: string;
  /** 仅 POST 用; 序列化为 JSON。 */
  body?: unknown;
  /** 外部取消信号(用户点停止); 与超时信号合并。 */
  signal?: AbortSignal;
}

export interface HttpClientOptions {
  userAgent?: string;
  timeoutMs?: number;
  /** 失败重试次数(不含首次)。只对网络错误与 5xx 重试。 */
  retries?: number;
  /** 同一客户端的请求最小间隔; 站点级限速后续按 host 细化。 */
  minIntervalMs?: number;
  /** 显式代理, 如 http://127.0.0.1:7890。未设置时走运行时默认(见 createFetch)。 */
  proxy?: string;
  fetchImpl?: FetchLike;
}

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const isBun = Boolean((process.versions as { bun?: string }).bun);

/**
 * 默认 fetch 的差异只在这里处理:
 *  - Bun: fetch 原生支持 `proxy` 选项。
 *  - Node/Electron: 内置 fetch 不认 `proxy`, 需要 undici 的 ProxyAgent;
 *    Electron 主进程应当直接注入 `net.fetch`(它会跟随系统代理), 而不是走这里。
 */
export function createFetch(proxy?: string): FetchLike {
  if (!proxy) {
    return (url, init) => fetch(url, { headers: init.headers, signal: init.signal, method: init.method, body: init.body });
  }

  if (isBun) {
    return (url, init) =>
      fetch(url, {
        headers: init.headers,
        signal: init.signal,
        method: init.method,
        body: init.body,
        proxy,
      } as RequestInit);
  }

  return (url, init) => proxiedNodeFetch(url, init, proxy);
}

let nodeProxyAgent: unknown | null = null;

async function proxiedNodeFetch(url: string, init: FetchInit, proxy: string): Promise<Response> {
  if (!nodeProxyAgent) {
    try {
      // 可选依赖: 没装就给出可行动的提示, 而不是静默直连(那会被地区封锁骗成"没有这条")。
      // 变量说明符: undici 是可选依赖, 不能出现在静态 import 里(会强行要求安装)。
      const spec = "undici";
      const undici = (await import(spec)) as unknown as { ProxyAgent: new (url: string) => unknown };
      nodeProxyAgent = new undici.ProxyAgent(proxy);
    } catch {
      throw new AppError(
        `当前运行时无法使用代理 ${proxy}; 请改用 TUN/系统代理, 或安装 undici`,
        EXIT.NEEDS_INPUT,
        { proxy, runtime: "node" },
      );
    }
  }
  return fetch(url, {
    headers: init.headers,
    signal: init.signal,
    method: init.method,
    body: init.body,
    dispatcher: nodeProxyAgent,
  } as RequestInit);
}

/**
 * 唯一网络出口。来源只拿到它, 不直接调 fetch ——
 * 重试、超时、UA、节流、代理才能集中在一处。
 */
export class HttpClient {
  private readonly options: Required<Pick<HttpClientOptions, "userAgent" | "timeoutMs" | "retries" | "minIntervalMs">> & {
    proxy?: string;
  };
  private readonly fetchImpl: FetchLike;
  /**
   * 按 host 排队。之前只有一个全局队列, 于是"并发请求多个站点"其实是串行:
   * javbus 与 javdb 互相阻塞, 双源耗时变成两者之和。对齐 Amane 的 per-host 漏桶。
   */
  private readonly queues = new Map<string, { chain: Promise<unknown>; lastAt: number }>();

  constructor(options: HttpClientOptions = {}) {
    this.options = {
      userAgent: options.userAgent ?? DEFAULT_UA,
      timeoutMs: options.timeoutMs ?? 15_000,
      retries: options.retries ?? 2,
      minIntervalMs: options.minIntervalMs ?? 1200,
      proxy: options.proxy,
    };
    this.fetchImpl = options.fetchImpl ?? createFetch(options.proxy);
  }

  /** 每个请求可追加头部(如来源需要的 cookie / referer), 不影响其它来源。 */
  async getJson<T>(url: string, init: RequestOptions = {}): Promise<T> {
    const text = await this.getText(url, init);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AppError("响应不是合法 JSON", EXIT.RETRYABLE, { url, body: text.slice(0, 200) });
    }
  }

  async getText(url: string, init: RequestOptions = {}): Promise<string> {
    const response = await this.execute(url, init);
    return response.text();
  }

  /** POST JSON。transform 用来在解析层就做结构校验, 而不是让调用方猜形状。 */
  async postJson<T = unknown>(
    url: string,
    body: unknown,
    init: RequestOptions = {},
    transform?: (payload: unknown) => T,
  ): Promise<T> {
    const response = await this.execute(url, { ...init, method: "POST", body });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AppError("响应不是合法 JSON", EXIT.RETRYABLE, { url, body: text.slice(0, 200) });
    }
    return transform ? transform(payload) : (payload as T);
  }

  /** 二进制通道: 海报/封面下载走这里, 不经过字符串解码。 */
  async getBytes(url: string, init: RequestOptions = {}): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await this.execute(url, init);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return { bytes: buffer, contentType: response.headers.get("content-type") ?? "" };
  }

  /** 重试/4xx/超时的唯一实现; 三个公开方法都只是它的消费者。 */
  private async execute(url: string, init: RequestOptions): Promise<Response> {
    await this.throttle(url);

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          ...(init.method ? { method: init.method } : {}),
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          headers: {
            ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
            "user-agent": this.options.userAgent,
            accept: "application/json, text/html, image/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
            ...(init.headers ?? {}),
          },
          signal: init.signal
            ? AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs), init.signal])
            : AbortSignal.timeout(this.options.timeoutMs),
          proxy: this.options.proxy,
        });

        if (response.status >= 500) {
          lastError = new AppError(`HTTP ${response.status}`, EXIT.RETRYABLE, { url, status: response.status });
          await sleep(300 * (attempt + 1));
          continue;
        }
        if (!response.ok) {
          // 4xx 不重试: 参数或权限问题, 重试只会更慢地失败。
          const body = await response.text().catch(() => "");
          throw new AppError(`HTTP ${response.status}`, EXIT.NOT_FOUND, {
            url,
            status: response.status,
            body: body.slice(0, 400),
          });
        }
        return response;
      } catch (err) {
        if (err instanceof AppError && err.exitCode === EXIT.NOT_FOUND) throw err;
        if (err instanceof AppError && err.exitCode === EXIT.NEEDS_INPUT) throw err;
        lastError = err;

        // 超时是"这条路慢/堵", 立刻重试大概率再等一个完整超时; 只再试一次。
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        if (timedOut && attempt >= 1) break;
        await sleep(300 * (attempt + 1));
      }
    }

    const raw = lastError instanceof Error ? lastError.message : String(lastError);
    throw new AppError(`请求失败: ${raw}${proxyHint(raw)}`, EXIT.RETRYABLE, { url });
  }

  /** 同一个 host 串行 + 最小间隔; 不同 host 之间互不阻塞。 */

  private throttle(url: string): Promise<void> {
    const host = hostOf(url);
    const entry = this.queues.get(host) ?? { chain: Promise.resolve(), lastAt: 0 };

    const run = entry.chain.then(async () => {
      const wait = this.options.minIntervalMs - (Date.now() - entry.lastAt);
      if (wait > 0) await sleep(wait);
      entry.lastAt = Date.now();
    });

    entry.chain = run.catch(() => undefined);
    this.queues.set(host, entry);
    return run;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 代理类网络错误的中文提示。
 *
 * `net::ERR_PROXY_CONNECTION_FAILED` 之类的原文对用户毫无信息量: 它表示
 * "请求被送去了代理, 而代理端口连不上" —— 通常是代理软件没开、端口改了,
 * 或者系统代理注册表里留着一条已经失效的记录。
 */
export function proxyHint(message: string): string {
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ECONNREFUSED\s+(?:\S+:)?(?:7890|7891|7897|1080|10808)/i.test(message)) {
    return " (代理连不上: 检查 Clash 等代理软件是否在运行、端口是否一致; 不用代理就在设置里把代理清空)";
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message)) {
    return " (域名解析失败: 多半是没走代理或被 DNS 污染)";
  }
  if (/ERR_TIMED_OUT|ETIMEDOUT/i.test(message)) {
    return " (连接超时: 站点慢或被墙, 试试开代理)";
  }
  return "";
}
