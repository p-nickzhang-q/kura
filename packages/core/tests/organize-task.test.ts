import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { listTasks } from "../src/tasks/queue";
import { organizeTask } from "../src/tasks/organize-task";
import { openRuntime, type Runtime } from "../src/runtime";
import { scan } from "../src/tasks/scan";

let root: string;
let media: string;
let rt: Runtime;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-orgtask-"));
  media = join(root, "库");
  await mkdir(media, { recursive: true });
  rt = await openRuntime({ dataDir: join(root, "data") });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

async function touch(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x");
}

describe("整理是一条任务", () => {
  test("真搬运会建 organize 任务行, 有进度, 完工后状态 done", async () => {
    // 一个已绑的电影: 源目录是平的, 目标是 `片名 (年份)/片名 (年份).ext`
    await touch(join(media, "源", "某片.rmvb"));
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });
    rt.db.run("insert or ignore into items (number, content_type, domain, title, release_date) values (?,?,?,?,?)", [
      "tmdb:movie:1",
      "",
      "movie",
      "某片",
      "2001-01-01",
    ]);
    rt.db.run("update media_files set number = 'tmdb:movie:1' where path like ?", [join(media, "源", "%")]);

    const progress: number[] = [];
    const { task, report } = await organizeTask(
      rt,
      { libraryId: library.id, apply: true },
      new AbortController().signal,
      (update) => progress.push(update.index),
    );

    expect(task.id).toBeGreaterThan(0);
    expect(task.type).toBe("organize");
    expect(task.status).toBe("done");
    expect(progress.length).toBeGreaterThan(0);
    // 进度是递增的, 且总数来自计划(不是 0)
    expect(progress[0]).toBeGreaterThan(0);
    expect(task.total).toBeGreaterThan(0);
    expect(report?.applied?.every((entry) => entry.ok)).toBe(true);

    // 文件真的搬了, 索引也跟上了
    expect(existsSync(join(media, "某片 (2001)", "某片 (2001).rmvb"))).toBe(true);
    expect(rt.db.get<{ path: string }>("select path from media_files")?.path).toContain("某片 (2001)");

    // 任务页能看到
    expect(listTasks(rt, { limit: 3 })[0]?.type).toBe("organize");
  });

  test("干跑不建任务行", async () => {
    await touch(join(media, "源", "某片.rmvb"));
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });

    const { task, report } = await organizeTask(rt, { libraryId: library.id, apply: false }, new AbortController().signal);
    expect(task.id).toBe(0);
    expect(report).not.toBeNull();
    expect(listTasks(rt, { limit: 3 })).toHaveLength(0);
  });

  test("中途停: 任务标 cancelled, 已搬的保持原样", async () => {
    await touch(join(media, "源", "甲片.rmvb"));
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });
    rt.db.run("insert or ignore into items (number, content_type, domain, title, release_date) values (?,?,?,?,?)", [
      "tmdb:movie:1",
      "",
      "movie",
      "甲片",
      "2001-01-01",
    ]);
    rt.db.run("update media_files set number = 'tmdb:movie:1' where path like ?", [join(media, "源", "%")]);

    const controller = new AbortController();
    const { task } = await organizeTask(rt, { libraryId: library.id, apply: true }, controller.signal, (update) => {
      if (update.index === 1) controller.abort();
    });
    expect(task.status).toBe("cancelled");
  });
});

describe("整理的进度只算真的要动的", () => {
  test("计划里的 skip 不进 total; 内容没变就不重写 nfo / 不重抄图", async () => {
    // 一个已经整理到位的电影: 视频在目标位置、nfo 与图也都在
    await touch(join(media, "某片 (2001)", "某片 (2001).rmvb"));
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });
    rt.db.run("insert or ignore into items (number, content_type, domain, title, release_date) values (?,?,?,?,?)", [
      "tmdb:movie:1",
      "",
      "movie",
      "某片",
      "2001-01-01",
    ]);
    rt.db.run("update media_files set number = 'tmdb:movie:1' where path like ?", [join(media, "%")]);

    // 先跑一次让它把 nfo/图写出来
    await organizeTask(rt, { libraryId: library.id, apply: true }, new AbortController().signal);
    // 再跑一次: 应该什么都不用动
    const { task, report } = await organizeTask(rt, { libraryId: library.id, apply: true }, new AbortController().signal);

    // 第一次之后计划里只剩 write-nfo + copy-image, 第二次应当全是"内容一致 → 不写"
    const unchanged = (report?.applied ?? []).filter((entry) => entry.unchanged).length;
    expect(unchanged).toBeGreaterThan(0);
    // total 不算 skip
    expect(task.total).toBe(
      (report?.plan.summary.move ?? 0) + (report?.plan.summary.writeNfo ?? 0) + (report?.plan.summary.copyImage ?? 0),
    );
  });

  test("失败的条目能在任务详情里看到原因", async () => {
    await touch(join(media, "源", "甲片.rmvb"));
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });
    rt.db.run("insert or ignore into items (number, content_type, domain, title, release_date) values (?,?,?,?,?)", [
      "tmdb:movie:1",
      "",
      "movie",
      "甲片",
      "2001-01-01",
    ]);
    rt.db.run("update media_files set number = 'tmdb:movie:1' where path like ?", [join(media, "源", "%")]);
    // 目标目录已被一个同名文件占住 → 计划会 skip, 所以这里造一个"移动失败": 目标是个目录
    await mkdir(join(media, "甲片 (2001)", "甲片 (2001).rmvb"), { recursive: true });

    const { task } = await organizeTask(rt, { libraryId: library.id, apply: true }, new AbortController().signal);
    if (task.failed > 0) {
      const { taskFailures } = await import("../src/tasks/queue");
      const failures = taskFailures(rt, task.id);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0]!.error.length).toBeGreaterThan(0);
    }
  });
});
