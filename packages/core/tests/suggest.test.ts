import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";
import { scan } from "../src/tasks/scan";
import { suggestBindings, suggestBindingsTask } from "../src/tasks/suggest";
import { listTasks } from "../src/tasks/queue";
import type { TmdbClient, TmdbSearchHit } from "../src/sources/tmdb";

let root: string;
let rt: Runtime;
let media: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-suggest-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
  media = join(root, "media");
  await mkdir(media, { recursive: true });
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

/** 只实现 search 的假客户端: 按关键词返回预设结果, 并记录调用次数。 */
function fakeTmdb(table: Record<string, TmdbSearchHit[]>, calls: string[] = []): TmdbClient {
  return {
    requirements: () => [],
    show: async () => null,
    movie: async () => null,
    season: async () => null,
    search: async (_kind, query) => {
      calls.push(query);
      return table[query] ?? [];
    },
  };
}

const hit = (id: number, title: string, year: string | null): TmdbSearchHit => ({
  id,
  key: `tmdb:tv:${id}`,
  title,
  year,
  overview: null,
  score: 8,
});

describe("批量找建议", () => {
  test("按目录名搜索, 给出高把握的建议", async () => {
    await makeDir("进击的巨人 (2013)", ["第1集.mp4", "第2集.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const calls: string[] = [];
    const suggestions = await suggestBindings(rt, {
      tmdb: fakeTmdb({ 进击的巨人: [hit(1429, "进击的巨人", "2013")] }, calls),
      libraryId: library.id,
    });

    expect(calls).toEqual(["进击的巨人"]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.hit?.key).toBe("tmdb:tv:1429");
    expect(suggestions[0]?.confidence).toBe("high");
    expect(suggestions[0]?.query).toBe("进击的巨人");
    expect(suggestions[0]?.year).toBe("2013");
  });

  test("片名对不上就不给建议 (low 不显示)", async () => {
    await makeDir("某综艺 2024", ["第一期.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const suggestions = await suggestBindings(rt, {
      tmdb: fakeTmdb({ 某综艺: [hit(1, "奔跑吧", "2014")] }),
      libraryId: library.id,
    });
    expect(suggestions[0]?.hit).toBeNull();
    expect(suggestions[0]?.confidence).toBe("none");
  });

  test("同一搜索词一轮只查一次 (两季分开放的情况)", async () => {
    await makeDir("某剧 (2019) 第一季", ["某剧 - S01E01.mkv"]);
    await makeDir("某剧 (2019) 第二季", ["某剧 - S02E01.mkv"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const calls: string[] = [];
    await suggestBindings(rt, {
      tmdb: fakeTmdb({ 某剧: [hit(9, "某剧", "2019")] }, calls),
      libraryId: library.id,
    });
    // 两个目录剥出来的片名都是「某剧 第一季」/「某剧 第二季」→ 各自一次; 这里只验不重复轰炸
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  test("搜索失败只记在那一行, 不中断整批", async () => {
    await makeDir("会报错的剧", ["第1集.mp4"]);
    await makeDir("正常的剧", ["第1集.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const tmdb: TmdbClient = {
      requirements: () => [],
      show: async () => null,
      movie: async () => null,
      season: async () => null,
      search: async (_kind, query) => {
        if (query.includes("报错")) throw new Error("TMDB 超时");
        return [hit(1, "正常的剧", null)];
      },
    };
    const suggestions = await suggestBindings(rt, { tmdb, libraryId: library.id });
    expect(suggestions).toHaveLength(2);
    expect(suggestions.find((item) => item.name.includes("报错"))?.error).toContain("超时");
    expect(suggestions.find((item) => item.name.includes("正常"))?.hit?.key).toBe("tmdb:tv:1");
  });

  test("走任务: 建 bind.suggest 行、有进度、能取消", async () => {
    await makeDir("进击的巨人 (2013)", ["第1集.mp4"]);
    await makeDir("请回答1988 (2015)", ["第1集.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const progress: number[] = [];
    const { task, result } = await suggestBindingsTask(
      rt,
      {
        tmdb: fakeTmdb({ 进击的巨人: [hit(1429, "进击的巨人", "2013")], 请回答1988: [hit(64010, "请回答1988", "2015")] }),
        libraryId: library.id,
        onProgress: (update) => progress.push(update.index),
      },
      new AbortController().signal,
    );

    expect(task.type).toBe("bind.suggest");
    expect(task.status).toBe("done");
    expect(task.total).toBe(2);
    expect(result).toHaveLength(2);
    expect(progress).toEqual([1, 2]);
    expect(listTasks(rt, { limit: 10 }).map((row) => row.type)).toContain("bind.suggest");
  });

  test("取消后任务标 cancelled", async () => {
    await makeDir("某剧", ["第1集.mp4"]);
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });

    const controller = new AbortController();
    controller.abort();
    const { task } = await suggestBindingsTask(
      rt,
      { tmdb: fakeTmdb({}), libraryId: library.id },
      controller.signal,
    );
    expect(task.status).toBe("cancelled");
  });
});

describe("声明集数不被文件污染", () => {
  test("绑定目录不写 episodes; 声明集数只算来源给的集", async () => {
    await mkdir(join(media, "某剧"), { recursive: true });
    for (let i = 1; i <= 5; i++) await writeFile(join(media, "某剧", `某剧 - 第${i}集.mp4`), "x");
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    const { bindDirectory } = await import("../src/tasks/bind");
    const { episodeStats } = await import("../src/tasks/scrape-show");
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:54" });

    // 来源声明 3 集 (比如 TMDB 只给了 3 集)
    rt.db.run("insert into episodes (number, season, episode, title, field_sources) values ('tmdb:tv:54', 1, 1, 'A', '{\"title\":\"tmdb\"}')");
    rt.db.run("insert into episodes (number, season, episode, title, field_sources) values ('tmdb:tv:54', 1, 2, 'B', '{\"title\":\"tmdb\"}')");
    rt.db.run("insert into episodes (number, season, episode, title, field_sources) values ('tmdb:tv:54', 1, 3, 'C', '{\"title\":\"tmdb\"}')");

    const stats = episodeStats(rt, ["tmdb:tv:54"])["tmdb:tv:54"];
    // 声明 = 3 (不是 5 个文件 + 3)
    expect(stats?.declared).toBe(3);
    expect(stats?.bound).toBe(5);
  });

  test("按绝对集号摊到各季: 165 集的文件分到 7 季", async () => {
    await mkdir(join(media, "成长的烦恼"), { recursive: true });
    for (let i = 1; i <= 6; i++) await writeFile(join(media, "成长的烦恼", `成长的烦恼 ${String(i).padStart(3, "0")}集.mp4`), "x");
    const library = createLibrary(rt.db, { name: "影视库", root: media, domain: "video" });
    await scan(rt, { library });
    const { bindDirectory } = await import("../src/tasks/bind");
    const { spreadAbsoluteEpisodes } = await import("../src/tasks/scrape-show");
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "成长的烦恼"), key: "tmdb:tv:54" });

    // 声明: S1 有 2 集, S2 有 4 集
    for (const [season, episode] of [[1, 1], [1, 2], [2, 1], [2, 2], [2, 3], [2, 4]] as const) {
      rt.db.run("insert into episodes (number, season, episode, title, field_sources) values ('tmdb:tv:54', ?, ?, 'X', '{}')", [season, episode]);
    }

    const result = spreadAbsoluteEpisodes(rt, { key: "tmdb:tv:54" });
    expect(result.mapped).toBe(6);
    expect(result.unmapped).toBe(0);

    const files = rt.db.all<{ season: number; episode: number }>(
      "select season, episode from media_files order by season, episode",
    );
    expect(files).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
      { season: 2, episode: 1 },
      { season: 2, episode: 2 },
      { season: 2, episode: 3 },
      { season: 2, episode: 4 },
    ]);
  });
});
