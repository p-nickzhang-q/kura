import { describe, expect, test } from "bun:test";
import {
  DIMENSIONS,
  dimensionTemplate,
  findDimension,
  templatePlaceholders,
  unknownPlaceholders,
} from "../src/domain/dimensions";
import { buildPlan, renderTemplate } from "../src/domain/materialize";
import type { Metadata } from "../src/domain/types";

const metadata: Metadata = {
  key: "ABC-123",
  number: "ABC-123",
  contentType: "censored",
  title: "示例标题",
  actors: ["演员甲", "演员乙"],
  studio: "片商A",
  series: "系列A",
  release_date: "2024-01-02",
  fieldSources: {},
};

const phase = { cd: null, part: null, hasSubtitle: false, mosaic: null, definition: null };

describe("维度预设", () => {
  test("每个维度都展开成模板, 且第一层就是该维度", () => {
    for (const dimension of DIMENSIONS) {
      expect(dimension.template.startsWith(`{${dimension.id === "content_type" ? "content_type" : dimension.id}}`)).toBe(
        true,
      );
      expect(dimension.template).toContain("{number}");
    }
  });

  test("按演员 = 第一演员 + 番号 (不是全部演员)", () => {
    expect(dimensionTemplate("actor")).toBe("{actor}/{number}");
    expect(renderTemplate(dimensionTemplate("actor")!, metadata)).toBe("演员甲/ABC-123");
  });

  test("按演员(全部) 与 按演员 是两个独立预设", () => {
    expect(dimensionTemplate("actors")).toBe("{actors}/{number}");
    expect(renderTemplate(dimensionTemplate("actors")!, metadata)).toBe("演员甲、演员乙/ABC-123");
    expect(renderTemplate(dimensionTemplate("actor")!, metadata)).toBe("演员甲/ABC-123");
  });

  test("按系列 / 按类型 / 按年份", () => {
    expect(renderTemplate(dimensionTemplate("series")!, metadata)).toBe("系列A/ABC-123");
    expect(renderTemplate(dimensionTemplate("content_type")!, metadata)).toBe("有码/ABC-123");
    expect(renderTemplate(dimensionTemplate("year")!, metadata)).toBe("2024/ABC-123");
  });

  test("未知维度名返回 null, 不猜", () => {
    expect(dimensionTemplate("tag")).toBeNull();
    expect(findDimension("nope")).toBeUndefined();
  });

  test("占位符清单与未知占位符检测", () => {
    expect(templatePlaceholders("{actor}/{number}")).toEqual(["actor", "number"]);
    expect(unknownPlaceholders("{actor}/{tag}")).toEqual(["tag"]);
    expect(unknownPlaceholders("{actors}")).toEqual([]);
  });
});

describe("{actor} 与 {actors}", () => {
  test("actor 取第一, actors 全拼并用顿号分隔", () => {
    expect(renderTemplate("{actor}", metadata)).toBe("演员甲");
    expect(renderTemplate("{actors}", metadata)).toBe("演员甲、演员乙");
  });

  test("没有演员时两者都渲染为空, 不产生空目录段", () => {
    const bare = { ...metadata, actors: undefined };
    expect(renderTemplate("{actor}/{number}", bare)).toBe("ABC-123");
    expect(renderTemplate("{actors}/{number}", bare)).toBe("ABC-123");
  });
});

describe("目标占用检测", () => {
  const library = { id: 1, name: "主库", root: "/tmp/kura-dim", template: "{actor}/{number}" };

  test("目标已被别的文件占用时 skip, 绝不覆盖", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = await mkdtemp(join(tmpdir(), "kura-conflict-"));
    const source = join(root, "in", "ABC-123.mkv");
    const target = join(root, "演员甲", "ABC-123", "ABC-123.mkv");

    await mkdir(join(root, "in"), { recursive: true });
    await mkdir(join(root, "演员甲", "ABC-123"), { recursive: true });
    await writeFile(source, "new", "utf8");
    await writeFile(target, "existing", "utf8");

    const plan = await buildPlan({ ...library, root }, [{ path: source, metadata, phase }]);
    const move = plan.entries.find((entry) => entry.action === "move");

    expect(move).toBeUndefined();
    expect(plan.entries[0]!.action).toBe("skip");
    expect(plan.entries[0]!.reason).toContain("不覆盖");
    expect(plan.summary.skip).toBe(1);
  });

  test("目标空闲时正常 move", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = await mkdtemp(join(tmpdir(), "kura-free-"));
    const source = join(root, "in", "ABC-123.mkv");
    await mkdir(join(root, "in"), { recursive: true });
    await writeFile(source, "v", "utf8");

    const plan = await buildPlan({ ...library, root }, [{ path: source, metadata, phase }]);
    expect(plan.summary.move).toBe(1);
  });
});
