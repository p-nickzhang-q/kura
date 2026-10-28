import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, buildNfo, buildPlan, renderTemplate } from "../src/domain/materialize";
import type { Metadata } from "../src/domain/types";

const metadata: Metadata = {
  key: "ABC-123",
  number: "ABC-123",
  contentType: "censored",
  title: "测试标题",
  plot: "含 <标签> & 引号 \" 的简介",
  release_date: "2024-01-02",
  duration_min: 120,
  studio: "某片商",
  actors: ["演员甲"],
  fieldSources: { title: "fixture" },
};

const library = { id: 1, name: "主库", root: "/media/library", template: "{content_type}/{studio}/{number}" };

describe("renderTemplate", () => {
  test("占位符替换并消毒非法字符", () => {
    expect(renderTemplate("{content_type}/{studio}/{number}", metadata)).toBe("有码/某片商/ABC-123");
    expect(renderTemplate("{title}", { ...metadata, title: "a/b:c*d" })).toBe("a b c d");
  });

  test("空占位符不产生多余分隔", () => {
    expect(renderTemplate("{series}/{number}", { ...metadata, series: undefined })).toBe("ABC-123");
  });
});

describe("buildNfo", () => {
  test("XML 被转义, 且带番号", () => {
    const nfo = buildNfo(metadata);
    expect(nfo).toContain("&lt;标签&gt;");
    expect(nfo).toContain("&amp;");
    expect(nfo).toContain("<num>ABC-123</num>");
    expect(nfo).toContain("<runtime>120</runtime>");
  });
});

describe("buildPlan / applyPlan", () => {
  test("计划默认不动磁盘, apply 才动", async () => {
    const root = await mkdtemp(join(tmpdir(), "kura-org-"));
    const from = join(root, "incoming", "ABC-123.mkv");
    await mkdir(join(root, "incoming"), { recursive: true });
    await writeFile(from, "video", "utf8");

    const plan = buildPlan({ ...library, root }, [
      {
        path: from,
        metadata,
        phase: { cd: null, part: null, hasSubtitle: false, mosaic: null, definition: "1080p" },
      },
    ]);

    expect(plan.summary.move).toBe(1);
    expect(plan.summary.writeNfo).toBe(1);
    const target = join(root, "有码", "某片商", "ABC-123", "ABC-123.mkv");
    expect(plan.entries[0]!.to).toBe(target);

    // 生成计划本身不产生任何文件
    await expect(readFile(target)).rejects.toThrow();

    const results = await applyPlan(plan);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await readFile(target, "utf8")).toBe("video");
    expect(await readFile(join(root, "有码", "某片商", "ABC-123", "ABC-123.nfo"), "utf8")).toContain("<num>ABC-123</num>");
  });

  test("目标逃出库根时 skip, 不移动", async () => {
    const plan = buildPlan({ ...library, root: "/media/library", template: "../../etc" }, [
      {
        path: "/media/library/incoming/ABC-123.mkv",
        metadata,
        phase: { cd: null, part: null, hasSubtitle: false, mosaic: null, definition: null },
      },
    ]);
    expect(plan.summary.skip).toBe(1);
    expect(plan.entries[0]!.reason).toContain("库根之外");
  });

  test("分集文件带 -cd 后缀", async () => {
    const plan = buildPlan(library, [
      {
        path: "/media/library/in/ABC-123-CD2.mkv",
        metadata,
        phase: { cd: 2, part: null, hasSubtitle: false, mosaic: null, definition: null },
      },
    ]);
    expect(plan.entries[0]!.to).toEndWith("ABC-123-cd2.mkv");
  });
});
