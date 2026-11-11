import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, getItem, updateItem } from "../src/index";
import { openRuntime } from "../src/runtime";
import { createRegistry, defaultSources, fixtureSource, type Source } from "../src/sources";
import { listFiles } from "../src/tasks/scan";
import { countItems, countExhausted, countPending, listItems, MAX_SCRAPE_ATTEMPTS, pendingKeys } from "../src/tasks/scrape";
import { countPendingTranslation, translatePending } from "../src/tasks/translate";
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

  test("按关键词/片商/导演/标签/媒体库筛选, 且 total 与列表一致", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "主库", root: libraryRoot });
      await scan(rt, { library });
      await scrape(rt, {
        key: { value: "ABC-123", number: "ABC-123", contentType: "censored" },
        registry: defaultSources({ env: {} }),
        fixturesDir,
        sources: ["fixture"],
      });
      updateItem(rt, {
        key: "ABC-123",
        patch: { tags: ["巨乳", "单体作品"], directors: ["某导演"] },
      });

      // 关键词: 标题、番号(大小写不敏感)、演员、标签都算命中
      expect(listItems(rt, { q: "离线样本" }).map((item) => item.key)).toEqual(["ABC-123"]);
      expect(listItems(rt, { q: "abc-123" }).length).toBe(1);
      expect(listItems(rt, { q: "某导演" }).length).toBe(1);
      expect(listItems(rt, { q: "巨乳" }).length).toBe(1);
      expect(listItems(rt, { q: "完全不存在的词" }).length).toBe(0);

      // 单值字段精确匹配 (不区分大小写)
      expect(listItems(rt, { studio: "某片商" }).length).toBe(1);
      expect(listItems(rt, { studio: "某" }).length).toBe(0); // 不是 like

      // 多值字段用 json_each 精确比对: "巨" 不该命中 "巨乳"
      expect(listItems(rt, { tag: "巨乳" }).length).toBe(1);
      expect(listItems(rt, { tag: "巨" }).length).toBe(0);
      expect(listItems(rt, { director: "某导演" }).length).toBe(1);

      // 按库过滤: 这个文件属于主库, 换成不存在的库就查不到
      expect(countItems(rt, { libraryId: library.id })).toBe(1);
      expect(countItems(rt, { libraryId: library.id + 99 })).toBe(0);

      // total 与列表用的是同一套 where
      expect(countItems(rt, { q: "离线样本" })).toBe(listItems(rt, { q: "离线样本" }).length);
    } finally {
      rt.close();
    }
  });

  test("没有简介时才去补 (jav321), 有简介就不多打一次", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      let j321Calls = 0;
      const source = (id: string, fields: Record<string, unknown>): Source => ({
        id,
        label: id,
        status: "ready",
        contentTypes: "all",
        requirements: () => [],
        fetch: async () => {
          if (id === "jav321") j321Calls += 1;
          return fields as never;
        },
      });
      const key = { value: "ABC-123", number: "ABC-123", contentType: "censored" as const };

      // 1. javbus 没有简介 → 补一次 jav321
      const first = await scrape(rt, {
        key,
        registry: createRegistry([
          source("javbus", { title: "标题甲" }),
          source("javdb", { tags: ["单人作品"] }),
          source("jav321", { title: "标题乙", plot: "日语简介", studio: "片商甲" }),
        ]),
        fixturesDir: null,
        dryRun: true,
      });
      expect(j321Calls).toBe(1);
      expect(first.route).toEqual(["javbus", "javdb", "jav321"]);

      // 2. javbus 自己就有简介 → 不该再打 jav321
      const second = await scrape(rt, {
        key,
        registry: createRegistry([
          source("javbus", { title: "标题甲", plot: "已有简介" }),
          source("javdb", {}),
          source("jav321", { plot: "日语简介" }),
        ]),
        fixturesDir: null,
        dryRun: true,
      });
      expect(j321Calls).toBe(1);
      expect(second.route).toEqual(["javbus", "javdb"]);
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

  test("重扫会重新解析番号: 解析器升级后旧库能自愈", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "主库", root: libraryRoot });
      await scan(rt, { library });

      // 模拟"上一版解析器没认出这个文件": 清掉已解析的番号与条目
      rt.db.run("update media_files set number = null where path like '%ABC-123%'");
      rt.db.run("delete from items where number = 'ABC-123'");

      // 文件本身没变 (size/mtime 相同), 但解析结果必须重新算
      await scan(rt, { library });

      const row = rt.db.get<{ number: string | null }>(
        "select number from media_files where path like '%ABC-123%'",
      );
      expect(row?.number).toBe("ABC-123");
      expect(getItem(rt, "ABC-123")).not.toBeNull();
    } finally {
      rt.close();
    }
  });

  test("重新刮削不会把已翻译的条目打回待翻译", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const key = { value: "ABC-123", number: "ABC-123", contentType: "censored" as const };
      const base = { key, registry: defaultSources({ env: {} }), fixturesDir, sources: ["fixture"] };

      await scrape(rt, base);
      const translator = { errors: [] as string[], translate: async (_f: string, t: string) => `译:${t.slice(0, 4)}` };
      await translatePending(rt, { translator: translator as never });

      const before = rt.db.get<{ title: string; title_original: string }>(
        "select title, title_original from items where number = 'ABC-123'",
      );
      expect(countPendingTranslation(rt)).toBe(0);

      // 关键回归: 再刮一次 (同一来源)。以前这里会把 title 换回日文、title_original 清空,
      // 于是已翻译的条目重新出现在待翻译队列里。
      await scrape(rt, base);

      const after = rt.db.get<{ title: string; title_original: string }>(
        "select title, title_original from items where number = 'ABC-123'",
      );
      expect(after?.title).toBe(before?.title);
      expect(after?.title_original).toBe(before?.title_original);
      expect(countPendingTranslation(rt)).toBe(0);
    } finally {
      rt.close();
    }
  });

  test("重新刮削时翻译用的是原文, 不是上次的译文", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const key = { value: "ABC-123", number: "ABC-123", contentType: "censored" as const };
      const base = { key, registry: defaultSources({ env: {} }), fixturesDir, sources: ["fixture"] };

      await scrape(rt, base);
      // fixture 的标题是中文, 不会触发翻译; 换成含假名的标题才有意义
      // 手动改成日文标题并锁定, 否则下一次刮削会被源数据覆盖
      updateItem(rt, { key: "ABC-123", patch: { title: "これは日本語のタイトル" }, pin: ["title"] });

      const seen: string[] = [];
      const translator = {
        errors: [] as string[],
        translate: async (_f: string, text: string) => {
          seen.push(text);
          return `译:${text.slice(0, 4)}`;
        },
      };

      await scrape(rt, { ...base, translator: translator as never });
      await scrape(rt, { ...base, translator: translator as never });

      // 第二次带翻译的刮削必须拿日文原文去翻, 不能把"译:..." 再翻一遍
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((text) => !text.startsWith("译:"))).toBe(true);
      expect(seen).toContain("これは日本語のタイトル");
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

describe("影视身份走番号刮削路径", () => {
  test("content_type 为空时 routeFor 不炸, 给出可读的错", async () => {
    // 影视条目的 content_type 是空串(列 NOT NULL) —— 曾经在这里抛
    // "Cannot read properties of undefined (reading 'map')"
    const { routeFor } = await import("../src/sources/index");
    const registry = new Map() as unknown as Parameters<typeof routeFor>[0];
    expect(routeFor(registry, "" as never)).toEqual([]);
  });
});

describe("番号兜底只看库根以内", () => {
  test("库根上面的盘符/临时目录名再像番号也不算", async () => {
    // 复现过的真实场景: 临时目录名 `kura-scanvideo-wtyk17` 被认成 WTYK-17,
    // 于是整目录的文件都被贴上同一个假番号, 而它们其实一个都认不出来。
    const rt = await openRuntime({ dataDir });
    try {
      // 故意把库根建在一个"像番号"的目录里
      const weirdRoot = join(root, "abc123");
      await mkdir(join(weirdRoot, "某部片"), { recursive: true });
      await writeFile(join(weirdRoot, "某部片", "视频.mp4"), "v", "utf8");
      const library = createLibrary(rt.db, { name: "怪路径", root: weirdRoot });

      const report = await scan(rt, { library });
      expect(report.counts.unparsed).toBe(1);
      expect(rt.db.get("select 1 from media_files where number is not null")).toBeFalsy();
    } finally {
      rt.close();
    }
  });

  test("库根**以内**的目录名带番号仍然能认出来", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const root2 = join(root, "media2");
      await mkdir(join(root2, "ABC-123"), { recursive: true });
      await writeFile(join(root2, "ABC-123", "video.mp4"), "v", "utf8");
      const library = createLibrary(rt.db, { name: "目录带番号", root: root2 });

      await scan(rt, { library });
      const row = rt.db.get<{ number: string }>("select number from media_files limit 1");
      expect(row?.number).toBe("ABC-123");
    } finally {
      rt.close();
    }
  });
});

describe("待刮削: 两个域对 nfo 来源的判断不同", () => {
  test("影视域从 nfo 恢复的条目(有标题有简介)不算待刮", async () => {
    const rt = await openRuntime({ dataDir: await mkdtemp(join(tmpdir(), "kura-pending-")) });
    // 影视域: field_sources 只有 nfo(从盘上的 nfo 恢复来的), 标题和简介都有
    rt.db.run(
      "insert into items (number, content_type, domain, title, plot, field_sources) values ('tmdb:tv:1', '', 'tv', '死神', '简介', '{\"title\":\"nfo\",\"plot\":\"nfo\"}')",
    );
    expect(countPending(rt)).toBe(0);

    // 缺简介 → 仍然待刮
    rt.db.run("update items set plot = null where number = 'tmdb:tv:1'");
    expect(countPending(rt)).toBe(1);

    // 番号制: 只有 nfo 来源 = 还没联网核对过, 仍然待刮(规则不变)
    rt.db.run(
      "insert into items (number, content_type, domain, title, plot, field_sources) values ('ABP-123', 'censored', 'av', '某片', '简介', '{\"title\":\"nfo\",\"plot\":\"nfo\"}')",
    );
    expect(countPending(rt)).toBe(2);
    await rt.close();
  });
});
