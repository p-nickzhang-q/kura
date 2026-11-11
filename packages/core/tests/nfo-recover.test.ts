import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTvNfo } from "../src/domain/nfo-tv-read";
import { recoverFromNfo } from "../src/tasks/nfo-recover";
import { openRuntime } from "../src/runtime";
import { createLibrary } from "../src/db/rows";

const TVSHOW = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<tvshow>
  <title>仁医</title>
  <originaltitle>JIN-仁-</originaltitle>
  <plot>南方仁穿越到江户时代。</plot>
  <premiered>2009-10-11</premiered>
  <studio>TBS</studio>
  <genre>剧情</genre>
  <genre>历史</genre>
  <uniqueid type="tmdb" default="true">46198</uniqueid>
  <actor><name>大泽隆夫</name></actor>
  <actor><name>中谷美纪</name></actor>
  <!-- 播放器状态: 明确不读 -->
  <playcount>7</playcount>
  <watched>true</watched>
  <lastplayed>2026-11-01</lastplayed>
  <userrating>9</userrating>
</tvshow>
`;

const EPISODE = (season: number, episode: number, title: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<episodedetails>
  <title>${title}</title>
  <plot>第 ${episode} 集的简介</plot>
  <aired>2009-10-11</aired>
  <season>${season}</season>
  <episode>${episode}</episode>
  <uniqueid type="tmdb">46198</uniqueid>
</episodedetails>
`;

const MOVIE = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>刺客信条：血系</title>
  <originaltitle>Assassin's Creed: Lineage</originaltitle>
  <plot>短剧集</plot>
  <premiered>2009-11-15</premiered>
  <studio>Hybride Technologies</studio>
  <runtime>36</runtime>
  <genre>历史</genre>
  <tmdbid>1008421</tmdbid>
</movie>
`;

describe("读影视 nfo", () => {
  test("剧级: 读身份和内容字段, 播放状态一概不读", () => {
    const parsed = parseTvNfo(TVSHOW)!;
    expect(parsed.root).toBe("tvshow");
    expect(parsed.tmdbId).toBe("46198");
    expect(parsed.title).toBe("仁医");
    expect(parsed.originalTitle).toBe("JIN-仁-");
    expect(parsed.premiered).toBe("2009-10-11");
    expect(parsed.genres).toEqual(["剧情", "历史"]);
    expect(parsed.actors).toEqual(["大泽隆夫", "中谷美纪"]);
    // 播放器状态不在返回值里 —— 类型上就没有这几个字段, 所以"回读污染"不可能发生
    expect(Object.keys(parsed)).not.toContain("playcount");
    expect(JSON.stringify(parsed)).not.toContain("2026-11-01");
  });

  test("Emby 的 <tmdbid> 写法也认", () => {
    const parsed = parseTvNfo(MOVIE)!;
    expect(parsed.root).toBe("movie");
    expect(parsed.tmdbId).toBe("1008421");
    expect(parsed.runtimeMin).toBe(36);
  });

  test("集级: season/episode/aired 都在", () => {
    const parsed = parseTvNfo(EPISODE(2, 5, "第五集"))!;
    expect(parsed.root).toBe("episodedetails");
    expect(parsed.season).toBe(2);
    expect(parsed.episode).toBe(5);
    expect(parsed.title).toBe("第五集");
    expect(parsed.premiered).toBe("2009-10-11");
  });

  test("没有 tmdb id / 不是影视 nfo → 明确返回 null, 不瞎猜", () => {
    expect(parseTvNfo("<tvshow><title>x</title></tvshow>")!.tmdbId).toBeNull();
    expect(parseTvNfo("<html><body>404</body></html>")).toBeNull();
    expect(parseTvNfo("not xml at all")).toBeNull();
  });
});

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kura-recover-"));
}

describe("从 nfo 恢复整库", () => {
  test("新电脑 + 刮削好的盘: 干跑只数, apply 才建条目/绑定/补字段", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "影视");
    const showDir = join(root, "仁医 (2009)");
    const movieDir = join(root, "刺客信条：血系 (2009)");
    await mkdir(showDir, { recursive: true });
    await mkdir(movieDir, { recursive: true });

    await writeFile(join(showDir, "tvshow.nfo"), TVSHOW);
    await writeFile(join(showDir, "仁医 - S01E01.mkv"), "x");
    await writeFile(join(showDir, "仁医 - S01E02.mkv"), "x");
    await writeFile(join(showDir, "仁医 - S01E01.nfo"), EPISODE(1, 1, "第一集"));
    await writeFile(join(showDir, "仁医 - S01E02.nfo"), EPISODE(1, 2, "第二集"));

    await writeFile(join(movieDir, "刺客信条：血系.mkv"), "x");
    await writeFile(join(movieDir, "刺客信条：血系.nfo"), MOVIE);

    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "影视", root, domain: "video" });

    // 模拟"扫描过了": 文件都登记成未绑定
    for (const path of [
      join(showDir, "仁医 - S01E01.mkv"),
      join(showDir, "仁医 - S01E02.mkv"),
      join(movieDir, "刺客信条：血系.mkv"),
    ]) {
      rt.db.run(
        "insert into media_files (path, library_id, number, size, mtime_ms, season, episode) values (?, ?, null, 1, 1, ?, ?)",
        [
          path,
          library.id,
          path.includes("S01E01") ? 1 : path.includes("S01E02") ? 1 : null,
          path.includes("S01E01") ? 1 : path.includes("S01E02") ? 2 : null,
        ],
      );
    }

    // 1) 干跑: 数字对, 但一条都不写
    const dry = await recoverFromNfo(rt, { libraryId: library.id });
    expect(dry.dryRun).toBe(true);
    expect(dry.shows).toBe(1);
    expect(dry.movies).toBe(1);
    expect(dry.files).toBe(3);
    expect(rt.db.get("select 1 from items where number like 'tmdb:%'")).toBeFalsy();
    expect(rt.db.get<{ n: number }>("select count(*) as n from media_files where number is not null")!.n).toBe(0);

    // 2) apply: 建条目 + 绑定 + 元数据
    const applied = await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    expect(applied.done.length).toBe(2);
    expect(applied.done.every((entry) => entry.created)).toBe(true);

    const show = rt.db.get<{ title: string; title_original: string; plot: string; release_date: string; studio: string; actors: string; tags: string }>(
      "select title, title_original, plot, release_date, studio, actors, tags from items where number = 'tmdb:tv:46198'",
    )!;
    expect(show.title).toBe("仁医");
    expect(show.title_original).toBe("JIN-仁-");
    expect(show.release_date).toBe("2009-10-11");
    expect(show.studio).toBe("TBS");
    expect(JSON.parse(show.actors)).toEqual(["大泽隆夫", "中谷美纪"]);
    expect(JSON.parse(show.tags)).toEqual(["剧情", "历史"]);

    // 集级 nfo 的集名进了 episodes(来源声明的集)
    const episodes = rt.db.all<{ season: number; episode: number; title: string }>(
      "select season, episode, title from episodes where number = 'tmdb:tv:46198' order by episode",
    );
    expect(episodes.map((row) => row.title)).toEqual(["第一集", "第二集"]);

    // 电影走自己的身份
    const movie = rt.db.get<{ title: string; duration_min: number }>(
      "select title, duration_min from items where number = 'tmdb:movie:1008421'",
    )!;
    expect(movie.title).toBe("刺客信条：血系");
    expect(movie.duration_min).toBe(36);

    // 文件都绑上了
    expect(rt.db.get<{ n: number }>("select count(*) as n from media_files where number is null")!.n).toBe(0);
    await rt.close();
  });

  test("只填空: 库里已经刮过的字段不被 nfo 盖掉", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "影视");
    const showDir = join(root, "仁医");
    await mkdir(showDir, { recursive: true });
    await writeFile(join(showDir, "tvshow.nfo"), TVSHOW);
    await writeFile(join(showDir, "仁医 - S01E01.mkv"), "x");

    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "影视", root, domain: "video" });
    rt.db.run("insert into media_files (path, library_id, number, size, mtime_ms, season, episode) values (?, ?, null, 1, 1, 1, 1)", [
      join(showDir, "仁医 - S01E01.mkv"),
      library.id,
    ]);
    // 库里已经有网络来源的标题与简介
    rt.db.run("insert into items (number, content_type, domain, title, plot, field_sources) values ('tmdb:tv:46198', '', 'tv', '仁医 (网络版)', '网络简介', '{\"title\":\"tmdb\"}')");

    await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    const row = rt.db.get<{ title: string; plot: string; studio: string; field_sources: string }>(
      "select title, plot, studio, field_sources from items where number = 'tmdb:tv:46198'",
    )!;
    // 已有的不动
    expect(row.title).toBe("仁医 (网络版)");
    expect(row.plot).toBe("网络简介");
    // 空的补上
    expect(row.studio).toBe("TBS");
    // 来源标记不许把网络来源改写成 nfo
    expect(JSON.parse(row.field_sources).title).toBe("tmdb");
    await rt.close();
  });

  test("幂等: 再跑一次没有新条目", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "影视");
    const showDir = join(root, "仁医");
    await mkdir(showDir, { recursive: true });
    await writeFile(join(showDir, "tvshow.nfo"), TVSHOW);
    await writeFile(join(showDir, "仁医 - S01E01.mkv"), "x");

    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "影视", root, domain: "video" });
    rt.db.run("insert into media_files (path, library_id, number, size, mtime_ms, season, episode) values (?, ?, null, 1, 1, 1, 1)", [
      join(showDir, "仁医 - S01E01.mkv"),
      library.id,
    ]);

    const first = await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    expect(first.shows).toBe(1);
    const second = await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    // 文件已经绑上了, 第二次没有"未绑定文件"可处理
    expect(second.shows).toBe(0);
    expect(second.files).toBe(0);
    await rt.close();
  });

  test("nfo 里没有身份 → 不猜 TMDB, 而是按标题加成本地条目", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "影视");
    const showDir = join(root, "不知道叫啥");
    await mkdir(showDir, { recursive: true });
    await writeFile(join(showDir, "tvshow.nfo"), "<tvshow><title>不知道叫啥</title></tvshow>");
    await writeFile(join(showDir, "a.mkv"), "x");

    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "影视", root, domain: "video" });
    rt.db.run("insert into media_files (path, library_id, number, size, mtime_ms, season, episode) values (?, ?, null, 1, 1, 1, 1)", [
      join(showDir, "a.mkv"),
      library.id,
    ]);

    const report = await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    // 没有 TMDB id 就不猜 TMDB 身份 —— 但标题是明确线索, 加成本地条目(UGC)
    expect(report.shows).toBe(0);
    expect(report.locals).toBe(1);
    const row = rt.db.get<{ number: string; content_type: string; title: string }>(
      "select number, content_type, title from items",
    )!;
    expect(row.number.startsWith("local:")).toBe(true);
    expect(row.number.startsWith("tmdb:")).toBe(false);
    expect(row.content_type).toBe("ugc");
    expect(row.title).toBe("不知道叫啥");
    await rt.close();
  });

  test("番号制库拒用这个入口", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "av");
    await mkdir(root, { recursive: true });
    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "av", root, domain: "av" });
    await expect(recoverFromNfo(rt, { libraryId: library.id })).rejects.toThrow(/只有影视库/);
    await rt.close();
  });
});

describe("整理之后的布局: tvshow.nfo 在剧目录, 文件在 Season 子目录", () => {
  test("Season 目录里的文件能认回剧目录", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "视频");
    const showDir = join(root, "死神 (2004)");
    const seasonDir = join(showDir, "Season 01");
    await mkdir(seasonDir, { recursive: true });
    await writeFile(join(showDir, "tvshow.nfo"), TVSHOW);
    await writeFile(join(seasonDir, "死神 - S01E01.mkv"), "x");
    await writeFile(join(seasonDir, "死神 - S01E02.mkv"), "x");

    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "视频", root, domain: "video" });
    for (const [name, episode] of [["死神 - S01E01.mkv", 1], ["死神 - S01E02.mkv", 2]] as const) {
      rt.db.run(
        "insert into media_files (path, library_id, number, size, mtime_ms, season, episode) values (?, ?, null, 1, 1, 1, ?)",
        [join(seasonDir, name), library.id, episode],
      );
    }

    // 修复前: 只看父目录(Season 01), 找不到 tvshow.nfo → 0 个剧
    const dry = await recoverFromNfo(rt, { libraryId: library.id });
    expect(dry.shows).toBe(1);
    expect(dry.files).toBe(2);
    expect(dry.needsScan).toBe(false);

    const applied = await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    expect(applied.done[0]!.key).toBe("tmdb:tv:46198");
    expect(rt.db.get<{ n: number }>("select count(*) as n from media_files where number is null")!.n).toBe(0);
    await rt.close();
  });

  test("库里一条文件都没登记时, apply 会先自动扫一遍", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "视频");
    const showDir = join(root, "仁医 (2009)");
    await mkdir(showDir, { recursive: true });
    await writeFile(join(showDir, "tvshow.nfo"), TVSHOW);
    await writeFile(join(showDir, "仁医 - S01E01.mkv"), "x");

    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "视频", root, domain: "video" });

    // 干跑: 数不出来, 但明确说"要先扫"
    const dry = await recoverFromNfo(rt, { libraryId: library.id });
    expect(dry.needsScan).toBe(true);
    expect(dry.shows).toBe(0);

    // apply: 顺手扫一遍, 再恢复
    const applied = await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    expect(applied.scanned).toBe(1);
    expect(applied.done.length).toBe(1);
    expect(rt.db.get("select 1 from media_files where number = 'tmdb:tv:46198'")).toBeTruthy();
    await rt.close();
  });
});

describe("本地条目(UGC)的身份也要能读回来", () => {
  const UGC_TVSHOW = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<tvshow>
  <title>食贫道充电视频</title>
  <plot>B站充电专属</plot>
  <uniqueid type="kura">local:食贫道充电视频</uniqueid>
</tvshow>
`;

  test("只带 <uniqueid type=kura> 的 nfo → 建成本地条目, 标 ugc", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "视频");
    const dir = join(root, "B站");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tvshow.nfo"), UGC_TVSHOW);
    await writeFile(join(dir, "投稿01.mp4"), "x");
    await writeFile(join(dir, "投稿02.mp4"), "x");

    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "视频", root, domain: "video" });
    for (const name of ["投稿01.mp4", "投稿02.mp4"]) {
      rt.db.run(
        "insert into media_files (path, library_id, number, size, mtime_ms, season, episode) values (?, ?, null, 1, 1, 1, null)",
        [join(dir, name), library.id],
      );
    }

    const dry = await recoverFromNfo(rt, { libraryId: library.id });
    expect(dry.shows).toBe(1);
    expect(dry.files).toBe(2);

    await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    const row = rt.db.get<{ number: string; content_type: string; title: string; domain: string }>(
      "select number, content_type, title, domain from items",
    )!;
    expect(row.number).toBe("local:食贫道充电视频");
    expect(row.content_type).toBe("ugc");
    expect(row.title).toBe("食贫道充电视频");
    expect(row.domain).toBe("tv");
    await rt.close();
  });

  test("写 nfo 时本地条目要带 kura 身份, TMDB 条目不带", async () => {
    const { renderTvShowNfo, renderMovieNfo } = await import("../src/domain/nfo-tv");
    const local = renderTvShowNfo({ title: "食贫道充电视频", kuraId: "local:食贫道充电视频" });
    expect(local).toContain('<uniqueid type="kura">local:食贫道充电视频</uniqueid>');
    expect(local).not.toContain('type="tmdb"');

    const tmdb = renderTvShowNfo({ title: "仁医", tmdbId: "46198" });
    expect(tmdb).toContain('<uniqueid type="tmdb" default="true">46198</uniqueid>');
    expect(tmdb).not.toContain('type="kura"');

    const movie = renderMovieNfo({ title: "本地片", kuraId: "local:本地片" });
    expect(movie).toContain('<uniqueid type="kura">local:本地片</uniqueid>');
  });
});

describe("nfo 只有标题、没有身份 → 按标题加成本地条目", () => {
  test("B站那种 tvshow.nfo（只有 title）也能恢复, 不留在未识别", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "视频");
    const dir = join(root, "B站");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tvshow.nfo"), "<tvshow><title>食贫道充电视频</title></tvshow>");
    for (const name of ["投稿01.mp4", "投稿02.mp4", "投稿03.mp4"]) await writeFile(join(dir, name), "x");

    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "视频", root, domain: "video" });
    for (const name of ["投稿01.mp4", "投稿02.mp4", "投稿03.mp4"]) {
      rt.db.run("insert into media_files (path, library_id, number, size, mtime_ms) values (?, ?, null, 1, 1)", [
        join(dir, name),
        library.id,
      ]);
    }

    const dry = await recoverFromNfo(rt, { libraryId: library.id });
    expect(dry.locals).toBe(1);
    expect(dry.files).toBe(3);
    expect(dry.noTmdbId).toEqual([]);

    const applied = await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    expect(applied.done[0]!.local).toBe(true);
    expect(applied.done[0]!.key.startsWith("local:")).toBe(true);

    const row = rt.db.get<{ content_type: string; title: string; domain: string }>(
      "select content_type, title, domain from items",
    )!;
    expect(row.content_type).toBe("ugc");
    expect(row.title).toBe("食贫道充电视频");
    expect(row.domain).toBe("tv");
    expect(rt.db.get<{ n: number }>("select count(*) as n from media_files where number is null")!.n).toBe(0);

    // 再跑一次: 文件都绑上了, 没有新东西
    expect((await recoverFromNfo(rt, { libraryId: library.id })).files).toBe(0);
    await rt.close();
  });

  test("连 title 都没有才进 noTmdbId", async () => {
    const dataDir = await scratch();
    const root = join(dataDir, "视频");
    const dir = join(root, "空壳");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tvshow.nfo"), "<tvshow></tvshow>");
    await writeFile(join(dir, "a.mp4"), "x");

    const rt = await openRuntime({ dataDir });
    const library = createLibrary(rt.db, { name: "视频", root, domain: "video" });
    rt.db.run("insert into media_files (path, library_id, number, size, mtime_ms) values (?, ?, null, 1, 1)", [
      join(dir, "a.mp4"),
      library.id,
    ]);

    const report = await recoverFromNfo(rt, { libraryId: library.id, apply: true });
    expect(report.locals).toBe(0);
    expect(report.noTmdbId.length).toBe(1);
    expect(rt.db.get("select 1 from items")).toBeFalsy();
    await rt.close();
  });
});
