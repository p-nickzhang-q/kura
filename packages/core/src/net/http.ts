import { AppError, EXIT } from "../exit";

/** 可注入的 fetch。CLI 用 Bun 的; Electron 用 `net.fetch`(跟随系统代理)。 */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; proxy?: string },
) => Promise<Response>;

export interface RequestOptions {
  headers?: Record<string, string>;
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
  if (!proxy) return (url, init) => fetch(url, { headers: init.headers, signal: init.signal });

  if (isBun) {
    return (url, init) => fetch(url, { headers: init.headers, signal: init.signal, proxy } as RequestInit);
  }

  return (url, init) => proxiedNodeFetch(url, init, proxy);
}

let nodeProxyAgent: unknown | null = null;

async function proxiedNodeFetch(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
  proxy: string,
): Promise<Response> {
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
  return fetch(url, { headers: init.headers, signal: init.signal, dispatcher: nodeProxyAgent } as RequestInit);
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
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

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

  /** 二进制通道: 海报/封面下载走这里, 不经过字符串解码。 */
  async getBytes(url: string, init: RequestOptions = {}): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await this.execute(url, init);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return { bytes: buffer, contentType: response.headers.get("content-type") ?? "" };
  }

  /** 重试/4xx/超时的唯一实现; 三个公开方法都只是它的消费者。 */
  private async execute(url: string, init: RequestOptions): Promise<Response> {
    await this.throttle();

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          headers: {
            "user-agent": this.options.userAgent,
            accept: "application/json, text/html, image/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
            ...(init.headers ?? {}),
          },
          signal: AbortSignal.timeout(this.options.timeoutMs),
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
        await sleep(300 * (attempt + 1));
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new AppError(`请求失败: ${message}`, EXIT.RETRYABLE, { url });
  }

  /** 串行 + 最小间隔。并发刮削时由任务层控制并发度。 */
  private throttle(): Promise<void> {
    const run = this.queue.then(async () => {
      const wait = this.options.minIntervalMs - (Date.now() - this.lastAt);
      if (wait > 0) await sleep(wait);
      this.lastAt = Date.now();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
