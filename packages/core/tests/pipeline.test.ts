import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, getItem } from "../src/index";
import { openRuntime } from "../src/runtime";
import { defaultSources } from "../src/sources";
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

  test("未实现的来源被跳过并如实报告", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const key = { value: "ABC-123", number: "ABC-123", contentType: "censored" as const };
      const report = await scrape(rt, {
        key,
        registry: defaultSources(),
        fixturesDir,
        sources: ["javdb", "fixture"],
      });
      expect(report.route).toEqual(["fixture"]);
      expect(report.skipped).toEqual(["javdb"]);
      expect(report.filled).toContain("title");
    } finally {
      rt.close();
    }
  });
});
