import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";
import { scan } from "../src/tasks/scan";
import { readTodoPlans, todoCounts, todoPlans, todoPlansCached } from "../src/tasks/todo";

let root: string;
let rt: Runtime;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-todo-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

async function makeMedia(name: string, files: string[]): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const target = join(dir, file);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "x");
  }
  return dir;
}

describe("待办数字", () => {
  test("影视库按目录数未识别: 一个目录 = 一部片, 不按文件数吓人", async () => {
    const media = await makeMedia("tv", [
      join("某部剧", "某部剧01.mkv"),
      join("某部剧", "某部剧02.mkv"),
      join("另一部", "随便起的名字.mkv"),
    ]);
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });

    const counts = todoCounts(rt, { libraryId: library.id });
    expect(counts.unparsedDirs).toBe(2);
    expect(counts.unparsedFiles).toBe(3);
    // 一条都没刮过, 但候选是"目录级"的: 未识别的目录不产生刮削候选
    expect(counts.pendingScrape).toBe(0);
    expect(counts.organizeLibraries).toBe(1);
  });

  test("番号制按文件数: 认不出番号的文件没有目录语义", async () => {
    const media = await makeMedia("av", ["没番号的文件.mp4", "ABP-123.mp4"]);
    const library = createLibrary(rt.db, { name: "番号库", root: media, domain: "av" });
    await scan(rt, { library });

    const counts = todoCounts(rt, { libraryId: library.id });
    expect(counts.unparsedDirs).toBe(0);
    expect(counts.unparsedFiles).toBe(1);
  });

  test("不传 libraryId = 全部库相加", async () => {
    const av = await makeMedia("av", ["没番号.mp4"]);
    const video = await makeMedia("video", [join("某剧", "随便.mkv")]);
    const avLibrary = createLibrary(rt.db, { name: "番号库", root: av, domain: "av" });
    const videoLibrary = createLibrary(rt.db, { name: "影视库", root: video, domain: "video" });
    await scan(rt, { library: avLibrary });
    await scan(rt, { library: videoLibrary });

    const counts = todoCounts(rt);
    expect(counts.unparsedDirs).toBe(1);
    expect(counts.unparsedFiles).toBe(2);
    expect(counts.organizeLibraries).toBe(2);
  });

  test("只索引的库不产生「可整理」这一行", async () => {
    const media = await makeMedia("video", [join("某剧", "随便.mkv")]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video", organizeEnabled: false });
    await scan(rt, { library });

    expect(todoCounts(rt, { libraryId: library.id }).organizeLibraries).toBe(0);
    // 干跑也直接返回空计划, 不会去算
    const plans = await todoPlans(rt, { libraryId: library.id });
    expect(plans.organize).toBeNull();
  });

  test("整理计划与 nfo 差异: 都不写盘", async () => {
    const media = await makeMedia("video", [join("某部剧", "某部剧01.mkv"), join("某部剧", "某部剧02.mkv")]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const plans = await todoPlans(rt, { libraryId: library.id });
    // 没绑过的目录不进计划, 但形状要在 (界面按字段取值, 缺一个就是 undefined 渲染)
    expect(plans.organize).toEqual({ move: 0, writeNfo: 0, copyImage: 0, skip: 0 });
    // nfo 那份: 没刮过就没得写, 但必须是个数字而不是抛错
    expect(plans.nfo).toEqual({ created: 0, written: 0 });

    // 干跑之后磁盘还是原样
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(media, "某部剧", "某部剧01.mkv"))).toBe(true);
    expect(existsSync(join(media, "某部剧", "某部剧01.nfo"))).toBe(false);
  });
});

describe("待办两行贵数字的缓存", () => {
  test("没算过 → plans 为 null 且 stale; 算完 → 有数字且不 stale", async () => {
    const rt = await openRuntime({ dataDir: await mkdtemp(join(tmpdir(), "kura-todo-cache-")) });
    // 一个没有库的库: 整理计划是空的, 但"算过"这件事本身要能被记住
    expect(readTodoPlans(rt).plans).toBeNull();
    expect(readTodoPlans(rt).stale).toBe(true);

    const computed = await todoPlansCached(rt, { force: true });
    expect(computed.stale).toBe(false);
    expect(computed.plans).not.toBeNull();
    expect(computed.computedAt).toBeGreaterThan(0);

    // 不带 force = 只读缓存, 不再算
    const cached = await todoPlansCached(rt);
    expect(cached.plans).toEqual(computed.plans);
    expect(cached.stale).toBe(false);
    await rt.close();
  });

  test("库里的数据比缓存新 → stale(下次会重算)", async () => {
    const rt = await openRuntime({ dataDir: await mkdtemp(join(tmpdir(), "kura-todo-cache-")) });
    const library = createLibrary(rt.db, { name: "库", root: join(tmpdir(), "kura-todo-cache-root"), domain: "video" });
    await todoPlansCached(rt, { libraryId: library.id, force: true });
    expect(readTodoPlans(rt, { libraryId: library.id }).stale).toBe(false);

    // 往索引里塞一行更"新"的文件记录, 等价于"扫描过了"
    rt.db.run(
      "insert into media_files (path, library_id, size, mtime_ms, seen_at) values (?, ?, 1, 1, unixepoch() + 60)",
      [join(tmpdir(), "kura-todo-cache-root", "a.mp4"), library.id],
    );
    expect(readTodoPlans(rt, { libraryId: library.id }).stale).toBe(true);
    await rt.close();
  });

  test("作用域分开存: 换了库拿到的是 null, 不是别的库的数字", async () => {
    const rt = await openRuntime({ dataDir: await mkdtemp(join(tmpdir(), "kura-todo-cache-")) });
    const a = createLibrary(rt.db, { name: "A", root: join(tmpdir(), "kura-todo-cache-a"), domain: "video" });
    await todoPlansCached(rt, { libraryId: a.id, force: true });
    expect(readTodoPlans(rt, { libraryId: a.id }).plans).not.toBeNull();
    expect(readTodoPlans(rt, { libraryId: a.id + 99 }).plans).toBeNull();
    await rt.close();
  });
});
