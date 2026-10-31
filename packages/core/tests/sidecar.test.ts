import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSidecarImages } from "../src/tasks/resources";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kura-sidecar-"));
  await mkdir(join(root, "sub"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findSidecarImages", () => {
  test("认得 <视频名>-poster / -thumb", async () => {
    await writeFile(join(root, "ABC-123.mkv"), "v");
    await writeFile(join(root, "ABC-123-poster.jpg"), "p");
    await writeFile(join(root, "ABC-123-thumb.png"), "t");

    const found = findSidecarImages(join(root, "ABC-123.mkv"));
    expect(found.poster).toBe(join(root, "ABC-123-poster.jpg"));
    expect(found.thumb).toBe(join(root, "ABC-123-thumb.png"));
  });

  test("认得同名的 <视频名>.jpg 与 poster/folder", async () => {
    await writeFile(join(root, "ABC-123.mp4"), "v");
    await writeFile(join(root, "ABC-123.jpg"), "p");
    expect(findSidecarImages(join(root, "ABC-123.mp4")).poster).toBe(join(root, "ABC-123.jpg"));

    await writeFile(join(root, "poster.jpg"), "p");
    expect(findSidecarImages(join(root, "XYZ-001.mp4")).poster).toBe(join(root, "poster.jpg"));
  });

  test("同一目录下的 poster.jpg / fanart.jpg / thumb.jpg 三张都能用", async () => {
    await writeFile(join(root, "ABC-123.mkv"), "v");
    await writeFile(join(root, "poster.jpg"), "p");
    await writeFile(join(root, "fanart.jpg"), "f");
    await writeFile(join(root, "thumb.jpg"), "t");

    const found = findSidecarImages(join(root, "ABC-123.mkv"));
    expect(found.poster).toBe(join(root, "poster.jpg"));
    // thumb.jpg 名字最贴切, 优先于 fanart
    expect(found.thumb).toBe(join(root, "thumb.jpg"));
  });

  test("大小写不敏感: POSTER.JPG / Fanart.PNG 也认", async () => {
    await writeFile(join(root, "ABC-123.mkv"), "v");
    await writeFile(join(root, "POSTER.JPG"), "p");
    await writeFile(join(root, "Fanart.PNG"), "f");

    const found = findSidecarImages(join(root, "ABC-123.mkv"));
    expect(found.poster).toBe(join(root, "POSTER.JPG"));
    expect(found.thumb).toBe(join(root, "Fanart.PNG"));
  });

  test("没有图就返回 null, 不猜别的目录", async () => {
    await writeFile(join(root, "ABC-123.mkv"), "v");
    await writeFile(join(root, "sub", "ABC-123-poster.jpg"), "p");
    const found = findSidecarImages(join(root, "ABC-123.mkv"));
    expect(found.poster).toBeNull();
    expect(found.thumb).toBeNull();
  });
});
