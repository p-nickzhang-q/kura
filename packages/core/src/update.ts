import type { FetchLike } from "./net/http";

/** GitHub release 的地址与这个仓库绑定 —— 换仓库就换这一行。 */
export const UPDATE_REPO = "p-nickzhang-q/kura";

export interface UpdateCheck {
  /** 本机版本, 原样回显(带不带后缀都照抄)。 */
  current: string;
  /** 线上最新版本, 剥掉 `v` 前缀; 拿不到时为 null。 */
  latest: string | null;
  /** 线上比本地新。相等或本地更新都是 false —— "你比线上新"这种话没有信息量。 */
  newer: boolean;
  /** release 页面, 给人点。 */
  url: string | null;
  publishedAt: string | null;
  /** 失败原因(人话); 成功时为 null。这条链路失败绝不能当成"已是最新"。 */
  error: string | null;
}

/**
 * 比版本号: 只比数字段, 后缀(`-dev` / `-beta.1`)一律忽略。
 *
 * 本地开发壳与打包版共用同一个 VERSION, 而 release tag 带 `v` 前缀 ——
 * 直接字符串比会在 `0.10.0` vs `0.9.9` 上翻车, 所以逐段转数字。
 */
export function compareVersion(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, "")
      .split(/[-+]/)[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));

  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 查一下 GitHub 上有没发新版。
 *
 * **只在用户点「检查更新」时调用** —— 不做启动自动检查, 也不缓存: 少一个后台
 * 外连请求, 也少一个"上次查到什么"的过期状态。失败返回带 error 的对象而不是抛,
 * 因为这条链路的失败(GitHub 在部分地区经常不通)不该变成界面上的一堆红字。
 */
export async function checkUpdate(opts: {
  current: string;
  fetch: FetchLike;
  repo?: string;
  /** 默认 10s: 比普通请求宽松, 但要保证按钮不会一直转。 */
  timeoutMs?: number;
}): Promise<UpdateCheck> {
  const repo = opts.repo ?? UPDATE_REPO;
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const base: UpdateCheck = { current: opts.current, latest: null, newer: false, url: null, publishedAt: null, error: null };

  let response: Response;
  try {
    response = await opts.fetch(url, {
      headers: {
        // 不带 Accept 会拿到 3xx/HTML; 这是 GitHub 的 API 约定, 不是偏好。
        accept: "application/vnd.github+json",
        "user-agent": `kura/${opts.current}`,
      },
      signal,
    });
  } catch (err) {
    return { ...base, error: `连不上 GitHub: ${message(err)}` };
  }

  if (response.status === 404) return { ...base, error: "仓库里还没有发布过 release" };
  if (!response.ok) return { ...base, error: `GitHub 返回 HTTP ${response.status}` };

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return { ...base, error: `GitHub 的回复看不懂: ${message(err)}` };
  }

  const release = body as { tag_name?: unknown; html_url?: unknown; published_at?: unknown };
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const latest = tag.replace(/^v/i, "").trim();
  if (!latest) return { ...base, error: "release 里没有 tag_name" };

  return {
    ...base,
    latest,
    newer: compareVersion(latest, opts.current) > 0,
    url: typeof release.html_url === "string" ? release.html_url : null,
    publishedAt: typeof release.published_at === "string" ? release.published_at : null,
  };
}

function message(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout 抛的是 TimeoutError, 原话是 "The operation was aborted"
    return err.name === "TimeoutError" || err.name === "AbortError" ? "超时" : err.message;
  }
  return String(err);
}
