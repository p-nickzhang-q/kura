import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { listTasks } from "../src/tasks/queue";
import { bindManyTask } from "../src/tasks/bind-many";
import { openRuntime, type Runtime } from "../src/runtime";
import { scan } from "../src/tasks/scan";
import type { TmdbClient } from "../src/sources/tmdb";

let root: string;
let media: string;
let rt: Runtime;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-bindmany-"));
  media = join(root, "库");
  rt = await openRuntime({ dataDir: join(root, "data") });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

async function makeDir(name: string, files: string[]): Promise<void> {
  const dir = join(media, name);
  await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(join(dir, file), "x");
}

const fakeTmdb = {
  requirements: () => [],
  search: async () => [],
  show: async () => null,
  movie: async () => null,
  season: async () => null,
  episode: async () => null,
} as unknown as TmdbClient;

describe("绑定并刮削: 一条任务行", () => {
  test("绑 3 个目录会留下 bind.many 任务, 进度与失败都记在里面", async () => {
    await makeDir("甲", ["甲01.mp4", "甲02.mp4"]);
    await makeDir("乙", ["乙.mkv"]);
    await makeDir("丙", ["丙.mkv"]);
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });

    const progress: number[] = [];
    const { task, results } = await bindManyTask(
      rt,
      {
        libraryId: library.id,
        tmdb: fakeTmdb,
        items: [
          { dir: join(media, "甲"), key: "tmdb:tv:1" },
          { dir: join(media, "乙"), key: "tmdb:movie:2" },
          // 这个名字已经被抢走(甲目录已绑), 必然失败 —— 失败也要记进任务
          { dir: join(media, "丙"), key: "not-a-tmdb-key" },
        ],
      },
      new AbortController().signal,
      (update) => progress.push(update.index),
    );

    expect(task.type).toBe("bind.many");
    expect(task.total).toBe(3);
    expect(task.processed).toBe(3);
    expect(task.failed).toBe(1);
    expect(results.filter((item) => item.ok)).toHaveLength(2);
    expect(progress).toEqual([1, 2, 3]);

    // 任务页能看到这一条
    const listed = listTasks(rt, { limit: 5 });
    expect(listed[0]?.type).toBe("bind.many");
    expect(listed[0]?.status).toBe("done");
  });

  test("中途停: 剩下的不再处理, 任务标 cancelled", async () => {
    await makeDir("甲", ["甲01.mp4", "甲02.mp4"]);
    await makeDir("乙", ["乙.mkv"]);
    const library = createLibrary(rt.db, { name: "影视", root: media, domain: "video" });
    await scan(rt, { library });

    const controller = new AbortController();
    const { task, results } = await bindManyTask(
      rt,
      {
        libraryId: library.id,
        tmdb: fakeTmdb,
        items: [
          { dir: join(media, "甲"), key: "tmdb:tv:1" },
          { dir: join(media, "乙"), key: "tmdb:movie:2" },
        ],
      },
      controller.signal,
      (update) => {
        if (update.index === 1) controller.abort();
      },
    );

    expect(results).toHaveLength(1);
    expect(task.status).toBe("cancelled");
  });
});
