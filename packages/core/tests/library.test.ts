import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";

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

  test("同一个目录重复添加给出可读的错误, 不是 SQLite 原文", () => {
    createLibrary(rt.db, { name: "Download", root: join(root, "a") });

    expect(() => createLibrary(rt.db, { name: "又一个", root: join(root, "a") })).toThrow(
      /已经是媒体库「Download」/,
    );
  });
});
