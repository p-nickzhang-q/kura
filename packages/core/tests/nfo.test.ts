import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nfoPathFor, parseNfo, readNfo, updateNfoContent } from "../src/domain/nfo";
import { buildNfo } from "../src/domain/materialize";
import { openRuntime } from "../src/runtime";
import { createLibrary } from "../src/db/rows";
import { scan } from "../src/tasks/scan";
import { countItems, listItems } from "../src/tasks/scrape";
import { syncNfo } from "../src/tasks/nfo-sync";
import type { Metadata } from "../src/domain/types";

const metadata: Metadata = {
  key: "TEST-001",
  number: "TEST-001",
  contentType: "censored",
  title: "被翻译过的标题",
  titleOriginal: "翻訳前のタイトル",
  plot: "简介",
  release_date: "2024-05-01",
  duration_min: 120,
  studio: "片商A",
  label: "厂牌B",
  series: "系列C",
  directors: ["导演甲"],
  actors: ["演员一", "演员二"],
  tags: ["标签x"],
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `kura-${prefix}-`));
}

describe("nfo 回读", () => {
  test("自己写出去的 nfo 能原样读回来", () => {
    const fields = parseNfo(buildNfo(metadata, "TEST-001-thumb.jpg"));
    expect(fields).not.toBeNull();
    expect(fields!.title).toBe("被翻译过的标题");
    expect(fields!.titleOriginal).toBe("翻訳前のタイトル");
    expect(fields!.plot).toBe("简介");
    expect(fields!.releaseDate).toBe("2024-05-01");
    expect(fields!.durationMin).toBe(120);
    expect(fields!.studio).toBe("片商A");
    expect(fields!.series).toBe("系列C");
    expect(fields!.actors).toEqual(["演员一", "演员二"]);
    expect(fields!.directors).toEqual(["导演甲"]);
    expect(fields!.tags).toEqual(["标签x"]);
  });

  test("nfo 路径与视频同名", () => {
    expect(nfoPathFor("/库/SSIS-001.mkv")).toBe("/库/SSIS-001.nfo");
    expect(nfoPathFor("/库/SSIS-001.chs.mp4")).toBe("/库/SSIS-001.chs.nfo");
  });

  test("没有 movie 根节点的文件按没有处理", () => {
    expect(parseNfo("<html><body>不是 nfo</body></html>")).toBeNull();
    expect(parseNfo("随便一段文本")).toBeNull();
  });

  test("换电脑场景: 扫一遍只报数, 元数据由 nfo sync 捞回来", async () => {
    const dir = tempDir("nfo-scan");
    const media = join(dir, "media");
    mkdirSync(media, { recursive: true });
    writeFileSync(join(media, "SSIS-001.mkv"), "video");
    writeFileSync(join(media, "SSIS-001.nfo"), buildNfo(metadata, "SSIS-001-thumb.jpg"));

    const rt = await openRuntime({ dataDir: join(dir, "data") });
    const library = createLibrary(rt.db, { name: "库", root: media });
    const report = await scan(rt, { library });

    // scan 不再读 nfo 入库, 但必须告诉人"有 nfo 还没读进来"
    expect(report.counts.nfoPending).toBe(1);
    expect(listItems(rt, { q: "SSIS-001" })[0]?.title).toBeFalsy();

    const synced = await syncNfo(rt, { libraryId: library.id, apply: true });
    expect(synced.imported).toBe(1);
    const [item] = listItems(rt, { q: "SSIS-001" });
    expect(item?.title).toBe("被翻译过的标题");
    expect(item?.titleOriginal).toBe("翻訳前のタイトル");
    expect(item?.release_date).toBe("2024-05-01");
    expect(item?.actors).toEqual(["演员一", "演员二"]);

    // 再同步一次: 库里已经满了, 读方向没东西可补; 写方向默认不新建, 也不会动既有 nfo
    const again = await syncNfo(rt, { libraryId: library.id, apply: true });
    expect(again.imported).toBe(0);
    expect(listItems(rt, { q: "SSIS-001" })[0]?.title).toBe("被翻译过的标题");
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("视频旁边没有 nfo 时什么都不做", async () => {
    const dir = tempDir("nfo-none");
    const media = join(dir, "media");
    mkdirSync(media, { recursive: true });
    writeFileSync(join(media, "SSIS-002.mkv"), "video");

    const rt = await openRuntime({ dataDir: join(dir, "data") });
    const library = createLibrary(rt.db, { name: "库", root: media });
    const report = await scan(rt, { library });

    expect(report.counts.nfoPending).toBe(0);
    expect(readNfo(join(media, "SSIS-002.mkv"))).toBeNull();
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("写回 nfo 必须收敛 (带实体字符也一样)", () => {
  const base = metadata;
  const original = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>被翻译过的标题</title>
</movie>
`;

  test("含 & 的标签: 写一次之后再跑一次不该再报变化", () => {
    const withTags: Metadata = { ...base, tags: ["Sci-Fi & Fantasy", "动作冒险"] };
    const once = updateNfoContent(original, withTags);
    expect(once.changed.join()).toContain("标签 新增 2 个");

    // 以前比的是「文件里的 &amp; vs 库里的 &」→ 每次同步再追加一份, 实测堆到 3 份
    const again = updateNfoContent(once.content, withTags);
    expect(again.changed).toEqual([]);
  });

  test("含撇号的演员名同样收敛", () => {
    const withActor: Metadata = { ...base, actors: ["Renato D'Angelo"] };
    const once = updateNfoContent(original, withActor);
    expect(updateNfoContent(once.content, withActor).changed).toEqual([]);
  });

  test("旧版堆出来的重复标签顺手删掉", () => {
    const dirty = original.replace(
      "</movie>",
      "<tag>Sci-Fi &amp; Fantasy</tag><tag>Sci-Fi &amp; Fantasy</tag></movie>",
    );
    const result = updateNfoContent(dirty, { ...base, tags: ["Sci-Fi & Fantasy"] });
    expect(result.changed.join()).toContain("去掉重复");
    expect(result.content.match(/Sci-Fi &amp; Fantasy/g) ?? []).toHaveLength(1);
  });
});
