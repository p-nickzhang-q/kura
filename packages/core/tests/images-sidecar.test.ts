import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRuntime } from "../src/runtime";
import { createLibrary } from "../src/db/rows";
import { scan } from "../src/tasks/scan";
import { placeImagesBesideVideo } from "../src/tasks/resources";
import { listItems, countItems, getItem, isItemSortField } from "../src/tasks/scrape";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kura-sidecar-"));
  const media = join(dir, "media");
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, "SSIS-100.mkv"), "video");
  writeFileSync(join(media, "SSIS-100-cd2.mp4"), "video2");
  return { dir, media };
}

describe("图片复制到视频旁边", () => {
  test("同一部的每个文件都放一份, 命名与侧图规则一致", async () => {
    const { dir, media } = setup();
    const rt = await openRuntime({ dataDir: join(dir, "data") });
    const library = createLibrary(rt.db, { name: "库", root: media });
    await scan(rt, { library });

    const posterSource = join(dir, "poster-src.jpg");
    const thumbSource = join(dir, "thumb-src.jpg");
    writeFileSync(posterSource, "poster-bytes");
    writeFileSync(thumbSource, "thumb-bytes");

    const result = await placeImagesBesideVideo(
      rt,
      getItem(rt, "SSIS-100")!,
      {
        poster: { url: "u1", path: posterSource, contentType: "image/jpeg", size: 12 },
        thumb: { url: "u2", path: thumbSource, contentType: "image/jpeg", size: 11 },
      },
    );

    expect(result.errors).toEqual([]);
    expect(existsSync(join(media, "SSIS-100-poster.jpg"))).toBe(true);
    expect(existsSync(join(media, "SSIS-100-thumb.jpg"))).toBe(true);
    expect(existsSync(join(media, "SSIS-100-cd2-poster.jpg"))).toBe(true);

    // 再复制一次: 大小相同就跳过, 不反复写盘
    const again = await placeImagesBesideVideo(rt, getItem(rt, "SSIS-100")!, {
      poster: { url: "u1", path: posterSource, contentType: "image/jpeg", size: 12 },
    });
    expect(again.saved).toEqual([]);
    expect(again.skipped.length).toBe(2);

    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("没有登记文件时安静地什么都不做", async () => {
    const { dir, media } = setup();
    const rt = await openRuntime({ dataDir: join(dir, "data") });
    createLibrary(rt.db, { name: "库", root: media });
    const result = await placeImagesBesideVideo(
      rt,
      { key: "NOPE-999", number: "NOPE-999", contentType: "censored" } as never,
      { poster: { url: "u", path: "/不存在.jpg", contentType: "image/jpeg", size: 1 } },
    );
    expect(result.saved).toEqual([]);
    expect(result.errors).toEqual([]);
    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("按刮削状态筛选", () => {
  test("unscraped 只看没标题的, scraped 只看有标题的", async () => {
    const { dir, media } = setup();
    const rt = await openRuntime({ dataDir: join(dir, "data") });
    const library = createLibrary(rt.db, { name: "库", root: media });
    await scan(rt, { library });
    rt.db.run("update items set title = '有标题了' where number = 'SSIS-100'");

    expect(countItems(rt, { state: "unscraped" })).toBe(0);
    expect(countItems(rt, { state: "scraped" })).toBe(1);
    expect(countItems(rt, {})).toBe(1);

    rt.db.run("update items set title = null where number = 'SSIS-100'");
    expect(countItems(rt, { state: "unscraped" })).toBe(1);
    expect(listItems(rt, { state: "scraped" })).toEqual([]);

    // 失败到上限的是"未刮削"的子集, 不是互斥的另一类 ——
    // 用户视角是"这条还没有元数据", 至于会不会自动重试是另一件事。
    rt.db.run("update items set scrape_attempts = 3 where number = 'SSIS-100'");
    expect(countItems(rt, { state: "exhausted" })).toBe(1);
    expect(countItems(rt, { state: "unscraped" })).toBe(1);

    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("列表排序", () => {
  test("按标题升序时, 空标题排最后 (不让未刮削占满第一页)", async () => {
    const { dir, media } = setup();
    const rt = await openRuntime({ dataDir: join(dir, "data") });
    const library = createLibrary(rt.db, { name: "库", root: media });
    await scan(rt, { library });
    // setup() 造了 SSIS-100 两个文件, 再加一个有标题的条目
    rt.db.run("update items set title = 'B 标题', release_date = '2024-02-01' where number = 'SSIS-100'");
    rt.db.run(
      "insert into items (number, content_type, title, release_date, updated_at) values ('SSIS-050', 'censored', 'A 标题', null, unixepoch())",
    );

    const byTitle = listItems(rt, { sort: { field: "title" } });
    expect(byTitle.map((item) => item.number)).toEqual(["SSIS-050", "SSIS-100"]);

    const byTitleDesc = listItems(rt, { sort: { field: "title", desc: true } });
    expect(byTitleDesc.map((item) => item.number)).toEqual(["SSIS-100", "SSIS-050"]);

    // 空 release_date 一样沉底
    const byRelease = listItems(rt, { sort: { field: "release" } });
    expect(byRelease.map((item) => item.number)).toEqual(["SSIS-100", "SSIS-050"]);

    rt.db.run("update items set title = null where number = 'SSIS-050'");
    expect(listItems(rt, { sort: { field: "title" } }).map((item) => item.number)).toEqual(["SSIS-100", "SSIS-050"]);

    rt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("排序字段来自白名单", async () => {
    expect(isItemSortField("title")).toBe(true);
    expect(isItemSortField("updated")).toBe(true);
    // 直接传列名不合法: 字段名会拼进 SQL
    expect(isItemSortField("title; drop table items")).toBe(false);
    expect(isItemSortField("id")).toBe(false);
  });
});
