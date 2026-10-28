// 生成占位图标: 深色背景 + 三条强调色横线(书架)。
// 不引任何依赖: 手写 PNG 编码(无压缩预判, 只用 zlib.deflateSync) 与 ICO 容器。
// 用法: node scripts/make-icon.mjs
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");

const BG = [15, 17, 21, 255];
const ACCENT = [91, 140, 255, 255];
const SOFT = [120, 130, 150, 255];

function draw(size) {
  const pixels = new Uint8Array(size * size * 4);
  const bars = [
    { y: 0.32, w: 0.62, color: ACCENT },
    { y: 0.5, w: 0.44, color: SOFT },
    { y: 0.68, w: 0.54, color: ACCENT },
  ];
  const radius = Math.round(size * 0.22);
  const thickness = Math.round(size * 0.07);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      let color = BG;
      // 圆角矩形裁剪: 落在圆角外的像素写成背景色, 保留方形画布
      if (!insideRounded(x, y, size, radius)) color = BG;
      for (const bar of bars) {
        const top = Math.round(size * bar.y);
        const left = Math.round(size * 0.19);
        const width = Math.round(size * bar.w);
        if (y >= top && y < top + thickness && x >= left && x < left + width) color = bar.color;
      }
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
  return pixels;
}

function insideRounded(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
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

/** ICO 容器: Windows 接受 256×256 用 PNG 压缩存放。 */
function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, png]);
}

const targets = [assets, join(root, "apps", "desktop", "build")];
for (const dir of targets) {
  await mkdir(dir, { recursive: true });
  const png256 = encodePng(draw(256), 256);
  await writeFile(join(dir, "icon.ico"), encodeIco(png256, 256));
  await writeFile(join(dir, "icon.png"), encodePng(draw(512), 512));
}
await writeFile(join(assets, "app.ico"), encodeIco(encodePng(draw(256), 256), 256));
console.log(`图标已生成: ${join(assets, "app.ico")} / icon.png`);
