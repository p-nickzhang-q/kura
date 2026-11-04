import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, findLibrary } from "../src/db/rows";
import { openRuntime, type Runtime } from "../src/runtime";
import { bindDirectory } from "../src/tasks/bind";
import { scan } from "../src/tasks/scan";
import { exportTvNfo } from "../src/tasks/nfo-tv";
import { mergeTvNfo, renderEpisodeNfo, renderTvShowNfo } from "../src/domain/nfo-tv";

let root: string;
let rt: Runtime;
let media: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-nfotv-"));
  rt = await openRuntime({ dataDir: join(root, "data") });
  media = join(root, "media");
  await mkdir(media, { recursive: true });
});

afterEach(async () => {
  rt.close();
  await rm(root, { recursive: true, force: true });
});

describe("渲染", () => {
  test("剧级: 标题/原名/首播日/电视台/题材/演员/tmdb id", () => {
    const xml = renderTvShowNfo({
      title: "示例剧名",
      originalTitle: "Example Show",
      plot: "简介 & 特殊字符 <test>",
      premiered: "2013-04-07",
      studio: "示例台",
      genres: ["动画", "动画"],
      actors: ["演员甲"],
      tmdbId: "1399",
    });
    expect(xml).toContain("<tvshow>");
    expect(xml).toContain("<title>示例剧名</title>");
    expect(xml).toContain("<originaltitle>Example Show</originaltitle>");
    // 转义: & 与尖括号不能破坏 XML
    expect(xml).toContain("简介 &amp; 特殊字符 &lt;test&gt;");
    // 题材去重
    expect(xml.match(/<genre>/g)).toHaveLength(1);
    expect(xml).toContain('<uniqueid type="tmdb">1399</uniqueid>');
    expect(xml).toContain("<actor>");
  });

  test("集级: 有 season/episode, 时长 0 不写", () => {
    const xml = renderEpisodeNfo({ title: "第一集", season: 1, episode: 2, runtimeMin: 0, aired: "2013-04-14" });
    expect(xml).toContain("<episodedetails>");
    expect(xml).toContain("<season>1</season>");
    expect(xml).toContain("<episode>2</episode>");
    expect(xml).not.toContain("<runtime>");
  });
});

describe("字段级合并", () => {
  const existing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow>
  <title>旧标题</title>
  <mpaa>TV-MA</mpaa>
  <art><poster>poster.jpg</poster></art>
  <genre>480P</genre>
  <actor><name>旧演员</name><role>主角</role></actor>
</tvshow>`;

  test("只改我们管的字段, 别的工具写的元素保住", () => {
    const { content, changed } = mergeTvNfo(existing, "tvshow", { title: "新标题", genres: ["动画"], actors: ["新演员"] });
    expect(changed.length).toBeGreaterThan(0);
    expect(content).toContain("<title>新标题</title>");
    // 不可逆的东西必须留着
    expect(content).toContain("<mpaa>TV-MA</mpaa>");
    expect(content).toContain("<poster>poster.jpg</poster>");
    // 题材并集: 别的工具写的 480P 不能被删
    expect(content).toContain("<genre>480P</genre>");
    expect(content).toContain("<genre>动画</genre>");
    // 演员就地改名, 保住 <role>
    expect(content).toContain("<name>新演员</name>");
    expect(content).toContain("<role>主角</role>");
  });

  test("没有差异时返回 changed: [] (调用方据此不写盘)", () => {
    const once = mergeTvNfo(existing, "tvshow", { title: "新标题" });
    const twice = mergeTvNfo(once.content, "tvshow", { title: "新标题" });
    expect(twice.changed).toEqual([]);
  });

  test("根元素不对就不动 (在剧目录里放了一份 <movie>)", () => {
    const movie = "<movie><title>x</title></movie>";
    expect(mergeTvNfo(movie, "tvshow", { title: "新标题" }).changed).toEqual([]);
  });

  test("中文不写成实体", () => {
    const { content } = mergeTvNfo("<episodedetails><title>a</title></episodedetails>", "episodedetails", {
      title: "致两千年后的你",
      season: 1,
      episode: 1,
    });
    expect(content).toContain("致两千年后的你");
    expect(content).not.toContain("&#x");
  });
});

describe("导出到磁盘", () => {
  async function setup(): Promise<{ libraryId: number; showDir: string }> {
    const dir = join(media, "某剧 (2019)", "Season 01");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "某剧 - S01E01.mkv"), "x");
    await writeFile(join(dir, "某剧 - S01E02.mkv"), "x");
    const library = createLibrary(rt.db, { name: "剧库", root: media, domain: "video" });
    await scan(rt, { library });
    bindDirectory(rt, { libraryId: library.id, dir: join(media, "某剧 (2019)"), key: "tmdb:tv:1399" });

    rt.db.run("update items set title = '示例剧名', title_original = 'Example', plot = '简介', studio = '示例台' where number = 'tmdb:tv:1399'");
    // 绑定已经建过集行, 这里只补集名 (真实流程里来自刮削)
    rt.db.run("update episodes set title = '第一集' where number = 'tmdb:tv:1399' and season = 1 and episode = 1");
    rt.db.run("update episodes set title = '第二集' where number = 'tmdb:tv:1399' and season = 1 and episode = 2");
    return { libraryId: library.id, showDir: join(media, "某剧 (2019)") };
  }

  test("干跑只出清单, 不写文件", async () => {
    const { libraryId } = await setup();
    const report = await exportTvNfo(rt, { libraryId, apply: false });
    expect(report.created).toBe(3); // tvshow.nfo + 两个集 nfo
    expect(report.entries.filter((entry) => entry.kind === "tvshow")).toHaveLength(1);
    await expect(readFile(join(media, "某剧 (2019)", "tvshow.nfo"), "utf8")).rejects.toThrow();
  });

  test("--apply 后写出 tvshow.nfo 与每个集各一个 nfo", async () => {
    const { libraryId, showDir } = await setup();
    const report = await exportTvNfo(rt, { libraryId, apply: true });
    expect(report.created).toBe(3);

    const show = await readFile(join(showDir, "tvshow.nfo"), "utf8");
    expect(show).toContain("<tvshow>");
    expect(show).toContain("<title>示例剧名</title>");
    expect(show).toContain('<uniqueid type="tmdb">1399</uniqueid>');

    const episode = await readFile(join(showDir, "Season 01", "某剧 - S01E01.nfo"), "utf8");
    expect(episode).toContain("<episodedetails>");
    expect(episode).toContain("<title>第一集</title>");
    expect(episode).toContain("<episode>1</episode>");
  });

  test("再跑一次: 全部 skip (不抖 mtime, 不重复写)", async () => {
    const { libraryId } = await setup();
    await exportTvNfo(rt, { libraryId, apply: true });
    const second = await exportTvNfo(rt, { libraryId, apply: true });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(3);
  });

  test("用户在 nfo 里加的东西不会被抹掉", async () => {
    const { libraryId, showDir } = await setup();
    await writeFile(
      join(showDir, "tvshow.nfo"),
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<tvshow><title>旧名</title><mpaa>TV-MA</mpaa><art><poster>p.jpg</poster></art></tvshow>`,
      "utf8",
    );
    await exportTvNfo(rt, { libraryId, apply: true });
    const content = await readFile(join(showDir, "tvshow.nfo"), "utf8");
    expect(content).toContain("<title>示例剧名</title>");
    expect(content).toContain("<mpaa>TV-MA</mpaa>");
    expect(content).toContain("<poster>p.jpg</poster>");
  });

  test("认不出集号的文件不生成集 nfo", async () => {
    const { libraryId, showDir } = await setup();
    await writeFile(join(showDir, "Season 01", "特典映像.mkv"), "x");
    // 重扫一次把它登记进来(它没有集号, 所以不会有 episodes 行)
    await scan(rt, { library: findLibrary(rt.db, String(libraryId))! });
    await exportTvNfo(rt, { libraryId, apply: true });
    await expect(readFile(join(showDir, "Season 01", "特典映像.nfo"), "utf8")).rejects.toThrow();
  });
});
