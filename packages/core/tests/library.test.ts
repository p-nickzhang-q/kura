import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, deleteLibrary, findLibrary, renameLibrary, updateLibraryTemplate } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";
import { scan } from "../src/tasks/scan";
import { countExhausted, countItems, countPending } from "../src/tasks/scrape";
import { AppError, EXIT } from "../src/exit";

let root: string;
let rt: Runtime;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-library-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
  await mkdir(join(root, "a"), { recursive: true });
  await mkdir(join(root, "b"), { recursive: true });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

describe("添加媒体库", () => {
  test("同名目录自动加序号, 而不是抛 UNIQUE constraint", () => {
    // 两个不同父目录下的 Download/ —— 界面里库名都是 basename, 必然撞名
    const first = createLibrary(rt.db, { name: "Download", root: join(root, "a") });
    const second = createLibrary(rt.db, { name: "Download", root: join(root, "b") });

    expect(first.name).toBe("Download");
    expect(second.name).toBe("Download (2)");

    // 再来一个不冲突的名字, 不受影响
    const third = createLibrary(rt.db, { name: "影片", root: join(root, "c") });
    expect(third.name).toBe("影片");
  });

  test("序号连续递增, 不会复用已经占用的名字", () => {
    createLibrary(rt.db, { name: "Download", root: join(root, "a") });
    createLibrary(rt.db, { name: "Download", root: join(root, "b") });
    createLibrary(rt.db, { name: "Download (3)", root: join(root, "c") });
    const next = createLibrary(rt.db, { name: "Download", root: join(root, "d") });

    expect(next.name).toBe("Download (4)");
  });

  test("改名可以取任意新名字", () => {
    const library = createLibrary(rt.db, { name: "Download", root: join(root, "a") });
    const renamed = renameLibrary(rt.db, library.id, "  我的收藏  ");

    expect(renamed.name).toBe("我的收藏"); // 前后空白被裁掉
    expect(renamed.root).toBe(library.root); // 路径不变
    expect(renamed.id).toBe(library.id);
  });

  test("改名撞名时报错, 不自动加序号", () => {
    const first = createLibrary(rt.db, { name: "库A", root: join(root, "a") });
    createLibrary(rt.db, { name: "库B", root: join(root, "b") });

    expect(() => renameLibrary(rt.db, first.id, "库B")).toThrow(/已经有叫「库B」的库了/);
    // 改成自己现在的名字不算撞名
    expect(renameLibrary(rt.db, first.id, "库A").name).toBe("库A");
  });

  test("空名字被拒绝", () => {
    const library = createLibrary(rt.db, { name: "库A", root: join(root, "a") });
    expect(() => renameLibrary(rt.db, library.id, "   ")).toThrow(/不能为空/);
  });

  test("同一个目录重复添加给出可读的错误, 不是 SQLite 原文", () => {
    createLibrary(rt.db, { name: "Download", root: join(root, "a") });

    expect(() => createLibrary(rt.db, { name: "又一个", root: join(root, "a") })).toThrow(
      /已经是媒体库「Download」/,
    );
  });
});


function fileCount(rt: Runtime): number {
  return rt.db.get<{ c: number }>("select count(*) c from media_files")?.c ?? 0;
}

describe("扫描的删除安全阀", () => {
  test("已知文件大批消失时中止, 不清空索引", async () => {
    const media = join(root, "guard");
    await mkdir(media, { recursive: true });
    for (let i = 0; i < 40; i++) await writeFile(join(media, `TEST-${String(i).padStart(3, "0")}.mkv`), "x");

    const library = createLibrary(rt.db, { name: "库", root: media });
    await scan(rt, { library });
    expect(fileCount(rt)).toBe(40);

    // 模拟"盘只挂了一半": 30/40 的文件不见了
    for (let i = 0; i < 30; i++) await rm(join(media, `TEST-${String(i).padStart(3, "0")}.mkv`));
    const error = (await scan(rt, { library }).catch((err: unknown) => err)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.exitCode).toBe(EXIT.NEEDS_INPUT);
    expect(error.message).toContain("已中止");
    // 索引与条目都还在 —— 这才是关键: 下次能自己"恢复"
    expect(fileCount(rt)).toBe(40);
    expect(countItems(rt, {})).toBe(40);

    // 显式 force 才真的删
    await scan(rt, { library, force: true });
    expect(fileCount(rt)).toBe(10);
  });

  test("只删少量文件时不拦", async () => {
    const media = join(root, "guard2");
    await mkdir(media, { recursive: true });
    for (let i = 0; i < 40; i++) await writeFile(join(media, `TEST-${String(i).padStart(3, "0")}.mkv`), "x");
    const library = createLibrary(rt.db, { name: "库2", root: media });
    await scan(rt, { library });

    await rm(join(media, "TEST-000.mkv"));
    const report = await scan(rt, { library });
    expect(report.counts.removed).toBe(1);
    expect(fileCount(rt)).toBe(39);
  });
});

describe("按库计数的口径", () => {
  test("选中某个库时, 待刮削/已达上限只算这个库", async () => {
    const a = join(root, "lib-a");
    const b = join(root, "lib-b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(a, "AAA-001.mkv"), "x");
    await writeFile(join(b, "BBB-001.mkv"), "x");
    await writeFile(join(b, "BBB-002.mkv"), "x");

    const libA = createLibrary(rt.db, { name: "A", root: a });
    const libB = createLibrary(rt.db, { name: "B", root: b });
    await scan(rt, { library: libA });
    await scan(rt, { library: libB });

    // 三个条目都没有标题, 全是"待刮削"
    expect(countPending(rt)).toBe(3);
    expect(countPending(rt, { libraryId: libA.id })).toBe(1);
    expect(countPending(rt, { libraryId: libB.id })).toBe(2);

    // 其中一条刮到上限
    rt.db.run("update items set scrape_attempts = 99 where number = 'BBB-002'");
    expect(countPending(rt, { libraryId: libB.id })).toBe(1);
    expect(countExhausted(rt, { libraryId: libB.id })).toBe(1);
    expect(countExhausted(rt, { libraryId: libA.id })).toBe(0);
  });
});

describe("域 (ADR 0008 / 0009)", () => {
  test("库只有两个域: av 与 video; 默认 av", () => {
    const av = createLibrary(rt.db, { name: "番号库", root: join(root, "a") });
    const video = createLibrary(rt.db, { name: "影视库", root: join(root, "b"), domain: "video" });
    expect(av.domain).toBe("av");
    expect(video.domain).toBe("video");
    // 域不同, 默认模板也不同: 影视照抄 av 模板会生成叫 censored 的目录
    expect(av.template).toBe("{content_type}/{studio}/{number}");
    expect(video.template).toBe("{series}");
  });

  test("域没有修改入口 —— 建库时落定, 不可改", () => {
    const tv = createLibrary(rt.db, { name: "剧库", root: join(root, "b"), domain: "tv" });
    // 改名、换模板、切整理开关都不许碰域
    renameLibrary(rt.db, tv.id, "剧库改名");
    const after = rt.db.get<{ domain: string }>("select domain from libraries where id = ?", [tv.id]);
    expect(after?.domain).toBe("tv");
  });

  test("跨域目录重叠直接拒绝 (相等 / 父子 / 尾斜杠)", async () => {
    createLibrary(rt.db, { name: "影视库", root: join(root, "a"), domain: "video" });

    // 同一个目录
    expect(() => createLibrary(rt.db, { name: "番号库", root: join(root, "a"), domain: "av" })).toThrow(/重叠|已经是媒体库/);
    // 新库在旧库里面
    await mkdir(join(root, "a", "子目录"), { recursive: true });
    expect(() => createLibrary(rt.db, { name: "番号库", root: join(root, "a", "子目录"), domain: "av" })).toThrow(/重叠/);
    // 新库包含旧库
    expect(() => createLibrary(rt.db, { name: "番号库", root: root, domain: "av" })).toThrow(/重叠/);
    // 尾斜杠不影响判断
    expect(() => createLibrary(rt.db, { name: "番号库2", root: `${join(root, "a")}/`, domain: "av" })).toThrow(/重叠/);
  });

  test("同域重叠只放行(不拦), 免得老用户升级后建不了库", async () => {
    createLibrary(rt.db, { name: "番号库", root: join(root, "a") });
    await mkdir(join(root, "a", "子目录"), { recursive: true });
    expect(() => createLibrary(rt.db, { name: "番号库2", root: join(root, "a", "子目录") })).not.toThrow();
  });

  test("删库只删索引: 库与文件没了, 磁盘文件与条目都还在", async () => {
    // 造一个真目录真文件, 确认删库不碰磁盘
    const dir = join(root, "媒体");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SSIS-915.mp4"), "x");
    await writeFile(join(dir, "SSIS-916.mp4"), "x");

    const library = createLibrary(rt.db, { name: "番号库", root: dir });
    await scan(rt, { library });
    expect(rt.db.get<{ c: number }>("select count(*) c from media_files")?.c).toBe(2);
    expect(rt.db.get<{ c: number }>("select count(*) c from items")?.c).toBe(2);

    const result = deleteLibrary(rt.db, library.id);

    expect(result.library.name).toBe("番号库");
    expect(result.removedFiles).toBe(2);
    // 条目保留: 它是跨库的, 删库不该抹掉元数据
    expect(rt.db.get<{ c: number }>("select count(*) c from items")?.c).toBe(2);
    expect(rt.db.get<{ c: number }>("select count(*) c from libraries")?.c).toBe(0);
    expect(rt.db.get<{ c: number }>("select count(*) c from media_files")?.c).toBe(0);
    // 磁盘文件一个都没动
    expect(existsSync(join(dir, "SSIS-915.mp4"))).toBe(true);
    expect(existsSync(join(dir, "SSIS-916.mp4"))).toBe(true);
    expect(result.orphanItems).toBe(2);
  });

  test("删库不该影响别的库", async () => {
    const kept = createLibrary(rt.db, { name: "保留库", root: join(root, "a") });
    const dropped = createLibrary(rt.db, { name: "待删库", root: join(root, "b") });
    rt.db.run("insert into media_files (path, library_id, size, mtime_ms) values (?, ?, 1, 1)", [join(root, "a", "X.mp4"), kept.id]);
    rt.db.run("insert into media_files (path, library_id, size, mtime_ms) values (?, ?, 1, 1)", [join(root, "b", "Y.mp4"), dropped.id]);

    deleteLibrary(rt.db, dropped.id);
    expect(rt.db.get<{ c: number }>("select count(*) c from libraries")?.c).toBe(1);
    expect(rt.db.get<{ path: string }>("select path from media_files")?.path).toBe(join(root, "a", "X.mp4"));
  });

  test("删不存在的库报 NOT_FOUND", () => {
    expect(() => deleteLibrary(rt.db, 9999)).toThrow(AppError);
  });
});

describe("影视库没有整理维度", () => {
  test("给影视库写模板直接拒: 模板对它不生效, 写了只会让人以为生效了", async () => {
    const library = createLibrary(rt.db, { name: "影视库", root: join(root, "video"), domain: "video" });
    expect(() => updateLibraryTemplate(rt.db, library.id, "{actor}/{number}")).toThrow("固定形状");
    expect(findLibrary(rt.db, String(library.id))?.template).toBe("{series}");

    // 番号制照常能改
    const av = createLibrary(rt.db, { name: "番号库", root: join(root, "av"), domain: "av" });
    updateLibraryTemplate(rt.db, av.id, "{studio}/{number}");
    expect(findLibrary(rt.db, String(av.id))?.template).toBe("{studio}/{number}");
  });
});
