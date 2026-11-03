import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/index";
import { openRuntime } from "../src/runtime";
import { updateNfoContent } from "../src/domain/nfo";
import { writeNfo } from "../src/tasks/nfo-write";
import { syncNfo } from "../src/tasks/nfo-sync";
import { scan } from "../src/tasks/scan";
import type { Metadata } from "../src/domain/types";

/**
 * NFO 回写: Emby/Jellyfin 读的是文件, 不是 Kura 的库。
 *
 * 所以这里两个约束同等重要:
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

    // 认得的: 都改了
    expect(content).toContain("<title>ABC-123 新标题</title>");
    expect(content).toContain("<originaltitle>ABC-123 新のタイトル</originaltitle>");
    expect(content).toContain("<premiered>2024-05-06</premiered>");
    expect(content).toContain("<runtime>150</runtime>");
    expect(content).toContain("<studio>新片商</studio>");
    expect(content).toContain("<label>新厂牌</label>");
    expect(content).toContain("<name>新系列</name>");
    expect(content).toContain("<name>新演员一</name>");
    expect(content).toContain("<name>新演员二</name>");

    // 不认识的: 原样留着(这是整份重写做不到的)
    for (const kept of ["<outline>", "<originalplot>", "<sorttitle>旧排序名</sorttitle>", "<mpaa>JP-18+</mpaa>", "<maker>旧片商</maker>", "<publisher>旧发行</publisher>", "<poster>https://example.invalid/old.jpg</poster>", "<website>"]) {
      expect(content).toContain(kept);
    }

    // 演员块里的 <type> 也留着 —— 换名字不该顺手删掉别的子元素
    expect(content).toContain("<type>Actor</type>");
    expect(changed.join("\n")).toContain("演员 旧演员 → 新演员一");
  });

  test("标签取并集: 文件里多出来的(AVC1/中文字幕)不删, Kura 的新标签追加", () => {
    const { content } = updateNfoContent(EXISTING, METADATA);
    expect(content).toContain("<tag>480P</tag>");
    expect(content).toContain("<tag>旧标签</tag>");
    expect(content).toContain("<tag>新标签</tag>");
    // 共用标签不重复写
    expect(content.match(/<tag>共用标签<\/tag>/g)).toHaveLength(1);
    // genre 是别的工具的产物, Kura 不碰
    expect(content).toContain("<genre>480P</genre>");
  });

  test("中文不被写成 &#x 实体, 写出来的文件人还能看懂", () => {
    const { content } = updateNfoContent(EXISTING, METADATA);
    expect(content).toContain("新标题");
    expect(content).not.toContain("&#x");
  });

  test("值已经是新的就不报变更 (幂等, 不抖 mtime)", () => {
    const first = updateNfoContent(EXISTING, METADATA);
    const second = updateNfoContent(first.content, METADATA);
    expect(second.changed).toEqual([]);
    expect(second.content).toBe(first.content);
  });

  test("Kura 没有值的字段不覆盖文件里的值", () => {
    const { content } = updateNfoContent(EXISTING, { ...METADATA, plot: undefined, directors: [], tags: [] });
    expect(content).toContain("<![CDATA[旧简介]]>");
    expect(content).toContain("<tag>旧标签</tag>");
  });
});

describe("nfo 回写任务", () => {
  let root: string;
  let dataDir: string;
  let media: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "kura-nfowrite-"));
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

  test("没联网刮过的条目默认跳过, 只改有网络来源的", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "库", root: media, organizeEnabled: false });
      await scan(rt, { library });
      // ABC-123: 假装刮过了; XYZ-999: 标题是手工写的(manual), 没联网
      rt.db.run("update items set title = '新标题', actors = '[\"新演员\"]', field_sources = ? where number = 'ABC-123'", [
        JSON.stringify({ title: "javbus", actors: "javbus" }),
      ]);
      rt.db.run("update items set title = '手写标题', field_sources = ? where number = 'XYZ-999'", [
        JSON.stringify({ title: "manual" }),
      ]);

      const dry = writeNfo(rt, { libraryId: library.id });
      expect(dry.dryRun).toBe(true);
      expect(dry.updated).toBe(1);
      const skipped = dry.entries.filter((entry) => entry.status === "skip");
      expect(skipped.map((entry) => entry.number)).toEqual(["XYZ-999"]);
      expect(skipped[0]!.reason).toContain("没联网刮过");
      // dry-run 不写盘
      expect(await readFile(join(media, "ABC-123.nfo"), "utf8")).toBe(EXISTING);

      const applied = writeNfo(rt, { libraryId: library.id, apply: true });
      expect(applied.updated).toBe(1);
      const written = await readFile(join(media, "ABC-123.nfo"), "utf8");
      expect(written).toContain("<title>新标题</title>");
      expect(written).toContain("<name>新演员</name>");
      expect(written).toContain("<mpaa>JP-18+</mpaa>");

      // 再跑一次: 没有变更
      expect(writeNfo(rt, { libraryId: library.id, apply: true }).updated).toBe(0);

      // --include-unscraped 才碰手写的那条
      const all = writeNfo(rt, { libraryId: library.id, includeUnscraped: true });
      expect(all.entries.find((entry) => entry.number === "XYZ-999")?.status).toBe("create");
    } finally {
      rt.close();
    }
  });

  test("没有 nfo 的文件会新建一份 Emby 能读的", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "库", root: media, organizeEnabled: false });
      await scan(rt, { library });
      rt.db.run("update items set title = '新标题', field_sources = ? where number = 'XYZ-999'", [
        JSON.stringify({ title: "javbus" }),
      ]);

      const report = writeNfo(rt, { libraryId: library.id, number: "XYZ-999", apply: true });
      expect(report.created).toBe(1);
      const created = await readFile(join(media, "XYZ-999.nfo"), "utf8");
      expect(created).toContain("<title>新标题</title>");
      expect(created).toContain('<uniqueid type="kura" default="true">XYZ-999</uniqueid>');
    } finally {
      rt.close();
    }
  });
});

describe("nfo 双向同步", () => {
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

  test("一次过两个方向: 没数据的读进来, 有数据的写回去", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "库", root: media, organizeEnabled: false });
      await scan(rt, { library });

      // ABC-123 假装刮过; XYZ-999 旁边没有 nfo
      rt.db.run("update items set title = '新标题', actors = '[\"新演员\"]', field_sources = ? where number = 'ABC-123'", [
        JSON.stringify({ title: "javbus", actors: "javbus" }),
      ]);
      rt.db.run("update items set title = '另一条', field_sources = ? where number = 'XYZ-999'", [
        JSON.stringify({ title: "javbus" }),
      ]);

      const report = syncNfo(rt, { libraryId: library.id, apply: true });
      expect(report.written).toBe(1);
      expect(report.imported).toBe(0);
      // 没有 nfo 的默认新建(按用户确认的行为)
      expect(report.created).toBe(1);
      expect(await readFile(join(media, "ABC-123.nfo"), "utf8")).toContain("<name>新演员</name>");
      expect(await readFile(join(media, "XYZ-999.nfo"), "utf8")).toContain("<title>另一条</title>");
    } finally {
      rt.close();
    }
  });

  test("库里只有 nfo 来源时, 读方向补字段(并且不覆盖已有值)", async () => {
    const rt = await openRuntime({ dataDir });
    try {
      const library = createLibrary(rt.db, { name: "库", root: media, organizeEnabled: false });
      await scan(rt, { library });

      const dry = syncNfo(rt, { libraryId: library.id, number: "ABC-123" });
      expect(dry.imported).toBe(1);
      expect(dry.dryRun).toBe(true);
      // dry-run 不落库
      expect(rt.db.get<{ title: string | null }>("select title from items where number = 'ABC-123'")?.title).toBeNull();

      const applied = syncNfo(rt, { libraryId: library.id, number: "ABC-123", apply: true });
      expect(applied.imported).toBe(1);
      const row = rt.db.get<{ title: string | null; actors: string | null }>(
        "select title, actors from items where number = 'ABC-123'",
      );
      expect(row?.title).toContain("旧标题");
      expect(row?.actors).toContain("旧演员");
    } finally {
      rt.close();
    }
  });
});
