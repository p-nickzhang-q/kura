/**
 * 从「DVD 包装展开图」里挑出封面那一半。
 *
 * 为什么需要: DMM 系图片站能给的最大竖版图只有 147×200 (`ps.jpg`), 大图是
 * 800×537 的 panorama (`pl.jpg`) —— 左封底 + 右封面平铺, 带条码和 DVD 标。
 * 把它当海报塞进 Emby, 2:3 的槽位会把两侧都裁掉, 只剩中间接缝, 于是 Kura 和
 * Emby 显示的都是"一脸小剧照拼出来的东西"。
 *
 * 哪半是封面**不能写死**: 实测 6 个样本 5 个在右、SONE-682 在左, 而且展开图
 * 尺寸也不统一 (800×537 与 800×600 都有)。但也不必猜 —— 小图就是封面的缩略,
 * 哪半与它相关度高就取哪半 (实测 0.51~0.80 对 ≤0.24, 差距极大)。
 *
 * 纯函数: 输入已解码的 RGBA 与尺寸, 不解 JPEG、不碰文件, 这样才能用合成图
 * 穷举测试判定逻辑。
 */

/** 比对网格的边长。再大也不会更准 —— 相关性只看构图。 */
const GRID_COLS = 24;
const GRID_ROWS = 32;

export type Half = "left" | "right";

export interface CoverGuess {
  /** 判定出的封面所在半边。 */
  half: Half;
  /** 两半各自与缩略图的相关系数, 给日志与测试看。 */
  left: number;
  right: number;
}

/**
 * 判定的门槛。两边都低 = 缩略图与展开图不是同一张 (镜像/换了图);
 * 两边都高 = 对称构图, 裁哪边都可能错。这两种情况都返回 null, 让调用方
 * 退回用缩略图本身 —— 宁可糊一点, 也不要裁错。
 */
export const COVER_SCORE = {
  /**
   * 胜出的一半至少要有这么相关。
   *
   * 低到 0.12 是因为有一个真实样本只有 0.24 的左半、-0.07 的右半 —— 绝对值不高,
   * 但“另一半是负相关”本身就说明它不可能是同一张图。真正的无关图两半都接近 0,
   * 过不了下面的 margin。
   */
  min: 0.12,
  /** 并且要比另一半高这么多。 */
  margin: 0.15,
} as const;

export interface Rgba {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * 取一块矩形区域, 降采样成 `GRID_COLS × GRID_ROWS` 的灰度网格。
 *
 * 用均值而不是抽点: 缩略图与展开图的分辨率差 5 倍, 抽点会撞上压缩噪点,
 * 均值才稳定 (实测比抽点高 0.1 左右的相关度)。
 */
function grayGrid(image: Rgba, left: number, top: number, boxWidth: number, boxHeight: number): Float32Array {
  const grid = new Float32Array(GRID_COLS * GRID_ROWS);
  const stepX = boxWidth / GRID_COLS;
  const stepY = boxHeight / GRID_ROWS;

  for (let row = 0; row < GRID_ROWS; row++) {
    const y0 = Math.floor(top + row * stepY);
    const y1 = Math.max(y0 + 1, Math.floor(top + (row + 1) * stepY));
    for (let col = 0; col < GRID_COLS; col++) {
      const x0 = Math.floor(left + col * stepX);
      const x1 = Math.max(x0 + 1, Math.floor(left + (col + 1) * stepX));

      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < image.height; y++) {
        for (let x = x0; x < x1 && x < image.width; x++) {
          const i = (y * image.width + x) * 4;
          sum += 0.299 * image.data[i]! + 0.587 * image.data[i + 1]! + 0.114 * image.data[i + 2]!;
          count++;
        }
      }
      grid[row * GRID_COLS + col] = count > 0 ? sum / count : 0;
    }
  }
  return grid;
}

/** 皮尔逊相关系数。任一网格无方差时返回 0 (平涂的图本来就没法判)。 */
export function correlation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;

  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i]!;
    sumB += b[i]!;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA < 1e-9 || varB < 1e-9) return 0;
  return cov / Math.sqrt(varA * varB);
}

/**
 * 判封面在哪半。展不成横图、或证据不足时返回 null。
 *
 * `panorama` 必须是**横向**的 (宽 > 高); 竖版图本来就不是展开图, 调用方不该进这里。
 */
export function guessCoverHalf(panorama: Rgba, thumb: Rgba): CoverGuess | null {
  if (panorama.width <= panorama.height) return null;
  if (thumb.width === 0 || thumb.height === 0) return null;

  const halfWidth = panorama.width / 2;
  const left = grayGrid(panorama, 0, 0, halfWidth, panorama.height);
  const right = grayGrid(panorama, halfWidth, 0, halfWidth, panorama.height);
  const reference = grayGrid(thumb, 0, 0, thumb.width, thumb.height);

  const leftScore = correlation(left, reference);
  const rightScore = correlation(right, reference);
  const guess: CoverGuess = { half: rightScore > leftScore ? "right" : "left", left: leftScore, right: rightScore };

  const best = Math.max(leftScore, rightScore);
  const worst = Math.min(leftScore, rightScore);
  if (best < COVER_SCORE.min || best - worst < COVER_SCORE.margin) return null;
  return guess;
}

/** 裁出半边, 返回新的 RGBA。用于真正生成海报文件。 */
export function cropHalf(image: Rgba, half: Half): Rgba {
  const halfWidth = Math.floor(image.width / 2);
  const startX = half === "left" ? 0 : image.width - halfWidth;
  const out = new Uint8Array(halfWidth * image.height * 4);

  for (let y = 0; y < image.height; y++) {
    const from = (y * image.width + startX) * 4;
    const to = y * halfWidth * 4;
    out.set(image.data.subarray(from, from + halfWidth * 4), to);
  }
  return { data: out, width: halfWidth, height: image.height };
}
