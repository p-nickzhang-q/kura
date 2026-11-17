import { describe, expect, test } from "bun:test";
import { COVER_SCORE, correlation, cropHalf, guessCoverHalf, type Rgba } from "../src/domain/crop";

/**
 * 合成一张 RGBA 图。`paint` 收到 0..1 的归一化坐标, 返回 0..255 的灰度值。
 * 用灰度就够 —— 判定逻辑只看亮度构图。
 */
function make(width: number, height: number, paint: (u: number, v: number) => number): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.max(0, Math.min(255, Math.round(paint(x / width, y / height))));
      const i = (y * width + x) * 4;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** 左=竖条纹(封底的小剧照阵列), 右=一个大圆(封面)。 */
function panoramaWithCoverOnRight(width = 800, height = 537): Rgba {
  return make(width, height, (u, v) => {
    if (u < 0.5) {
      // 左半: 密集小方块, 模拟封底的剧照阵列
      const cell = Math.floor(u * 20) + Math.floor(v * 14);
      return cell % 2 === 0 ? 40 : 210;
    }
    // 右半: 中央一个亮圆 + 四周暗, 模拟"一张大照片"
    const cx = 0.75;
    const cy = 0.45;
    const distance = Math.hypot((u - cx) * 1.4, v - cy);
    return distance < 0.3 ? 200 - distance * 200 : 30;
  });
}

/** 把右半缩出来当缩略图, 就是站点给的 `ps.jpg`。 */
function thumbOfRight(panorama: Rgba, width = 147, height = 200): Rgba {
  const halfWidth = panorama.width / 2;
  return make(width, height, (u, v) => {
    const px = Math.min(panorama.width - 1, Math.floor(panorama.width / 2 + u * halfWidth));
    const py = Math.min(panorama.height - 1, Math.floor(v * panorama.height));
    return panorama.data[(py * panorama.width + px) * 4]!;
  });
}

describe("correlation", () => {
  test("同一个网格是 1", () => {
    const a = new Float32Array([1, 5, 3, 8, 2]);
    expect(correlation(a, a)).toBeCloseTo(1, 6);
  });

  test("线性反向是 -1", () => {
    const a = new Float32Array([1, 2, 3, 4]);
    const b = new Float32Array([4, 3, 2, 1]);
    expect(correlation(a, b)).toBeCloseTo(-1, 6);
  });

  test("平涂无方差时返回 0 而不是 NaN", () => {
    const flat = new Float32Array([7, 7, 7, 7]);
    const other = new Float32Array([1, 2, 3, 4]);
    expect(correlation(flat, other)).toBe(0);
  });
});

describe("guessCoverHalf", () => {
  test("封面在右半时判 right", () => {
    const panorama = panoramaWithCoverOnRight();
    const guess = guessCoverHalf(panorama, thumbOfRight(panorama));
    expect(guess).not.toBeNull();
    expect(guess!.half).toBe("right");
    expect(guess!.right).toBeGreaterThan(guess!.left);
    // 判定要留足余量, 不能是"差点就反了"
    expect(guess!.right - guess!.left).toBeGreaterThan(COVER_SCORE.margin);
  });

  test("封面在左半时判 left —— 不能写死右边", () => {
    const right = panoramaWithCoverOnRight();
    const flipped = make(right.width, right.height, (u, v) => {
      const px = Math.min(right.width - 1, Math.floor((1 - u) * right.width));
      const py = Math.min(right.height - 1, Math.floor(v * right.height));
      return right.data[(py * right.width + px) * 4]!;
    });
    const coverOnLeft = make(flipped.width, flipped.height, (u, v) => {
      const px = Math.min(flipped.width - 1, Math.floor(u * flipped.width));
      const py = Math.min(flipped.height - 1, Math.floor(v * flipped.height));
      return flipped.data[(py * flipped.width + px) * 4]!;
    });
    // 镜像后的图, 封面现在在左
    const thumb = make(147, 200, (u, v) => {
      const px = Math.min(coverOnLeft.width - 1, Math.floor(u * (coverOnLeft.width / 2)));
      const py = Math.min(coverOnLeft.height - 1, Math.floor(v * coverOnLeft.height));
      return coverOnLeft.data[(py * coverOnLeft.width + px) * 4]!;
    });
    expect(guessCoverHalf(coverOnLeft, thumb)?.half).toBe("left");
  });

  test("竖版图不是展开图, 直接不判", () => {
    const portrait = make(400, 537, (u, v) => (u + v) * 120);
    expect(guessCoverHalf(portrait, thumbOfRight(portrait))).toBeNull();
  });

  test("两半一样(对称构图)时拒绝裁 —— 宁可糊也不要裁错", () => {
    const symmetric = make(800, 400, (u, v) => Math.abs(v - 0.5) * 400 + (u < 0.5 ? 0 : 0));
    expect(guessCoverHalf(symmetric, thumbOfRight(symmetric))).toBeNull();
  });

  test("缩略图与展开图完全无关时不猜", () => {
    const panorama = panoramaWithCoverOnRight();
    const unrelated = make(147, 200, (u, v) => ((u * 7 + v * 13) % 1) * 255);
    expect(guessCoverHalf(panorama, unrelated)).toBeNull();
  });
});

describe("cropHalf", () => {
  test("右半: 宽度减半, 像素是原图右半边", () => {
    const panorama = panoramaWithCoverOnRight(800, 537);
    const cut = cropHalf(panorama, "right");
    expect(cut.width).toBe(400);
    expect(cut.height).toBe(537);
    // 取裁切图左上角, 应等于原图 (400, 0)
    const source = (0 * panorama.width + 400) * 4;
    expect(Array.from(cut.data.slice(0, 4))).toEqual(Array.from(panorama.data.slice(source, source + 4)));
  });

  test("左半: 从第 0 列开始", () => {
    const panorama = panoramaWithCoverOnRight(800, 537);
    const cut = cropHalf(panorama, "left");
    expect(cut.width).toBe(400);
    expect(Array.from(cut.data.slice(0, 4))).toEqual(Array.from(panorama.data.slice(0, 4)));
  });

  test("奇数列宽时右半取整后仍然对齐", () => {
    const odd = make(801, 400, (u) => u * 255);
    const cut = cropHalf(odd, "right");
    expect(cut.width).toBe(400);
    expect(cut.height).toBe(400);
    expect(cut.data.length).toBe(400 * 400 * 4);
  });
});
