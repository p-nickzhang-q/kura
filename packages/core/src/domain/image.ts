/**
 * 只读出图片的宽高, 不解码像素。
 *
 * 为什么需要: Emby 的 `<poster>` 要竖版、`<thumb>` 要横版, 而站点给的图
 * 哪张横哪张竖并不一致 (javbus 的 /thumb/ 是 147x200 竖版小图,
 * javdb 的 covers 有的 800x438 横版、有的竖版)。按 URL 猜不如按像素判。
 */

export interface ImageSize {
  width: number;
  height: number;
}

export function parseImageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: 8 字节签名 + IHDR
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // GIF
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }

  // WebP: RIFF....WEBP
  if (bytes.length > 30 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF") {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === "VP8X") {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return { width, height };
    }
    if (kind === "VP8 ") {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (kind === "VP8L") {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  // JPEG: 扫到 SOFn 段
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1]!;
      // SOF0..SOF15, 排除 DHT(c4)/JPG(c8)/DAC(cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
  }

  return null;
}

/** 横版 = 宽大于高。判定不出来时当作竖版 (海报位更常见)。 */
export function isLandscape(size: ImageSize | null): boolean {
  return size !== null && size.width > size.height;
}
