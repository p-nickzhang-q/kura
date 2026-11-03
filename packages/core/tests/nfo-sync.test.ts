import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/index";
import { openRuntime } from "../src/runtime";
import { updateNfoContent } from "../src/domain/nfo";
import { syncNfo } from "../src/tasks/nfo-sync";
import { scan } from "../src/tasks/scan";
import { createTask, listTasks, taskFailures, TASK_KEEP } from "../src/tasks/queue";
import type { Metadata } from "../src/domain/types";

/**
 * NFO 回写/同步: Emby/Jellyfin 读的是文件, 不是 Kura 的库。
 *
 * 两个约束同等重要:
 *  - Kura 认识的字段必须被改对(否则播放器里还是旧演员);
 *  - Kura 不认识的标签必须原样留着(别的工具写的 <outline> <sorttitle> <mpaa>
 *    <poster>… 删掉就是不可逆的数据损失)。
 */
const EXISTING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <plot><![CDATA[旧简介]]></plot>
  <outline><![CDATA[旧简介]]></outline>
  <originalplot><![CDATA[旧原名简介]]></originalplot>
  <sorttitle>旧排序名</sorttitle>
  <premiered>2020-01-01</premiered>
  <num>ABC-123</num>
  <title>[ABC-123]旧标题 旧演员</title>
  <originaltitle>ABC-123 旧のタイトル</originaltitle>
  <mpaa>JP-18+</mpaa>
  <maker>旧片商</maker>
  <publisher>旧发行</publisher>
  <actor>
    <name>旧演员</name>
    <type>Actor</type>
  </actor>
  <runtime>120</runtime>
  <set>
    <name>旧系列</name>
  </set>
  <series>旧系列</series>
  <studio>旧片商</studio>
  <label>旧厂牌</label>
  <tag>480P</tag>
  <tag>旧标签</tag>
  <tag>共用标签</tag>
  <genre>480P</genre>
  <genre>旧标签</genre>
  <poster>https://example.invalid/old.jpg</poster>
  <website>https://example.invalid/ABC-123</website>
</movie>
`;

const METADATA: Metadata = {
  key: "ABC-123",
  number: "ABC-123",
  contentType: "censored",
  title: "ABC-123 新标题",
  titleOriginal: "ABC-123 新のタイトル",
  plot: "新简介",
  release_date: "2024-05-06",
  duration_min: 150,
  studio: "新片商",
  label: "新厂牌",
  series: "新系列",
  actors: ["新演员一", "新演员二"],
  directors: ["新导演"],
  tags: ["新标签", "共用标签"],
  fieldSources: { title: "javbus", actors: "javbus" },
};

describe("nfo 字段级回写", () => {
  test("改 Kura 认识的字段, 其它标签一个不丢", () => {
    const { content, changed } = updateNfoContent(EXISTING, METADATA);
    expect(content).toContain("<title>ABC-123 新标题</title>");
    expect(content).toContain("<name>新演员一</name>");
    for (const kept of ["<outline>", "<originalplot>", "<sorttitle>旧排序名</sorttitle>", "<mpaa>JP-18+</mpaa>", "<maker>旧片商</maker>", "<publisher>旧发行</publisher>", "<poster>https://example.invalid/old.jpg</poster>", "<website>"]) {
      expect(content).toContain(kept);
    }
    expect(content).toContain("<type>Actor</type>");
    expect(changed.join("\n")).toContain("演员 旧演员 → 新演员一");
  });

  test("标签取并集, genre 不碰, 中文不写成实体", () => {
    const { content } = updateNfoContent(EXISTING, METADATA);
    expect(content).toContain("<tag>480P</tag>");
    expect(content).toContain("<tag>新标签</tag>");
    expect(content.match(/<tag>共用标签<\/tag>/g)).toHaveLength(1);
    expect(content).toContain("<genre>480P</genre>");
    expect(content).not.toContain("&#x");
  });

  test("值已经是新的就不报变更 (幂等)", () => {
    const first = updateNfoContent(EXISTING, METADATA);
    const second = updateNfoContent(first.content, METADATA);
    expect(second.changed).toEqual([]);
  });

  test("Kura 没有值的字段不覆盖文件里的值", () => {
    const { content } = updateNfoContent(EXISTING, { ...METADATA, plot: undefined, directors: [], tags: [] });
    expect(content).toContain("<![CDATA[旧简介]]>");
    expect(content).toContain("<tag>旧标签</tag>");
  });
});

describe("nfo 同步任务", () => {
  let root: string;
  let dataDir: string;
  let media: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kura-nfosync-"));
    dataDir = join(root, "data");
    media = join(root, "media");
    await mkdir(media, { recursive: true });
    await writeFile(join(media, "ABC-123.mkv"), "video", "utf8");
    await writeFile(join(media, "ABC-123.nfo"), EXISTING, "utf8");
    await writeFile(join(media, "XYZ-999.mkv"), "video", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("一次过两个方向: 有数据的写回去, 没数据的读进来, 缺文件的默认新建", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "库", root: media, organizeEnabled: false });
      await scan(rt, { library });
      rt.db.run("update items set title = '新标题', actors = '[\"新演员\"]', field_sources = ? where number = 'ABC-123'", [
        JSON.stringify({ title: "javbus", actors: "javbus" }),
      ]);
      rt.db.run("update items set title = '另一条', field_sources = ? where number = 'XYZ-999'", [
        JSON.stringify({ title: "javbus" }),
      ]);

      const report = await syncNfo(rt, { libraryId: library.id, apply: true });
      expect(report.written).toBe(1);
      expect(report.created).toBe(1);
      expect(await readFile(join(media, "ABC-123.nfo"), "utf8")).toContain("<name>新演员</name>");
      expect(await readFile(join(media, "XYZ-999.nfo"), "utf8")).toContain("<title>另一条</title>");
    } finally {
      rt.close();
    }
  });

  test("库里只有 nfo 来源时读入补空字段; 干跑不落库", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "库", root: media, organizeEnabled: false });
      await scan(rt, { library });

      const dry = await syncNfo(rt, { libraryId: library.id, number: "ABC-123" });
      expect(dry.imported).toBe(1);
      expect(rt.db.get<{ title: string | null }>("select title from items where number = 'ABC-123'")?.title).toBeNull();

      const applied = await syncNfo(rt, { libraryId: library.id, number: "ABC-123", apply: true });
      expect(applied.imported).toBe(1);
      expect(rt.db.get<{ title: string | null }>("select title from items where number = 'ABC-123'")?.title).toContain("旧标题");
    } finally {
      rt.close();
    }
  });

  test("失败不中断整批, 报告里带番号与原因", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "库", root: media, organizeEnabled: false });
      await scan(rt, { library });
      rt.db.run("update items set title = '新标题', field_sources = ? ", [JSON.stringify({ title: "javbus" })]);
      // 目录被换成同名文件 → 写 nfo 必然失败
      await rm(join(media, "ABC-123.nfo"), { force: true });
      await mkdir(join(media, "ABC-123.nfo"), { recursive: true });

      const report = await syncNfo(rt, { libraryId: library.id, apply: true });
      expect(report.errors).toBe(1);
      const failed = report.entries.find((entry) => entry.error);
      expect(failed?.number).toBe("ABC-123");
      expect(typeof failed?.error).toBe("string");
      // 另一条没被失败拖累
      expect(report.created).toBe(1);
    } finally {
      rt.close();
    }
  });
});

describe("任务记录", () => {
  let root: string;
  let dataDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kura-task-"));
    dataDir = join(root, "data");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("超过上限的旧任务与日志一起清掉", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      for (let i = 0; i < TASK_KEEP + 5; i++) createTask(rt, { type: "scrape.keys", payload: { i }, total: 1 });
      const tasks = listTasks(rt, { limit: 1000 });
      expect(tasks.length).toBe(TASK_KEEP);
      // 留下的应该是最新的那批
      expect(tasks[0]!.id).toBe(TASK_KEEP + 5);
    } finally {
      rt.close();
    }
  });

  test("失败详情从 jsonl 读出来", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const task = createTask(rt, { type: "scrape.keys", payload: {}, total: 2 });
      const { runTask } = await import("../src/tasks/queue");
      await runTask(rt, task, new AbortController().signal, async (run) => {
        run.log.write("item", { index: 1, key: "ABC-123", ok: false, error: "HTTP 403" });
        run.log.write("item", { index: 2, key: "XYZ-999", ok: true, error: null });
        return { result: null, processed: 2, failed: 1 };
      });
      const failures = taskFailures(rt, task.id);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ key: "ABC-123", error: "HTTP 403" });
    } finally {
      rt.close();
    }
  });
});
