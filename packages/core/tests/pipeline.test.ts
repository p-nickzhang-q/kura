import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, getItem } from "../src/index";
import { openRuntime } from "../src/runtime";
import { createRegistry, defaultSources, fixtureSource } from "../src/sources";
import { listFiles } from "../src/tasks/scan";
import { countItems, countExhausted, countPending, listItems, MAX_SCRAPE_ATTEMPTS, pendingKeys } from "../src/tasks/scrape";
import { scan } from "../src/tasks/scan";
import { scrape } from "../src/tasks/scrape";
import { organize } from "../src/tasks/organize";

let root: string;
let dataDir: string;
let libraryRoot: string;
let fixturesDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-e2e-"));
  dataDir = join(root, "data");
  libraryRoot = join(root, "media");
  fixturesDir = join(root, "fixtures");
  await mkdir(libraryRoot, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(join(libraryRoot, "ABC-123.mkv"), "video-bytes", "utf8");
  await writeFile(join(libraryRoot, "ignore-me.txt"), "not a video", "utf8");
  await writeFile(
    join(fixturesDir, "ABC-123.json"),
    JSON.stringify({
      title: "离线样本标题",
      plot: "简介",
      release_date: "2024-01-02",
      duration_min: 120,
      studio: "某片商",
      actors: ["甲", "乙"],
      poster_urls: ["https://example.invalid/1.jpg"],
    }),
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scan → scrape → organize", () => {
  test("端到端, 且 organize 默认 dry-run", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "主库", root: libraryRoot });

      // 1. REFRESH: 只读磁盘, 只登记视频文件
      const scanReport = await scan(rt, { library });
      expect(scanReport.counts.added).toBe(1);
      expect(scanReport.counts.unparsed).toBe(0);

      // 幂等: 再扫一次全部 unchanged
      const second = await scan(rt, { library });
      expect(second.counts.unchanged).toBe(1);
      expect(second.counts.added).toBe(0);

      // 2. SCRAPE: 走 fixture 源, 聚合后落库
      const key = { value: "ABC-123", number: "ABC-123", contentType: "censored" as const };
      const scrapeReport = await scrape(rt, {
        key,
        registry: defaultSources(),
        fixturesDir,
        sources: ["fixture"],
      });
      expect(scrapeReport.route).toEqual(["fixture"]);
      expect(scrapeReport.failures).toHaveLength(0);
      expect(scrapeReport.filled).toContain("title");

      const item = getItem(rt, "ABC-123");
      expect(item?.title).toBe("离线样本标题");
      expect(item?.actors).toEqual(["甲", "乙"]);
      expect(item?.fieldSources.title).toBe("fixture");

      // 3. ORGANIZE: 默认只出计划
      const dry = await organize(rt, { library });
      expect(dry.plan.summary.move).toBe(1);
      expect(dry.applied).toBeNull();
      await expect(readFile(join(libraryRoot, "有码", "某片商", "ABC-123", "ABC-123.mkv"))).rejects.toThrow();

      // 4. --apply 才动磁盘
      const applied = await organize(rt, { library, apply: true });
      expect(applied.applied?.every((result) => result.ok)).toBe(true);
      expect(await readFile(join(libraryRoot, "有码", "某片商", "ABC-123", "ABC-123.mkv"), "utf8")).toBe("video-bytes");
      expect(await readFile(join(libraryRoot, "有码", "某片商", "ABC-123", "ABC-123.nfo"), "utf8")).toContain("离线样本标题");

      // 索引必须跟着移动, 否则下次扫描会把同一文件判成 removed + added
      const after = await scan(rt, { library });
      expect(after.counts.removed).toBe(0);
      expect(after.counts.added).toBe(0);
      expect(after.counts.unchanged).toBe(1);
    } finally {
      rt.close();
    }
  });

  test("按演员筛选条目 (空白与全半角不影响命中)", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      await scrape(rt, {
        key: { value: "ABC-123", number: "ABC-123", contentType: "censored" },
        registry: defaultSources({ env: {} }),
        fixturesDir,
        sources: ["fixture"],
      });

      // fixture 里是 ["甲", "乙"]
      expect(listItems(rt, { actor: "甲" }).map((item) => item.key)).toEqual(["ABC-123"]);
      expect(listItems(rt, { actor: " 甲 " }).length).toBe(1);
      expect(countItems(rt, { actor: "乙" })).toBe(1);
      expect(listItems(rt, { actor: "丙" })).toEqual([]);
      expect(countItems(rt)).toBe(1);
    } finally {
      rt.close();
    }
  });

  test("卡住的来源不会拖住整条目 (单条目预算)", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const hanging = {
        id: "hang",
        label: "挂起源",
        status: "ready" as const,
        contentTypes: "all" as const,
        requirements: () => [],
        // 永不 resolve, 但要尊重 signal —— 与真实来源的契约一致
        fetch: (_key: unknown, ctx: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      };

      const started = Date.now();
      const error = await scrape(rt, {
        key: { value: "ABC-123", number: "ABC-123", contentType: "censored" },
        registry: createRegistry([hanging]),
        fixturesDir: null,
        sources: ["hang"],
        itemBudgetMs: 200,
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      rt.close();
    }
  });

  test("认不出番号的文件留在索引里, 可按 unparsed 列出", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "主库", root: libraryRoot });
      await writeFile(join(libraryRoot, "找不到番号的片子.mkv"), "v", "utf8");
      await writeFile(join(libraryRoot, "2024-01-01 家庭录像.mp4"), "v", "utf8");

      const report = await scan(rt, { library });
      expect(report.counts.unparsed).toBe(2);

      const all = listFiles(rt, { libraryId: library.id });
      expect(all).toHaveLength(3);

      const unparsed = listFiles(rt, { libraryId: library.id, unparsedOnly: true });
      expect(unparsed).toHaveLength(2);
      expect(unparsed.every((file) => file.number === null)).toBe(true);
      expect(unparsed.map((file) => file.path).sort()).toEqual(
        [join(libraryRoot, "2024-01-01 家庭录像.mp4"), join(libraryRoot, "找不到番号的片子.mkv")].sort(),
      );
    } finally {
      rt.close();
    }
  });

  test("失败累计到上限后不再进待刮队列, 可显式重试", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const key = { value: "ABC-123", number: "ABC-123", contentType: "censored" as const };
      await scrape(rt, { key, registry: defaultSources({ env: {} }), fixturesDir, sources: ["fixture"] });
      // 换一个查不到的番号
      const missing = { value: "ZZZ-999", number: "ZZZ-999", contentType: "censored" as const };
      rt.db.run("insert or ignore into items (number, content_type) values ('ZZZ-999', 'censored')");

      for (let i = 0; i < MAX_SCRAPE_ATTEMPTS; i++) {
        await scrape(rt, { key: missing, registry: defaultSources({ env: {} }), fixturesDir, sources: ["fixture"] }).catch(
          () => undefined,
        );
      }

      expect(countPending(rt)).toBe(0); // ABC-123 已成功, ZZZ-999 到顶
      expect(countExhausted(rt)).toBe(1);
      expect(pendingKeys(rt).map((key) => key.value)).toEqual([]);
      expect(pendingKeys(rt, 10, { includeFailed: true }).map((key) => key.value)).toEqual(["ZZZ-999"]);
    } finally {
      rt.close();
    }
  });

  test("没有可用来源时给出 NEEDS_INPUT, 而不是静默成功", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const key = { value: "ABC-123", number: "ABC-123", contentType: "censored" as const };
      await expect(
        scrape(rt, { key, registry: defaultSources(), fixturesDir: null, sources: [] }),
      ).rejects.toThrow(/没有可用来源/);
    } finally {
      rt.close();
    }
  });

  test("一个来源失败不影响其它来源 (全程离线)", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const broken = {
        id: "broken",
        label: "坏源",
        status: "ready" as const,
        contentTypes: "all" as const,
        requirements: () => [],
        fetch: async () => {
          throw new Error("boom");
        },
      };
      const registry = createRegistry([broken, fixtureSource]);

      const key = { value: "ABC-123", number: "ABC-123", contentType: "censored" as const };
      const report = await scrape(rt, { key, registry, fixturesDir, sources: ["broken", "fixture"] });

      expect(report.route).toEqual(["broken", "fixture"]);
      expect(report.failures.map((failure) => failure.site)).toEqual(["broken"]);
      expect(report.filled).toContain("title");
    } finally {
      rt.close();
    }
  });
});
