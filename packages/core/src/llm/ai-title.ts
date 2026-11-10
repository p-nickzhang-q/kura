import { AppError, EXIT } from "../exit";
import type { HttpClient } from "../net/http";
import type { Runtime } from "../runtime";
import { chatEndpoint, openCache, sourceHash, type LlmConfig, type TranslationCache } from "./translate";

/**
 * AI 别名补搜: 让模型给出"这个名字在 TMDB 里可能叫什么"。
 *
 * 为什么需要它: 正则只能删, 不能造同义词。`60号高地之下` 在 TMDB 里叫「前哨 / The Outpost」,
 * `死神5` 叫「死神来了5」—— 名字抽得再干净也搜不到。这类召回失败占未命中的大头。
 *
 * 三条硬约束(ADR 0010):
 *  - **只产搜索词**: 模型给的东西一律拿去 TMDB 搜, 命中与否由 TMDB + `matchConfidence` 决定。
 *  - **失败不阻断**: 模型超时/没配置就返回空, 调用方退回正则结果。
 *  - **缓存**: 同一个文件名只问一次, 结果落在 `translations.db`(纯缓存, 删了重问)。
 */

export interface AliasGuess {
  /** 原始搜索词(文件名抽出来的片名), 也是缓存键。 */
  name: string;
  /** 模型认为的规范中文名; 没有就 null。 */
  title: string | null;
  /** 外文原名/英文名/港台译名 —— 补搜真正靠的是这些。 */
  aliases: string[];
  year: string | null;
}

export interface AliasEngine {
  /** 批量问模型。失败的批次直接缺席(不抛), 调用方按"没有别名"处理。 */
  suggest(names: string[]): Promise<Map<string, AliasGuess>>;
  /** 最近的失败原因(读一次就清空由调用方决定, 这里只追加)。 */
  errors: string[];
}

/** 一次请求里放多少个名字: 太多会把模型带偏, 太少则请求数暴涨。 */
const BATCH = 12;
/** 每个名字最多信几个别名, 免得一个长尾把搜索次数撑爆。 */
const MAX_ALIASES = 4;
/** 单批超时: 批量补搜是"锦上添花", 不该让整轮找建议卡在模型上。 */
const TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = [
  "你是影视元数据助手。用户会给你一批从下载文件名里抽出来的片名(可能是港台译名、简称或带噪声的写法)。",
  "对每个片名, 给出它在 TMDB 里可能的写法: 规范中文名, 以及外文原名/英文名/常见别名(不超过 4 个)。",
  "只在有把握时给年份(四位数字), 没把握就给 null。",
  '只输出一个 JSON 数组, 每项形如 {"i":0,"title":"前哨","aliases":["The Outpost"],"year":"2019"}。',
  "不要解释, 不要 markdown 代码块。不确定的片名就原样返回 title 并给空 aliases。",
].join("\n");

export function buildAliasPrompt(names: string[]): string {
  return `片名列表(按顺序, i 是下标):\n${names.map((name, index) => `${index}. ${name}`).join("\n")}`;
}

/**
 * 解析模型返回的 JSON。
 *
 * 模型很爱加 ```json 围栏或前后废话, 所以只截第一个 `[` 到最后一个 `]`。
 * 解析不出来就抛 —— 由调用方记错误并退回正则结果。
 */
export function parseAliasResponse(raw: string, names: string[]): AliasGuess[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) throw new AppError("模型没有返回 JSON 数组", EXIT.RETRYABLE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new AppError("模型返回的不是合法 JSON", EXIT.RETRYABLE);
  }
  if (!Array.isArray(parsed)) throw new AppError("模型返回的不是数组", EXIT.RETRYABLE);

  const out: AliasGuess[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as { i?: unknown; title?: unknown; aliases?: unknown; year?: unknown };
    const index = typeof row.i === "number" ? row.i : -1;
    const name = names[index];
    if (!name) continue;
    const title = typeof row.title === "string" ? clean(row.title) : null;
    const aliases = Array.isArray(row.aliases)
      ? [...new Set(row.aliases.filter((value): value is string => typeof value === "string").map(clean).filter(Boolean))]
          .filter((alias) => alias !== title)
          .slice(0, MAX_ALIASES)
      : [];
    const year = typeof row.year === "string" && /^(19|20)\d{2}$/.test(row.year.trim()) ? row.year.trim() : null;
    if (!title && aliases.length === 0) continue;
    out.push({ name, title, aliases, year });
  }
  return out;
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function createAliasEngine(http: HttpClient, config: LlmConfig, cache: TranslationCache): AliasEngine {
  const errors: string[] = [];

  return {
    errors,
    async suggest(names) {
      const out = new Map<string, AliasGuess>();
      const missing: string[] = [];

      for (const name of names) {
        const cached = cache.get(aliasKey(config, name));
        if (!cached) {
          missing.push(name);
          continue;
        }
        try {
          const parsed = parseAliasResponse(cached, [name]);
          const guess = parsed[0];
          if (guess) out.set(name, guess);
        } catch {
          // 缓存坏了就当没有: 重新问一次比报错有用
          missing.push(name);
        }
      }

      for (let offset = 0; offset < missing.length; offset += BATCH) {
        const batch = missing.slice(offset, offset + BATCH);
        try {
          const raw = await withTimeout(
            http.postJson<string>(
              chatEndpoint(config),
              {
                model: config.model,
                temperature: 0,
                messages: [
                  { role: "system", content: SYSTEM_PROMPT },
                  { role: "user", content: buildAliasPrompt(batch) },
                ],
              },
              { headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {} },
              (payload) => {
                const body = payload as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
                if (body.error?.message) throw new AppError(`模型返回错误: ${body.error.message}`, EXIT.RETRYABLE);
                const content = body.choices?.[0]?.message?.content;
                if (typeof content !== "string") throw new AppError("模型响应缺少内容", EXIT.RETRYABLE);
                return content;
              },
            ),
            TIMEOUT_MS,
          );
          for (const guess of parseAliasResponse(raw, batch)) {
            out.set(guess.name, guess);
            cache.set({
              key: aliasKey(config, guess.name),
              field: "alias",
              targetLang: "json",
              promptHash: sourceHash(SYSTEM_PROMPT),
              source: guess.name,
              // 存成和模型返回同一种形状(带下标), 读回来直接走同一个解析函数
              translated: JSON.stringify([{ i: 0, title: guess.title, aliases: guess.aliases, year: guess.year }]),
            });
          }
        } catch (err) {
          if (err instanceof AppError && err.exitCode === EXIT.NEEDS_INPUT) throw err;
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }

      return out;
    },
  };
}

function aliasKey(config: LlmConfig, name: string): string {
  return sourceHash(["alias", config.model, name].join("|"));
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AppError("别名补搜超时", EXIT.RETRYABLE)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 配置齐了才构造; 没配 LLM 时返回 null(补搜是可选步骤)。 */
export async function openAliasEngine(
  rt: Runtime,
  http: HttpClient,
  config: LlmConfig | null,
): Promise<AliasEngine | null> {
  if (!config?.baseUrl || !config.model) return null;
  return createAliasEngine(http, config, await openCache(rt.paths.dataDir));
}
