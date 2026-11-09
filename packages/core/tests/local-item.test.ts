import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { isLocalKey, localItemKey } from "../src/domain/identify";
import type { Library } from "../src/domain/materialize";
import { openRuntime, type Runtime } from "../src/runtime";
import { bindLocalDirectory, listUnrecognizedDirs } from "../src/tasks/bind";
import { countPending, listItems } from "../src/tasks/scrape";
import { listEpisodes } from "../src/tasks/scrape-show";
import { scan } from "../src/tasks/scan";

let root: string;
let media: string;
let rt: Runtime;

async function touch(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-local-"));
  media = join(root, "库");
  await mkdir(media, { recursive: true });
  rt = await openRuntime({ dataDir: join(root, "data") });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

/** 真库里的形状: 下载器给的目录名是 `<aid>-<标题>`。 */
async function setupVideo(): Promise<Library> {
  await touch(join(media, "bilibili", "115406106794717-黑熊精新歌《差一点》", "成片_ys(17)-33241500011.mp4"));
  await touch(join(media, "bilibili", "115145472743415-辽艺配音153集全", "七龙珠 001 布玛与孙悟空-32144753356_25min.mp4"));
  await touch(join(media, "bilibili", "115145472743415-辽艺配音153集全", "七龙珠 002 布玛没有尾巴-32144819071_25min.mp4"));
  const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
  await scan(rt, { library });
  return library;
}

describe("本地条目: 手动把认不出的东西加入库", () => {
  test("单个文件 → 电影, 标 ugc, 标题去掉下载器的 aid 前缀", async () => {
    const library = await setupVideo();
    const dir = join(media, "bilibili", "115406106794717-黑熊精新歌《差一点》");

    const result = bindLocalDirectory(rt, { libraryId: library.id, dir });
    expect(result.kind).toBe("movie");
    expect(result.bound).toBe(1);
    expect(result.title).toBe("黑熊精新歌《差一点》");
    expect(result.key.startsWith("local:")).toBe(true);

    const item = listItems(rt, { libraryId: library.id })[0]!;
    expect(item.key).toBe(result.key);
    expect(item.contentType).toBe("ugc");
    expect(item.domain).toBe("movie");
    expect(item.title).toBe("黑熊精新歌《差一点》");
  });

  test("多个文件 → 剧集; 不编造声明集 (episodes 表留空)", async () => {
    const library = await setupVideo();
    const dir = join(media, "bilibili", "115145472743415-辽艺配音153集全");

    const result = bindLocalDirectory(rt, { libraryId: library.id, dir });
    expect(result.kind).toBe("tv");
    expect(result.bound).toBe(2);
    expect(rt.db.get<{ n: number }>("select count(*) as n from episodes where number = ?", [result.key])?.n).toBe(0);
  });

  test("类型可以覆盖: 两个文件也能当电影", async () => {
    const library = await setupVideo();
    const dir = join(media, "bilibili", "115145472743415-辽艺配音153集全");
    expect(bindLocalDirectory(rt, { libraryId: library.id, dir, type: "movie" }).kind).toBe("movie");
  });

  test("人给的标题优先; 同一个目录再绑一次不新建条目, 只补标题", async () => {
    const library = await setupVideo();
    const dir = join(media, "bilibili", "115406106794717-黑熊精新歌《差一点》");

    const first = bindLocalDirectory(rt, { libraryId: library.id, dir, title: "黑熊精 · 差一点" });
    expect(first.title).toBe("黑熊精 · 差一点");

    const again = bindLocalDirectory(rt, { libraryId: library.id, dir, title: "改了个名" });
    expect(again.key).toBe(first.key);
    expect(again.title).toBe("改了个名");
    expect(listItems(rt, { libraryId: library.id })).toHaveLength(1);
  });

  test("不同目录撞同一个标题: 身份键加序号, 不会互相覆盖", async () => {
    await touch(join(media, "a", "合集", "01.mp4"));
    await touch(join(media, "b", "合集", "02.mp4"));
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const one = bindLocalDirectory(rt, { libraryId: library.id, dir: join(media, "a", "合集"), title: "合集" });
    const two = bindLocalDirectory(rt, { libraryId: library.id, dir: join(media, "b", "合集"), title: "合集" });
    expect(one.key).toBe("local:合集");
    expect(two.key).toBe("local:合集-2");
    expect(two.deduped).toBe(true);
  });

  test("干跑不写库", async () => {
    const library = await setupVideo();
    const dir = join(media, "bilibili", "115406106794717-黑熊精新歌《差一点》");
    const result = bindLocalDirectory(rt, { libraryId: library.id, dir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.bound).toBe(1);
    expect(listItems(rt, { libraryId: library.id })).toHaveLength(0);
    expect(rt.db.get<{ n: number }>("select count(*) as n from media_files where number is not null")?.n).toBe(0);
  });

  test("番号制库不能建本地条目 (身份是番号, 不是 local:)", async () => {
    await touch(join(media, "ABC-123.mp4"));
    const library = createLibrary(rt.db, { name: "番号库", root: media, domain: "av" });
    await scan(rt, { library });
    expect(() => bindLocalDirectory(rt, { libraryId: library.id, dir: media })).toThrow("番号制库");
  });

  test("本地条目不算未刮削 —— 否则批量刮削会一直卡在它身上", async () => {
    const library = await setupVideo();
    bindLocalDirectory(rt, { libraryId: library.id, dir: join(media, "bilibili", "115406106794717-黑熊精新歌《差一点》") });
    expect(countPending(rt, { libraryId: library.id })).toBe(0);
  });
});

describe("身份键", () => {
  test("localItemKey: 留中文, 折标点, 去掉尾部连字符", () => {
    expect(localItemKey("115406106794717-黑熊精新歌《差一点》")).toBe("local:115406106794717-黑熊精新歌-差一点");
    expect(localItemKey("Top Songs Vol.2")).toBe("local:top-songs-vol-2");
  });

  test("全被折光时退回 local:item, 不留一个空身份", () => {
    expect(localItemKey("!!!")).toBe("local:item");
    expect(isLocalKey("LOCAL:abc")).toBe(true);
    expect(isLocalKey("tmdb:tv:1399")).toBe(false);
    expect(isLocalKey("SSIS-001")).toBe(false);
  });
});

describe("电影候选: 传进来的是文件路径", () => {
  test("标题取文件名去掉扩展名与 aid 前缀", async () => {
    await touch(join(media, "bilibili", "115406106794717-黑熊精新歌《差一点》", "成片-33241500011.mp4"));
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const file = join(media, "bilibili", "115406106794717-黑熊精新歌《差一点》", "成片-33241500011.mp4");
    const result = bindLocalDirectory(rt, { libraryId: library.id, dir: file, paths: [file] });
    expect(result.kind).toBe("movie");
    expect(result.bound).toBe(1);
    expect(result.title).toBe("成片-33241500011");
  });
});

describe("本地条目的集显示", () => {
  test("没有声明集时不把盘上的集全标成'未声明'", async () => {
    const library = await setupVideo();
    const dir = join(media, "bilibili", "115145472743415-辽艺配音153集全");
    const { key } = bindLocalDirectory(rt, { libraryId: library.id, dir });
    // 给一个文件补集号, 让它出现在"盘上集"里
    const path = join(dir, "七龙珠 001 布玛与孙悟空-32144753356_25min.mp4");
    rt.db.run("update media_files set season = 1, episode = 1 where path = ?", [path]);

    const episodes = listEpisodes(rt, key);
    expect(episodes).toHaveLength(0);
  });
});

describe("未识别树 (影视库专用)", () => {
  test("按目录分组, 文件带集号, 判据与扫描一致", async () => {
    await mkdir(join(media, "某剧"), { recursive: true });
    await writeFile(join(media, "某剧", "某剧 第1集.mp4"), "x");
    await writeFile(join(media, "某剧", "某剧 第2集.mp4"), "x");
    await writeFile(join(media, "某剧", "特典映像.mp4"), "x");
    await mkdir(join(media, "散装"), { recursive: true });
    await writeFile(join(media, "散装", "甲片.mp4"), "x");
    await writeFile(join(media, "散装", "乙片.mp4"), "x");

    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const tree = listUnrecognizedDirs(rt, { libraryId: library.id });
    expect(tree.map((node) => `${node.kind}:${node.name}:${node.files.length}`)).toEqual([
      "tv:某剧:3", // 两个集号 + 一个特典 → 剧
      "movie:散装:2", // 两个都没有集号 → 两个独立电影候选
    ]);
    const show = tree[0]!;
    expect(show.parsed).toBe(2);
    expect(show.files.map((file) => file.episode)).toEqual([1, 2, null]);
  });

  test("目录名里的年份被提出来, 给 TMDB 搜索预填", async () => {
    await mkdir(join(media, "某电影 (2019)"), { recursive: true });
    await writeFile(join(media, "某电影 (2019)", "某电影 (2019).mkv"), "x");
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const tree = listUnrecognizedDirs(rt, { libraryId: library.id });
    expect(tree[0]?.year).toBe("2019");
    expect(tree[0]?.kind).toBe("movie");
  });

  test("已绑定的文件不出现在树里", async () => {
    const library = await setupVideo();
    const dir = join(media, "bilibili", "115406106794717-黑熊精新歌《差一点》");
    bindLocalDirectory(rt, { libraryId: library.id, dir });
    const tree = listUnrecognizedDirs(rt, { libraryId: library.id });
    expect(tree.some((node) => node.files.some((file) => file.path.includes("成片_ys")))).toBe(false);
  });
});
