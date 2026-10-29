import { createHash } from "node:crypto";
import { AppError, EXIT } from "../exit";
import type { HttpClient } from "../net/http";
import type { Runtime } from "../runtime";
import { openDb, type Db } from "../db/driver";
import { join } from "node:path";

/**
 * 翻译: OpenAI 兼容端点 + 独立缓存库。
 *
 * 决策见 ADR 0004:
 *  - 覆盖 `title` / `plot` 的**显示值**, 原文另存 `title_original` / `plot_original`;
 *  - 只翻含假名的日文, 中文/英文原样不动;
 *  - 演员名不翻(人名音译没有唯一答案, 且会污染目录名);
 *  - 缓存独立成 `translations.db`, 纯缓存, 可随时删。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 目标语言, 默认简体中文。 */
  targetLang?: string;
}

export interface TranslateField {
  field: string;
  /** 给模型的字段说明, 与 Amane 的 field_prompts 同构。 */
  instruction: string;
}

const FIELD_INSTRUCTIONS: Record<string, string> = {
  title: "这是影片标题。保留番号、数字、英文缩写与符号, 只把日文部分译成简体中文, 不要添加任何解释。",
  plot: "这是影片简介。译成通顺的简体中文, 保留专有名词, 不要添加任何解释。",
};

/** 含平假名/片假名才判为日文; 纯汉字(如标签/人名)不在此列。 */
export function hasKana(text: string): boolean {
  return /[\u3040-\u30ff]/.test(text);
}

export function needsTranslation(text: string | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return hasKana(trimmed);
}

export function sourceHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildSystemPrompt(field: string, targetLang = "简体中文"): string {
  const instruction = FIELD_INSTRUCTIONS[field] ?? "译成简体中文, 不要添加任何解释。";
  return [
    `你是专业的影视元数据翻译。把用户给出的日文文本翻译成${targetLang}。`,
    instruction,
    "只输出译文本身, 不要引号、不要前后缀、不要解释。",
  ].join("\n");
}

export class TranslationCache {
  private readonly db: Db;

  private constructor(db: Db) {
    this.db = db;
    db.exec(`
      create table if not exists translations (
        key        text primary key,
        field      text not null,
        target_lang text not null,
        prompt_hash text not null,
        source     text not null,
        translated text not null,
        created_at integer not null default (unixepoch())
      );
    `);
  }

  static async open(dataDir: string): Promise<TranslationCache> {
    const { db } = await openDb(join(dataDir, "translations.db"));
    return new TranslationCache(db);
  }

  get(key: string): string | null {
    const row = this.db.get<{ translated: string }>("select translated from translations where key = ?", [key]);
    return row?.translated ?? null;
  }

  set(entry: { key: string; field: string; targetLang: string; promptHash: string; source: string; translated: string }): void {
    this.db.run(
      `insert into translations (key, field, target_lang, prompt_hash, source, translated)
       values (?, ?, ?, ?, ?, ?)
       on conflict(key) do update set translated = excluded.translated, created_at = unixepoch()`,
      [entry.key, entry.field, entry.targetLang, entry.promptHash, entry.source, entry.translated],
    );
  }
}

export interface Translator {
  translate(field: string, text: string): Promise<string | null>;
}

/**
 * 同一个键的并发调用只发一次请求(Amane 的 coalescer 同款)。
 * 失败返回 null, 调用方保留原值 —— 翻译永远不该阻断刮削。
 */
export function createTranslator(http: HttpClient, config: LlmConfig, cache: TranslationCache): Translator {
  const inflight = new Map<string, Promise<string | null>>();

  return {
    async translate(field, text) {
      if (!needsTranslation(text)) return null;

      const targetLang = config.targetLang ?? "简体中文";
      const prompt = buildSystemPrompt(field, targetLang);
      const key = createHash("sha256")
        .update([sourceHash(text), targetLang, field, sourceHash(prompt)].join("|"))
        .digest("hex");

      const cached = cache.get(key);
      if (cached) return cached;

      const existing = inflight.get(key);
      if (existing) return existing;

      const task = (async () => {
        try {
          const translated = await http.postJson<string>(chatEndpoint(config), {
            model: config.model,
            temperature: 0,
            messages: [
              { role: "system", content: prompt },
              { role: "user", content: text },
            ],
          }, {
            headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
          }, (payload) => extractContent(payload));

          const cleaned = translated.trim();
          if (!cleaned) return null;
          cache.set({ key, field, targetLang, promptHash: sourceHash(prompt), source: text, translated: cleaned });
          return cleaned;
        } catch (err) {
          if (err instanceof AppError && err.exitCode === EXIT.NEEDS_INPUT) throw err;
          return null;
        } finally {
          inflight.delete(key);
        }
      })();

      inflight.set(key, task);
      return task;
    },
  };
}

export function chatEndpoint(config: LlmConfig): string {
  const base = config.baseUrl.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

interface ChatPayload {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

function extractContent(payload: unknown): string {
  const body = payload as ChatPayload;
  if (body.error?.message) throw new AppError(`模型返回错误: ${body.error.message}`, EXIT.RETRYABLE);
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new AppError("模型响应缺少 choices[0].message.content", EXIT.RETRYABLE);
  return content;
}

/** 每个 dataDir 只开一次缓存库: GUI 是常驻进程, 每次刮削都开连接会泄漏。 */
const cacheByDir = new Map<string, Promise<TranslationCache>>();

function cacheFor(dataDir: string): Promise<TranslationCache> {
  const existing = cacheByDir.get(dataDir);
  if (existing) return existing;
  const opened = TranslationCache.open(dataDir);
  cacheByDir.set(dataDir, opened);
  return opened;
}

/** 供 scrape / translate 复用: 配置齐了才构造, 否则返回 null(翻译是可选步骤)。 */
export async function openTranslator(
  rt: Runtime,
  http: HttpClient,
  config: LlmConfig | null,
): Promise<Translator | null> {
  if (!config?.baseUrl || !config.model) return null;
  return createTranslator(http, config, await cacheFor(rt.paths.dataDir));
}
