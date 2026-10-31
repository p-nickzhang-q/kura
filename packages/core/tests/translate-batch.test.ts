import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntime, type Runtime } from "../src/runtime";
import { countPendingTranslation, pendingTranslationKeys, translatePending } from "../src/tasks/translate";
import type { Translator } from "../src/llm/translate";

let root: string;
let rt: Runtime;

const SAMPLE = "これは日本語のタイトルです";

async function seed(): Promise<void> {
  for (const number of ["AAA-001", "AAA-002", "AAA-003"]) {
    rt.db.run("insert or replace into items (number, content_type, title) values (?, 'censored', ?)", [
      number,
      `${number} ${SAMPLE}`,
    ]);
  }
}

function working(): Translator {
  return { errors: [], translate: async (_field, text) => `【译】${text.slice(0, 4)}` };
}

function failing(): Translator {
  return {
    errors: [],
    translate: async () => {
      throw new Error("模型返回 401: invalid api key");
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-translate-batch-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
  await seed();
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

describe("批量翻译", () => {
  test("成功翻译后计数下降, 第二次不会再翻同一批", async () => {
    expect(countPendingTranslation(rt)).toBe(3);

    const first = await translatePending(rt, { translator: working(), limit: 2 });
    expect(first.count).toBe(2);
    expect(first.translated).toBe(2);
    expect(first.failed).toBe(0);
    expect(countPendingTranslation(rt)).toBe(1);

    // 关键回归: 再点一次"翻译待处理", 不能从第一条重来
    const second = await translatePending(rt, { translator: working(), limit: 1000 });
    expect(second.reports.map((report) => report.key)).toEqual(["AAA-003"]);
    expect(countPendingTranslation(rt)).toBe(0);
  });

  test("全部失败时 translated 必须是 0 (界面不能报'翻译完成 N 条')", async () => {
    const result = await translatePending(rt, { translator: failing(), limit: 1000 });

    expect(result.count).toBe(3);
    expect(result.translated).toBe(0);
    expect(result.failed).toBe(3);
    // 失败不写库, 条目仍然待翻 —— 与"重来一遍"的现象一致
    expect(countPendingTranslation(rt)).toBe(3);
    expect(result.reports[0]!.error).toContain("401");
  });

  test("模型返回空算无变化, 不算失败", async () => {
    const empty: Translator = { errors: [], translate: async () => null };
    const result = await translatePending(rt, { translator: empty, limit: 1000 });

    expect(result.translated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(3);
  });

  test("取消后保留已完成的统计", async () => {
    const controller = new AbortController();
    const translator: Translator = {
      errors: [],
      translate: async (_field, text) => {
        controller.abort();
        return `【译】${text.slice(0, 4)}`;
      },
    };

    const result = await translatePending(rt, { translator, limit: 1000, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.count).toBe(1);
    expect(result.translated).toBe(1);
    expect(pendingTranslationKeys(rt).length).toBe(2);
  });
});
