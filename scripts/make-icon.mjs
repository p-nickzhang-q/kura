// 生成应用图标: 圆形胶片盘一摞(上层亮蓝 + 右下错位灰蓝), 中轴方孔 + 6 个齿孔。
//
// 设计过程走的是豆包(5 轮): 三条横线 → 胶片格 → 一摞胶片盘 → 加齿孔 → **换圆形**。
// 第 4 轮那个"三块圆角方块堆叠"自己看着像一摞卡片/小机器, 不像影片; 第 5 轮把主体改成
// 圆盘才立住 —— 胶片盘本来就是圆的。豆包那边出的是位图(边缘有伪影、齿孔位置不齐、缩小会糊),
// 所以设计定下来之后由这里用归一化坐标 + 超采样重绘, 一套几何生成所有尺寸。
//
// 为什么是"两个圆错位"而不是一个: 单圆读作"胶卷", 加一个错位的暗圆才读作"库里有不止一盘",
// 这是这个词义的全部来源, 不能省。
//
// 不引任何依赖: 手写 PNG 编码(只用 zlib.deflateSync) 与 ICO 容器。
// 用法: node scripts/make-icon.mjs
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");

/** 底板: 极细渐变, 顶上略亮 —— 纯平色在大尺寸下会显得像贴图而不是材质。 */
const BG_TOP = [21, 24, 30];
const BG_BOTTOM = [13, 15, 19];
/** 上层盘面: 主强调色, 与界面里的 --accent 一致。 */
const FACE = [91, 140, 255];
/** 下层盘面: 灰蓝。压得比 #7A8AA0 暗一档, 否则会和上层抢视觉重量。 */
const BEHIND = [104, 120, 143];
/** 左上外缘的高光弧, 只有这一个光源。 */
const HILITE = [150, 184, 255];

/** 盘面半径。直径 52% —— 再大就没有留白, 再小齿孔会挤。 */
const R = 0.26;
/** 两层之间的错位: 只露出约 6% 的一弯, 是"一摞"不是"两个球"。 */
const OFF = 0.045;
/** 中轴孔半径, 相对盘面半径。真实胶片盘的中轴孔大约就是这个比例。 */
const HUB = 0.26;
/** 齿孔: 分布在 R 的这个比例的圆周上, 正放(不跟着角度旋转)。 */
const PEG_RING = 0.62;
const PEG = 0.085;
/** 齿孔数量。6 个是能在小尺寸下分开的最大值。 */
const PEG_COUNT = 6;
/** 高光弧的带宽, 相对盘面半径。 */
const HL = 0.045;

/** 点是否落在圆角矩形内。参数全部是 0..1 的归一化坐标。 */
function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * 小尺寸要另一套参数。
 *
 * 16px 下盘面只有 8 个像素宽, 6 个齿孔全糊在一起, 反而把"圆盘"这个唯一识别特征弄脏。
 * 所以 32px 及以下: 丢掉齿孔, 放大错位与高光, 让"圆盘 + 中轴孔 + 一摞"留在轮廓上。
 * 这不是缩图, 是同一套设计的小尺寸版本。
 */
function geometry(size) {
  const small = size <= 32;
  return {
    small,
    pad: small ? 0.14 : 0.22,
    off: small ? 0.055 : OFF,
    pegs: !small,
    highlight: true,
  };
}

/** 归一化坐标取色。返回 [r,g,b,a], 圆角外是全透明。 */
function sample(u, v, g) {
  if (!inRoundRect(u, v, 0, 0, 1, 1, g.pad)) return [0, 0, 0, 0];
  const bg = mix(BG_TOP, BG_BOTTOM, v);

  const cx = 0.5;
  const cy = 0.5;

  const dx = u - cx;
  const dy = v - cy;
  const dist = Math.hypot(dx, dy);

  // 上层盘盖住下层, 所以先判上层; 不在上层圆内才轮到下层那个错位的暗圆
  if (dist > R) {
    const behindX = cx + g.off;
    const behindY = cy + g.off;
    if ((u - behindX) ** 2 + (v - behindY) ** 2 <= R * R) {
      // 露出来的一弯给一点点渐变, 免得像贴上去的色块
      return [...mix(BEHIND, [88, 102, 122], (v - (cy - R)) / (2 * R)), 255];
    }
    return [...bg, 255];
  }

  // 中轴孔
  if (dist <= R * HUB) return [...bg, 255];

  // 齿孔: 正放的方块, 中心落在 PEG_RING 的圆周上
  if (g.pegs) {
    for (let i = 0; i < PEG_COUNT; i++) {
      const angle = (i * 2 * Math.PI) / PEG_COUNT - Math.PI / 2;
      const px = cx + Math.cos(angle) * R * PEG_RING;
      const py = cy + Math.sin(angle) * R * PEG_RING;
      const half = R * PEG;
      if (Math.abs(u - px) <= half && Math.abs(v - py) <= half) return [...bg, 255];
    }
  }

  // 左上外缘的高光弧: 只看角度 180°..270° 那一象限
  if (g.highlight && dist > R * (1 - HL)) {
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180
    const deg = angle < 0 ? angle + 360 : angle;
    if (deg > 178 && deg < 272) {
      // 弧的两端要淡出去, 否则会有一道生硬的切口
      const fade = Math.min(1, Math.min(deg - 178, 272 - deg) / 22);
      return [...mix(FACE, HILITE, fade), 255];
    }
  }

  return [...FACE, 255];
}

/** 超采样绘制: 每个输出像素取 SUB×SUB 个样本求平均。小尺寸能看清的关键。 */
const SUB = 4;

function draw(size) {
  const pixels = new Uint8Array(size * size * 4);
  const g = geometry(size);
  const step = 1 / (size * SUB);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const [sr, sg, sb, sa] = sample((x * SUB + sx + 0.5) * step, (y * SUB + sy + 0.5) * step, g);
          // 透明样本只累加 alpha, 不把颜色拉黑
          if (sa === 0) continue;
          sumR += sr;
          sumG += sg;
          sumB += sb;
          sumA += sa;
        }
      }
      if (sumA === 0) continue;
      const offset = (y * size + x) * 4;
      // 颜色只对"有覆盖的样本"求平均, 覆盖率单独算 —— 否则圆角边上会发黑
      const covered = sumA / 255;
      pixels[offset] = Math.round(sumR / covered);
      pixels[offset + 1] = Math.round(sumG / covered);
      pixels[offset + 2] = Math.round(sumB / covered);
      pixels[offset + 3] = Math.round(sumA / (SUB * SUB));
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * ICO 容器, 多尺寸。
 *
 * 每个尺寸都**单独绘制**而不是缩同一张大图 —— 16px 有自己的几何(见 geometry), 这是任务栏
 * 与标题栏不糊的原因。Windows Vista 起支持 PNG 帧, 各尺寸都用 PNG 存(体积也更小)。
 */
function encodeIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);

  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const { png, size } of frames) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.png)]);
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ico = encodeIco(ICO_SIZES.map((size) => ({ size, png: encodePng(draw(size), size) })));

const targets = [assets, join(root, "apps", "desktop", "build")];
for (const dir of targets) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "icon.ico"), ico);
  await writeFile(join(dir, "icon.png"), encodePng(draw(512), 512));
}
await writeFile(join(assets, "app.ico"), ico);
console.log(`图标已生成: ${join(assets, "app.ico")} / icon.png (ico ${ICO_SIZES.length} 个尺寸)`);
