import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";
import { bindDirectory } from "../src/tasks/bind";
import { scan } from "../src/tasks/scan";
import { countPendingShows, pendingShowKeys, scrapeShow, scrapeShows } from "../src/tasks/scrape-show";
import type { TmdbClient, TmdbShow } from "../src/sources/tmdb";

let root: string;
let rt: Runtime;
let media: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-scrapeshow-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
  media = join(root, "media");
  await mkdir(media, { recursive: true });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

/** 假的 TMDB 客户端: 只实现被用到的两个方法。 */
function fakeTmdb(show: TmdbShow | null, movie: { id: number; fields: Record<string, unknown>; originalTitle: string | null } | null = null): TmdbClient {
  return {
    requirements: () => [],
    show: async () => show,
    movie: async () => movie as never,
    season: async () => null,
    search: async () => [],
  };
}

const showFixture: TmdbShow = {
  id: 1429,
  originalTitle: "進撃の巨人",
  fields: {
    title: "进击的巨人",
    plot: "中文简介",
    release_date: "2013-04-07",
    studio: "MBS",
    tags: ["动画"],
    duration_min: 24,
    actors: ["演员甲"],
  },
  seasons: [
    {
      season: 0,
      name: "特别篇",
      declaredEpisodes: 1,
      episodes: [{ season: 0, episode: 1, title: "特典", plot: null, airDate: null, runtimeMin: null }],
    },
    {
      season: 1,
      name: "第 1 季",
      declaredEpisodes: 3,
      episodes: [
        { season: 1, episode: 1, title: "第一集", plot: "简介一", airDate: "2013-04-07", runtimeMin: 24 },
        { season: 1, episode: 2, title: "第二集", plot: null, airDate: "2013-04-14", runtimeMin: 24 },
        { season: 1, episode: 3, title: "第三集", plot: null, airDate: "2013-04-21", runtimeMin: 24 },
      ],
    },
  ],
};

async function bindShow(files: string[]): Promise<number> {
  const dir = join(media, "某剧", "Season 01");
  await mkdir(dir, { recursive: true });
  for (const file of files) await writeFile(join(dir, file), "x");
  const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "tv" });
  await scan(rt, { library });
  bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧"), key: "tmdb:tv:1429" });
  return library.id;
}

describe("刮一部剧", () => {
  test("写剧级字段 + 集行, 跳过第 0 季(特别篇)", async () => {
    await bindShow(["第1集.mp4", "第2集.mp4"]);

    const report = await scrapeShow(rt, { key: "tmdb:tv:1429", tmdb: fakeTmdb(showFixture) });
    expect(report.ok).toBe(true);
    expect(report.fields).toContain("title");

    const item = rt.db.get<{ title: string; title_original: string; domain: string; content_type: string; actors: string }>(
      "select title, title_original, domain, content_type, actors from items where number = 'tmdb:tv:1429'",
    );
    expect(item?.title).toBe("进击的巨人");
    // 原文名单独落列, 不参与逐字段择优
    expect(item?.title_original).toBe("進撃の巨人");
    expect(item?.domain).toBe("tv");
    // 影视条目没有内容类型, 刮削不该把它改成 censored
    expect(item?.content_type).toBe("");
    expect(JSON.parse(item!.actors)).toEqual(["演员甲"]);

    const episodes = rt.db.all<{ season: number; episode: number; title: string | null }>(
      "select season, episode, title from episodes where number = 'tmdb:tv:1429' order by season, episode",
    );
    expect(episodes).toHaveLength(3);
    expect(episodes[0]?.title).toBe("第一集");
    // 特别篇(第 0 季)不落库
    expect(episodes.some((row) => row.season === 0)).toBe(false);
  });

  test("剧级时长缺失时用集级最常见时长补上", async () => {
    await bindShow(["第1集.mp4"]);
    await scrapeShow(rt, {
      key: "tmdb:tv:1429",
      // 剧级故意不给 duration_min (TMDB 中文条目常常没有)
      tmdb: fakeTmdb({ ...showFixture, fields: { title: "进击的巨人" } }),
    });
    const item = rt.db.get<{ duration_min: number }>("select duration_min from items where number = 'tmdb:tv:1429'");
    expect(item?.duration_min).toBe(24);
  });

  test("缺集 = 声明集数 - 盘上绑着的集数", async () => {
    // 盘上只有 2 集, 来源声明 3 集
    await bindShow(["第1集.mp4", "第2集.mp4"]);
    const report = await scrapeShow(rt, { key: "tmdb:tv:1429", tmdb: fakeTmdb(showFixture) });
    expect(report.declared).toBe(3);
    expect(report.bound).toBe(2);
    expect(report.missing).toBe(1);
  });

  test("field_sources 记 tmdb; 重复刮削幂等", async () => {
    await bindShow(["第1集.mp4"]);
    await scrapeShow(rt, { key: "tmdb:tv:1429", tmdb: fakeTmdb(showFixture) });
    const first = rt.db.get<{ field_sources: string; updated_at: number }>(
      "select field_sources, updated_at from items where number = 'tmdb:tv:1429'",
    );
    const sources = JSON.parse(first!.field_sources);
    expect(sources.title).toBe("tmdb");
    expect(sources.title_original).toBe("tmdb");

    await scrapeShow(rt, { key: "tmdb:tv:1429", tmdb: fakeTmdb(showFixture) });
    const episodes = rt.db.get<{ c: number }>("select count(*) c from episodes where number = 'tmdb:tv:1429'");
    expect(episodes?.c).toBe(3); // 没有重复插入
  });

  test("来源没给的字段不清空已有值", async () => {
    await bindShow(["第1集.mp4"]);
    rt.db.run("update items set plot = '我自己写的简介' where number = 'tmdb:tv:1429'");
    await scrapeShow(rt, {
      key: "tmdb:tv:1429",
      tmdb: fakeTmdb({ ...showFixture, fields: { title: "进击的巨人" } }),
    });
    const item = rt.db.get<{ plot: string; title: string }>(
      "select plot, title from items where number = 'tmdb:tv:1429'",
    );
    expect(item?.plot).toBe("我自己写的简介");
    expect(item?.title).toBe("进击的巨人");
  });

  test("TMDB 没有这部剧时给出可读的失败, 不写库", async () => {
    await bindShow(["第1集.mp4"]);
    const report = await scrapeShow(rt, { key: "tmdb:tv:999999", tmdb: fakeTmdb(null) });
    expect(report.ok).toBe(false);
    expect(report.error).toBe("TMDB 没有这部剧");
  });

  test("电影走 movie 通道, 不碰集表", async () => {
    const library = createLibrary(rt.db, { name: "电影库", root: join(root, "movies"), domain: "movie" });
    expect(library.domain).toBe("movie");
    const report = await scrapeShow(rt, {
      key: "tmdb:movie:603",
      tmdb: fakeTmdb(null, { id: 603, fields: { title: "示例电影", duration_min: 118 }, originalTitle: "Example Movie" }),
    });
    expect(report.ok).toBe(true);
    const item = rt.db.get<{ title: string; domain: string; duration_min: number }>(
      "select title, domain, duration_min from items where number = 'tmdb:movie:603'",
    );
    expect(item?.title).toBe("示例电影");
    expect(item?.domain).toBe("movie");
    expect(item?.duration_min).toBe(118);
    expect(rt.db.get<{ c: number }>("select count(*) c from episodes")?.c).toBe(0);
  });
});

describe("待刮清单", () => {
  test("绑过但没标题的算待刮; 刮过的就不算了", async () => {
    const libraryId = await bindShow(["第1集.mp4"]);
    expect(pendingShowKeys(rt, { libraryId })).toEqual(["tmdb:tv:1429"]);
    expect(countPendingShows(rt, { libraryId })).toBe(1);

    await scrapeShow(rt, { key: "tmdb:tv:1429", tmdb: fakeTmdb(showFixture) });
    expect(pendingShowKeys(rt, { libraryId })).toEqual([]);
  });

  test("av 域的条目永远不在影视待刮清单里", async () => {
    rt.db.run("insert into items (number, content_type, domain) values ('SSIS-915', 'censored', 'av')");
    expect(pendingShowKeys(rt)).toEqual([]);
  });

  test("一条失败不中断整批", async () => {
    await bindShow(["第1集.mp4"]);
    rt.db.run("insert into items (number, content_type, domain) values ('tmdb:tv:2', '', 'tv')");

    const result = await scrapeShows(rt, {
      tmdb: fakeTmdb(showFixture),
      keys: ["tmdb:tv:1429", "tmdb:tv:bad"],
    });
    // 第二条身份不合法 → 记失败, 但不抛
    expect(result.reports).toHaveLength(2);
    expect(result.reports[0]?.ok).toBe(true);
    expect(result.reports[1]?.ok).toBe(false);
  });
});
