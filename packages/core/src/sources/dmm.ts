import { AppError, EXIT } from "../exit";
import type { HttpClient } from "../net/http";
import type { ItemKey, RawFields } from "../domain/types";
import type { Source } from "./types";

/**
 * DMM (FANZA) 官方 Web Service API。
 *
 * 为什么第一个真源选它: 网页版对非日本 IP 直接 301 到 not-available-in-your-region,
 * 而 API 返回结构化 JSON, 没有 Cloudflare、没有 HTML 选择器要维护。
 * 代价是需要 affiliate 凭据 —— 缺凭据时抛 NEEDS_INPUT(退出码 4), 而不是静默失败。
 */

export interface DmmEnv {
  apiId?: string;
  affiliateId?: string;
}

export interface DmmName {
  id?: string;
  name?: string;
}

export interface DmmItem {
  content_id?: string;
  product_id?: string;
  title?: string;
  volume?: string | number;
  date?: string;
  URL?: string;
  imageURL?: { large?: string; list?: string; small?: string };
  iteminfo?: {
    genre?: DmmName[];
    maker?: DmmName[];
    label?: DmmName[];
    series?: DmmName[];
    actress?: DmmName[];
    director?: DmmName[];
  };
}

export interface DmmResponse {
  result?: {
    status?: number;
    message?: string;
    items?: DmmItem[];
  };
}

const ENDPOINT = "https://api.dmm.com/affiliate/v3/ItemList";

export function createDmmSource(http: HttpClient, env: DmmEnv): Source {
  const missing = (): string[] => [
    ...(env.apiId ? [] : ["KURA_DMM_API_ID"]),
    ...(env.affiliateId ? [] : ["KURA_DMM_AFFILIATE_ID"]),
  ];

  return {
    id: "dmm",
    label: "DMM (FANZA API)",
    status: "ready",
    contentTypes: ["censored", "anime"],
    requirements: missing,
    async fetch(key) {
      const absent = missing();
      if (absent.length > 0) {
        throw new AppError(`DMM 缺少凭据: ${absent.join(", ")}`, EXIT.NEEDS_INPUT, {
          source: "dmm",
          missing: absent,
          hint: "在 https://affiliate.dmm.com/api/ 申请 API ID 与 affiliate ID",
        });
      }

      const url = buildUrl(env, key.value);
      const payload = await http.getJson<DmmResponse>(url).catch((err: unknown) => {
        // DMM 对无效凭据返回 400 + {"errors":{"api_id":"Invalid Request Error"}},
        // 若不翻译, 用户会看到"来源里没有这个番号" —— 完全误导。
        const details = err instanceof AppError ? (err.details ?? {}) : {};
        const body = typeof details.body === "string" ? details.body : "";
        if (details.status === 400 && /api_id|affiliate_id/.test(body)) {
          throw new AppError("DMM 拒绝了凭据, 请检查 API ID 与 Affiliate ID", EXIT.NEEDS_INPUT, {
            source: "dmm",
            status: 400,
            body,
          });
        }
        throw err;
      });

      const status = payload.result?.status ?? 200;
      if (status === 401 || status === 403) {
        throw new AppError("DMM 拒绝了凭据", EXIT.NEEDS_INPUT, { source: "dmm", status });
      }
      if (status !== 200) {
        throw new AppError(`DMM 返回 ${status}: ${payload.result?.message ?? ""}`, EXIT.RETRYABLE, { source: "dmm", status });
      }

      const item = matchDmmItem(payload.result?.items ?? [], key);
      return item ? toRawFields(item) : null;
    },
  };
}

export function buildUrl(env: DmmEnv, keyword: string): string {
  const params = new URLSearchParams({
    api_id: env.apiId ?? "",
    affiliate_id: env.affiliateId ?? "",
    site: "FANZA",
    service: "digital",
    floor: "videoa",
    hits: "20",
    sort: "rank",
    keyword,
  });
  return `${ENDPOINT}?${params.toString()}`;
}

/** `SSIS-001` → `SSIS001`; 只留字母数字, 让 cid / product_id 可比较。 */
export function normalizeCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * DMM 的 content_id 可能带厂商标前缀(`77ssis001`), 因此先找完全相等, 再找后缀相等。
 * 不做模糊匹配 —— 匹配错了比没匹配更糟。
 */
export function matchDmmItem(items: DmmItem[], key: ItemKey): DmmItem | null {
  const target = normalizeCode(key.value);
  if (!target) return null;

  const exact = items.find((item) =>
    [item.content_id, item.product_id].some((code) => code && normalizeCode(code) === target),
  );
  if (exact) return exact;

  return (
    items.find((item) =>
      [item.content_id, item.product_id].some((code) => code && normalizeCode(code).endsWith(target)),
    ) ?? null
  );
}

export function toRawFields(item: DmmItem): RawFields {
  const info = item.iteminfo ?? {};
  const names = (list?: DmmName[]): string[] =>
    (list ?? []).map((entry) => entry.name?.trim() ?? "").filter((name) => name.length > 0);

  const fields: RawFields = {
    title: item.title?.trim() || undefined,
    release_date: item.date?.slice(0, 10) || undefined,
    duration_min: toMinutes(item.volume),
    studio: names(info.maker)[0],
    label: names(info.label)[0],
    series: names(info.series)[0],
    actors: names(info.actress),
    directors: names(info.director),
    tags: names(info.genre),
    poster_urls: pick(item.imageURL?.large),
    cover_urls: pick(item.imageURL?.list),
    thumb_urls: pick(item.imageURL?.small),
  };

  // 空数组会让"列表字段取第一个非空列表"误判为有值, 统一删掉。
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value) && value.length === 0) delete (fields as Record<string, unknown>)[key];
    if (value === undefined) delete (fields as Record<string, unknown>)[key];
  }
  return fields;
}

function toMinutes(volume: string | number | undefined): number | undefined {
  if (volume === undefined) return undefined;
  const minutes = Number(volume);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
}

function pick(url: string | undefined): string[] | undefined {
  return url ? [url] : undefined;
}
