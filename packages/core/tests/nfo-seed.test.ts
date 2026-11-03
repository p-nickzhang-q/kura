import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, getItem } from "../src/index";
import { openRuntime } from "../src/runtime";
import { nfoToMetadata, type NfoFields } from "../src/domain/nfo";
import { defaultSources } from "../src/sources";
import { scan } from "../src/tasks/scan";
import { syncNfo } from "../src/tasks/nfo-sync";
import { countPending, listItems, pendingKeys, scrape } from "../src/tasks/scrape";

/**
 * NFO 是种子, 网络来源永远盖掉它。
 *
 * 这三条约束是连锁的, 少一条这个行为就断:
 *  - NFO 填进来的字段要在 `field_sources` 里标成 `nfo`;
 *  - 只有 `nfo` 来源的条目仍然算"待刮削"(否则永远拿不到网络数据);
 *  - 重刮时网络值覆盖 NFO 值, 但网络没给的字段用 NFO 兜底(不能被清空)。
 */

let root: string;
let dataDir: string;
let libraryRoot: string;
let fixturesDir: string;

const NFO = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <title>[ABC-123] 旧库标题</title>
  <plot>旧库简介</plot>
  <studio>旧库片商</studio>
  <actor><name>旧库演员</name></actor>
  <tag>旧库标签</tag>
</movie>
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-seed-"));
  dataDir = join(root, "data");
  libraryRoot = join(root, "media");
  fixturesDir = join(root, "fixtures");
  await mkdir(libraryRoot, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(join(libraryRoot, "ABC-123.mkv"), "video-bytes", "utf8");
  await writeFile(join(libraryRoot, "ABC-123.nfo"), NFO, "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("nfo 只是种子", () => {
  test("NFO 填过的每个字段都记来源, 而不是只记 title/plot", () => {
    const fields: NfoFields = { title: "标题", plot: "简介", studio: "片商", actors: ["甲"], directors: ["乙"], tags: ["丙"] };
    const metadata = nfoToMetadata(fields, "ABC-123");
    for (const key of ["title", "plot", "studio", "actors", "directors", "tags"] as const) {
      expect(metadata.fieldSources[key]).toBe("nfo");
    }
    // 没填的字段不编造来源
    expect(metadata.fieldSources.series).toBeUndefined();
  });

  test("只有 NFO 来源的条目仍算待刮削", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "旧库", root: libraryRoot });
      await scan(rt, { library });
      // nfo 只由 sync 读入(scan 不再读), 这条路径就是换机器/旧库的场景
      syncNfo(rt, { libraryId: library.id, apply: true });

      // 标题已经被 NFO 种进去了 —— 但它一次网络请求都没发过
      expect(getItem(rt, "ABC-123")?.title).toContain("旧库标题");
      expect(pendingKeys(rt, 10).map((key) => key.value)).toEqual(["ABC-123"]);
      expect(countPending(rt)).toBe(1);
      expect(listItems(rt, { state: "unscraped" }).map((item) => item.key)).toEqual(["ABC-123"]);
      expect(listItems(rt, { state: "scraped" })).toEqual([]);
    } finally {
      rt.close();
    }
  });

  test("刮削后网络演员覆盖 NFO 演员", async () => {
    await writeFile(
      join(fixturesDir, "ABC-123.json"),
      JSON.stringify({ title: "网络标题", actors: ["网络演员"], studio: "网络片商" }),
      "utf8",
    );
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "旧库", root: libraryRoot });
      await scan(rt, { library });
      // nfo 只由 sync 读入(scan 不再读), 这条路径就是换机器/旧库的场景
      syncNfo(rt, { libraryId: library.id, apply: true });

      await scrape(rt, {
        key: { value: "ABC-123", number: "ABC-123", contentType: "censored" },
        registry: defaultSources(),
        fixturesDir,
        sources: ["fixture"],
      });

      const item = getItem(rt, "ABC-123")!;
      expect(item.title).toBe("网络标题");
      expect(item.actors).toEqual(["网络演员"]);
      expect(item.studio).toBe("网络片商");
      expect(item.fieldSources.actors).toBe("fixture");
      expect(countPending(rt)).toBe(0);
    } finally {
      rt.close();
    }
  });

  test("网络没给的字段, 用 NFO 的值兜底而不是清空", async () => {
    // fixture 只给标题, 没有演员/标签
    await writeFile(join(fixturesDir, "ABC-123.json"), JSON.stringify({ title: "网络标题" }), "utf8");
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "旧库", root: libraryRoot });
      await scan(rt, { library });
      // nfo 只由 sync 读入(scan 不再读), 这条路径就是换机器/旧库的场景
      syncNfo(rt, { libraryId: library.id, apply: true });

      await scrape(rt, {
        key: { value: "ABC-123", number: "ABC-123", contentType: "censored" },
        registry: defaultSources(),
        fixturesDir,
        sources: ["fixture"],
      });

      const item = getItem(rt, "ABC-123")!;
      expect(item.title).toBe("网络标题");
      expect(item.actors).toEqual(["旧库演员"]);
      expect(item.tags).toEqual(["旧库标签"]);
      expect(item.fieldSources.actors).toBe("nfo");
      expect(item.fieldSources.title).toBe("fixture");
    } finally {
      rt.close();
    }
  });
});
