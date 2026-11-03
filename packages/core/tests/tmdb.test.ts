import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError, EXIT } from "../src/exit";
import { HttpClient, type FetchLike } from "../src/net/http";
import { createTmdbClient, parseTmdbKey, redactUrl, toMovieFields, toSearchHits, toSeason, toShowFields } from "../src/sources/tmdb";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8")) as Record<string, unknown>;

/** 用假的 fetch 记录请求并按 URL 返回对应 fixture —— 不打网络, 又能验证语言回落。 */
function fakeHttp(routes: Record<string, unknown>, seen: string[] = []): HttpClient {
  const impl: FetchLike = async (url) => {
    seen.push(url);
    const path = new URL(url).pathname;
    const hit = routes[path];
    if (!hit) return new Response("not found", { status: 404 });
    return Response.json(hit);
  };
  return new HttpClient({ fetchImpl: impl, retries: 0, minIntervalMs: 0 });
}

describe("剧级字段映射", () => {
  test("中文剧名/简介/首播日/电视台/题材/时长/演员", () => {
    const fields = toShowFields(fixture("tmdb-tv.json"));
    expect(fields.title).toBe("示例剧名");
    expect(fields.plot).toBe("示例简介。");
    expect(fields.release_date).toBe("2013-04-07");
    expect(fields.studio).toBe("示例台");
    expect(fields.tags).toEqual(["动画", "动作冒险"]);
    expect(fields.duration_min).toBe(24);
    // 演员去重? 不去重: 去重是聚合层的事, 来源只忠实反映站点给的
    expect(fields.actors).toEqual(["演员甲", "演员乙", "演员甲"]);
  });

  test("原文名不进 RawFields —— 它由条目单独落 title_original", () => {
    const fields = toShowFields(fixture("tmdb-tv.json"));
    expect(Object.keys(fields)).not.toContain("title_original");
  });

  test("缺字段不产生 undefined 键", () => {
    expect(toShowFields({ id: 5 })).toEqual({});
  });
});

describe("季与集", () => {
  test("集按集号排序, 集号 0 的脏数据丢掉", () => {
    const season = toSeason(fixture("tmdb-tv-season.json"), 1);
    expect(season.season).toBe(1);
    expect(season.episodes.map((episode) => episode.episode)).toEqual([1, 2, 3]);
    expect(season.declaredEpisodes).toBe(3);
  });

  test("时长 0 视为没有, 简介为空保留 null", () => {
    const season = toSeason(fixture("tmdb-tv-season.json"), 1);
    const second = season.episodes.find((episode) => episode.episode === 2);
    expect(second?.runtimeMin).toBeNull();
    expect(second?.plot).toBeNull();
  });
});

describe("电影字段映射", () => {
  test("标题/原名/时长/出品公司", () => {
    const fields = toMovieFields(fixture("tmdb-movie.json"));
    expect(fields.title).toBe("示例电影");
    expect(fields.duration_min).toBe(118);
    expect(fields.studio).toBe("示例影业");
    expect(fields.tags).toEqual(["剧情"]);
  });
});

describe("搜索候选", () => {
  test("tv: 身份键是 tmdb:tv:<id>, 年份从首播日取", () => {
    const hits = toSearchHits(fixture("tmdb-search.json"), "tv");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      id: 1001,
      key: "tmdb:tv:1001",
      title: "示例剧名",
      year: "2013",
      overview: "示例简介。",
      score: 8.7,
    });
    expect(hits[1]?.year).toBeNull();
  });

  test("movie 用 title / release_date", () => {
    const hits = toSearchHits({ results: [{ id: 2002, title: "示例电影", release_date: "2019-05-17" }] }, "movie");
    expect(hits[0]?.key).toBe("tmdb:movie:2002");
    expect(hits[0]?.year).toBe("2019");
  });
});

describe("身份键", () => {
  test("只认 tmdb:tv:<id> / tmdb:movie:<id>", () => {
    expect(parseTmdbKey("tmdb:tv:1399")).toEqual({ kind: "tv", id: 1399 });
    expect(parseTmdbKey("TMDB:MOVIE:603")).toEqual({ kind: "movie", id: 603 });
    expect(parseTmdbKey("tmdb:tv:0")).toBeNull();
    expect(parseTmdbKey("SSIS-915")).toBeNull();
    expect(parseTmdbKey("javdb:abc")).toBeNull();
  });
});

describe("客户端", () => {
  test("没配 key 直接 NEEDS_INPUT, 不发请求", async () => {
    let called = false;
    const http = new HttpClient({
      fetchImpl: async () => {
        called = true;
        return Response.json({});
      },
      retries: 0,
      minIntervalMs: 0,
    });
    const tmdb = createTmdbClient({ http, env: {} });
    expect(tmdb.requirements()).toEqual(["KURA_TMDB_API_KEY"]);
    await expect(tmdb.movie(1)).rejects.toBeInstanceOf(AppError);
    expect(called).toBe(false);
  });

  test("中文缺简介时只补简介, 不覆盖已有的中文标题", async () => {
    const seen: string[] = [];
    const http = fakeHttp(
      {
        "/3/tv/1001": { id: 1001, name: "示例剧名", overview: "" },
        "/3/tv/1001/season/1": { season_number: 1, episodes: [{ episode_number: 1, name: "第一集" }] },
      },
      seen,
    );
    // 英文回落: 只有 overview 该来自 en-US
    const withEn = new HttpClient({
      fetchImpl: async (url) => {
        seen.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/season/1")) {
          return Response.json({ season_number: 1, episodes: [{ episode_number: 1, name: "第一集" }] });
        }
        if (parsed.searchParams.get("language") === "en-US") {
          return Response.json({ id: 1001, name: "Example Show", original_name: "Example Show", overview: "English overview." });
        }
        return Response.json({ id: 1001, name: "示例剧名", original_name: "Example Show", overview: "" });
      },
      retries: 0,
      minIntervalMs: 0,
    });
    const tmdb = createTmdbClient({ http: withEn, env: { apiKey: "k" } });
    const show = await tmdb.show(1001, { seasons: [1] });
    expect(show?.fields.title).toBe("示例剧名");
    expect(show?.fields.plot).toBe("English overview.");
    expect(show?.originalTitle).toBe("Example Show");
    expect(show?.seasons[0]?.declaredEpisodes).toBe(1);
    expect(http).toBeDefined();
  });

  test("401 归为 NEEDS_INPUT (key 不对, 重试没用)", async () => {
    const http = new HttpClient({
      fetchImpl: async () => new Response("{}", { status: 401 }),
      retries: 0,
      minIntervalMs: 0,
    });
    const tmdb = createTmdbClient({ http, env: { apiKey: "bad" } });
    try {
      await tmdb.movie(1);
      throw new Error("应该抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).exitCode).toBe(EXIT.NEEDS_INPUT);
    }
  });

  test("请求带 api_key 与 language=zh-CN, 季请求走 /tv/<id>/season/<n>", async () => {
    const seen: string[] = [];
    const http = fakeHttp(
      {
        "/3/tv/7": { id: 7, name: "剧", overview: "简介。" },
        "/3/tv/7/season/2": { season_number: 2, episodes: [{ episode_number: 1 }] },
      },
      seen,
    );
    const tmdb = createTmdbClient({ http, env: { apiKey: "secret" } });
    await tmdb.show(7, { seasons: [2] });

    expect(seen).toHaveLength(2);
    const first = new URL(seen[0]!);
    expect(first.searchParams.get("api_key")).toBe("secret");
    expect(first.searchParams.get("language")).toBe("zh-CN");
    expect(seen[1]).toContain("/3/tv/7/season/2");
  });
});

describe("key 不外泄", () => {
  test("redactUrl 把 api_key 换成 ***", () => {
    expect(redactUrl("https://api.themoviedb.org/3/tv/1?api_key=abcdef&language=zh-CN")).toBe(
      "https://api.themoviedb.org/3/tv/1?api_key=***&language=zh-CN",
    );
  });

  test("网络错误时 details.url 里的 key 被抹掉 (源码会把它打到 stdout)", async () => {
    // 500 → HttpClient 抛 RETRYABLE, 且 details.url 带着 api_key
    const http = new HttpClient({
      fetchImpl: async () => new Response("boom", { status: 500 }),
      retries: 0,
      minIntervalMs: 0,
    });
    const tmdb = createTmdbClient({ http, env: { apiKey: "supersecret" } });
    try {
      await tmdb.movie(1);
      throw new Error("应该抛错");
    } catch (err) {
      expect(JSON.stringify((err as AppError).details ?? {})).not.toContain("supersecret");
    }
  });

  test("401 的报错干脆不含 url (只剩可操作提示)", async () => {
    const http = new HttpClient({
      fetchImpl: async () => new Response("{}", { status: 401 }),
      retries: 0,
      minIntervalMs: 0,
    });
    const tmdb = createTmdbClient({ http, env: { apiKey: "supersecret" } });
    try {
      await tmdb.movie(1);
      throw new Error("应该抛错");
    } catch (err) {
      expect(JSON.stringify((err as AppError).details ?? {})).not.toContain("supersecret");
    }
  });
});
