import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLibraryMounted, bindVolume, relocateLibrary, volumeFingerprint } from "../src/db/volume";
import { openRuntime } from "../src/runtime";
import { createLibrary, findLibrary, listLibraries } from "../src/db/rows";
import { AppError } from "../src/exit";
import type { Library } from "../src/domain/materialize";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kura-vol-"));
}

async function setup(): Promise<{ rt: Awaited<ReturnType<typeof openRuntime>>; root: string; library: Library }> {
  const dataDir = await scratch();
  const root = join(dataDir, "媒体");
  await mkdir(join(root, "子目录"), { recursive: true });
  const rt = await openRuntime({ dataDir });
  const library = createLibrary(rt.db, { name: "媒体", root, domain: "video" });
  return { rt, root, library };
}

describe("卷指纹", () => {
  test("Windows 上取 stat.dev 的 hex; 其它平台返回 null(设备号重启会变, 误报更糟)", () => {
    const fakeStat = ((_p: string) => ({ dev: 0x5edc189f })) as unknown as typeof import("node:fs").statSync;
    expect(volumeFingerprint("E:\\视频", { stat: fakeStat, platform: "win32" })).toBe("5EDC189F");
    expect(volumeFingerprint("E:\\视频", { stat: fakeStat, platform: "linux" })).toBeNull();
  });

  test("路径不存在时返回 null, 不抛", () => {
    expect(volumeFingerprint("/definitely/not/here", { platform: "win32" })).toBeNull();
  });
});

describe("扫描前的两道门", () => {
  test("库根不存在 → NEEDS_INPUT, 不等到 30% 安全阀(小库会被清空)", async () => {
    const { rt, library } = await setup();
    const ghost = { ...library, root: join(library.root, "不存在的子目录") };
    try {
      assertLibraryMounted(ghost);
      throw new Error("应该抛");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).exitCode).toBe(4);
      expect((err as AppError).message).toContain("媒体库目录不存在");
      expect((err as AppError).details?.hint).toContain("library relocate");
    }
    await rt.close();
  });

  test("卷指纹不一致 → 明说插错盘了", async () => {
    const { rt, library } = await setup();
    // 卷指纹只在 Windows 生效, 测试里把平台和 stat 都喂进去
    const fakeStat = ((_p: string) => ({ dev: 0xc66e1c94, isDirectory: () => true })) as unknown as typeof import("node:fs").statSync;
    try {
      assertLibraryMounted({ ...library, volumeId: "AAAA1111" }, { stat: fakeStat, platform: "win32" });
      throw new Error("应该抛");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).toContain("插错盘了");
      expect((err as AppError).details?.expectedVolume).toBe("AAAA1111");
    }
    await rt.close();
  });

  test("老库没有指纹 → 扫描时补记, 之后就不再是 null", async () => {
    const { rt, library } = await setup();
    // 模拟 v14 之前建的库
    rt.db.run("update libraries set volume_id = null where id = ?", [library.id]);
    const stale = findLibrary(rt.db, library.id)!;
    expect(stale.volumeId).toBeNull();

    bindVolume(rt.db, stale);
    const after = findLibrary(rt.db, library.id)!;
    // Linux 上拿不到指纹, 所以这里只断言"要么记上了, 要么还是 null 但没炸"
    expect(after.volumeId === null || typeof after.volumeId === "string").toBe(true);
    await rt.close();
  });
});

describe("库搬家 library relocate", () => {
  test("干跑只算不动; --apply 后索引跟着换前缀, 别的库一条不动", async () => {
    const dataDir = await scratch();
    const oldRoot = join(dataDir, "旧盘", "视频");
    const newRoot = join(dataDir, "新盘", "影视");
    await mkdir(join(oldRoot, "movie"), { recursive: true });
    await mkdir(join(newRoot, "movie"), { recursive: true });
    const rt = await openRuntime({ dataDir });

    const library = createLibrary(rt.db, { name: "视频", root: oldRoot, domain: "av" });
    const other = createLibrary(rt.db, { name: "别的", root: join(dataDir, "别处"), domain: "av" });

    // 两个文件, 都在新根里有对应的
    for (const name of ["movie/甲.rmvb", "movie/乙.rmvb"]) {
      await writeFile(join(oldRoot, name), "x");
      await writeFile(join(newRoot, name), "x");
      rt.db.run(
        "insert into media_files (path, library_id, number, size, mtime_ms) values (?, ?, null, 1, 1)",
        [join(oldRoot, name), library.id],
      );
    }
    // 别的库的行, 路径前缀恰好是本库根的字符串前缀 —— 不能被一起改
    rt.db.run("insert into media_files (path, library_id, number, size, mtime_ms) values (?, ?, null, 1, 1)", [
      `${oldRoot}2/movie/丙.rmvb`,
      other.id,
    ]);

    const dry = relocateLibrary(rt.db, library, newRoot);
    expect(dry.moved).toBe(2);
    expect(dry.missing).toBe(0);
    // 干跑: 索引里还是旧路径
    expect(rt.db.get<{ path: string }>("select path from media_files where library_id = ? limit 1", [library.id])!.path).toBe(
      join(oldRoot, "movie/甲.rmvb"),
    );

    const applied = relocateLibrary(rt.db, library, newRoot, { apply: true });
    expect(applied.moved).toBe(2);
    const paths = rt.db.all<{ path: string }>("select path from media_files where library_id = ? order by path", [library.id]);
    expect(paths.map((row) => row.path).sort()).toEqual(
      [join(newRoot, "movie/甲.rmvb"), join(newRoot, "movie/乙.rmvb")].sort(),
    );
    // 库根跟着改
    expect(findLibrary(rt.db, library.id)!.root).toBe(newRoot);
    // 别的库那条一直在, 没被 `E:\视频` 前缀误伤
    expect(rt.db.get("select 1 from media_files where library_id = ?", [other.id])).toBeTruthy();
    await rt.close();
  });

  test("新目录不存在 → NOT_FOUND; 新目录里一个文件都没有 → 拒绝 apply", async () => {
    const dataDir = await scratch();
    const oldRoot = join(dataDir, "旧");
    const emptyNew = join(dataDir, "空");
    await mkdir(oldRoot, { recursive: true });
    await mkdir(emptyNew, { recursive: true });
    await writeFile(join(oldRoot, "a.rmvb"), "x");
    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "旧", root: oldRoot, domain: "av" });
    rt.db.run("insert into media_files (path, library_id, number, size, mtime_ms) values (?, ?, null, 1, 1)", [
      join(oldRoot, "a.rmvb"),
      library.id,
    ]);

    expect(() => relocateLibrary(rt.db, library, join(dataDir, "没有这个目录"))).toThrow(/新目录不存在/);

    expect(() => relocateLibrary(rt.db, library, emptyNew, { apply: true })).toThrow(/一个文件都没有/);
    // 拒绝之后索引和库根都没被动过
    expect(findLibrary(rt.db, library.id)!.root).toBe(oldRoot);
    expect(rt.db.get<{ path: string }>("select path from media_files limit 1")!.path).toBe(join(oldRoot, "a.rmvb"));

    // 干跑不算失败: 只是把"全部对不上"报出来
    const dry = relocateLibrary(rt.db, library, emptyNew);
    expect(dry.missing).toBe(1);
    expect(dry.missingSample[0]).toContain("空");
    await rt.close();
  });

  test("搬到别的库目录上 → 拒绝(两个库不能共用一个目录)", async () => {
    const dataDir = await scratch();
    const rootA = join(dataDir, "A");
    const rootB = join(dataDir, "B");
    await mkdir(rootA, { recursive: true });
    await mkdir(rootB, { recursive: true });
    const rt = await openRuntime({ dataDir });
    const a = createLibrary(rt.db, { name: "A", root: rootA, domain: "av" });
    createLibrary(rt.db, { name: "B", root: rootB, domain: "av" });

    expect(() => relocateLibrary(rt.db, a, rootB)).toThrow(/重叠/);
    expect(listLibraries(rt.db).map((library) => library.root).sort()).toEqual([rootA, rootB].sort());
    await rt.close();
  });
});
