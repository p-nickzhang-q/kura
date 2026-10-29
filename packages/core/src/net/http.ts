import { AppError, EXIT } from "../exit";

export interface HttpClientOptions {
  userAgent?: string;
  timeoutMs?: number;
  /** 失败重试次数(不含首次)。只对网络错误与 5xx 重试。 */
  retries?: number;
  /** 同一客户端的请求最小间隔, 简单的节流; 站点级限速在后续按 host 细化。 */
  minIntervalMs?: number;
}

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 唯一的网络出口。来源只拿到它, 不直接调 fetch —— 重试、超时、UA、节流
 * 才能集中在一处, 而不是每个爬虫各写一遍。
 */
export class HttpClient {
  private readonly options: Required<HttpClientOptions>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(options: HttpClientOptions = {}) {
    this.options = {
      userAgent: options.userAgent ?? DEFAULT_UA,
      timeoutMs: options.timeoutMs ?? 15_000,
      retries: options.retries ?? 2,
      minIntervalMs: options.minIntervalMs ?? 1200,
    };
  }

  async getJson<T>(url: string): Promise<T> {
    const text = await this.getText(url);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AppError("响应不是合法 JSON", EXIT.RETRYABLE, { url, body: text.slice(0, 200) });
    }
  }

  async getText(url: string): Promise<string> {
    await this.throttle();

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { "user-agent": this.options.userAgent, accept: "application/json, text/html;q=0.9" },
          signal: AbortSignal.timeout(this.options.timeoutMs),
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
        return await response.text();
      } catch (err) {
        if (err instanceof AppError && err.exitCode === EXIT.NOT_FOUND) throw err;
        lastError = err;
        await sleep(300 * (attempt + 1));
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new AppError(`请求失败: ${message}`, EXIT.RETRYABLE, { url });
  }

  /** 串行 + 最小间隔。并发刮削时由任务层控制并发度, 这里只保证不把站点打穿。 */
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
