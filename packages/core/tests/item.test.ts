import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, getItem, parseFieldList, parseListValue, updateItem } from "../src/index";
import { openRuntime } from "../src/runtime";
import { defaultSources } from "../src/sources";
import { scrape } from "../src/tasks/scrape";

let root: string;
let dataDir: string;
let fixturesDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-lock-"));
  dataDir = join(root, "data");
  fixturesDir = join(root, "fixtures");
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(
    join(fixturesDir, "ABC-123.json"),
    JSON.stringify({ title: "来源标题", plot: "来源简介", actors: ["甲"] }),
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const key = { value: "ABC-123", number: "ABC-123", contentType: "censored" as const };

describe("updateItem", () => {
  test("手改字段默认锁定, 重新刮削不覆盖", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      createLibrary(rt.db, { name: "主库", root: join(root, "media") });
      await scrape(rt, { key, registry: defaultSources(), fixturesDir, sources: ["fixture"] });
      expect(getItem(rt, "ABC-123")?.title).toBe("来源标题");

      const updated = updateItem(rt, { key: "ABC-123", patch: { title: "我改的标题" }, pin: ["title"] });
      expect(updated.title).toBe("我改的标题");
      expect(updated.pinned).toEqual(["title"]);

      // 重新刮削: title 保持用户值, plot 仍然被来源刷新
      await writeFile(
        join(fixturesDir, "ABC-123.json"),
        JSON.stringify({ title: "新来源标题", plot: "新简介" }),
        "utf8",
      );
      await scrape(rt, { key, registry: defaultSources(), fixturesDir, sources: ["fixture"] });

      const after = getItem(rt, "ABC-123");
      expect(after?.title).toBe("我改的标题");
      expect(after?.plot).toBe("新简介");
      expect(after?.pinned).toEqual(["title"]);
    } finally {
      rt.close();
    }
  });

  test("解锁后重新刮削会覆盖", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      await scrape(rt, { key, registry: defaultSources(), fixturesDir, sources: ["fixture"] });
      updateItem(rt, { key: "ABC-123", patch: { title: "临时" }, pin: ["title"] });
      updateItem(rt, { key: "ABC-123", unpin: ["title"] });

      await scrape(rt, { key, registry: defaultSources(), fixturesDir, sources: ["fixture"] });
      expect(getItem(rt, "ABC-123")?.title).toBe("来源标题");
    } finally {
      rt.close();
    }
  });

  test("不存在的条目给 NOT_FOUND", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      expect(() => updateItem(rt, { key: "NOPE-999", patch: { title: "x" } })).toThrow(/条目不存在/);
    } finally {
      rt.close();
    }
  });
});

describe("参数解析", () => {
  test("字段列表拒绝未知字段", () => {
    expect(parseFieldList("title,plot")).toEqual(["title", "plot"]);
    expect(() => parseFieldList("title,drop table")).toThrow(/未知字段/);
  });

  test("逗号分隔值去空", () => {
    expect(parseListValue("甲, 乙 ,, 丙")).toEqual(["甲", "乙", "丙"]);
  });
});
