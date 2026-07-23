/**
 * 生成 src-tauri/icons/ 全套图标:渐变圆角方块 + 新月镂空标记。
 * 无依赖(纯像素 + zlib),输出 PNG(32/128/256/512)+ icon.icns。
 * 正式发布前应替换为设计师产出的图标;此脚本保证仓库始终可构建。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src-tauri/icons',
);

// ---------- 像素绘制 ----------

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const cx = size / 2;
  const cy = size / 2;
  // 新月:主圆减去偏移圆,形成 aperture。
  const mainR = size * 0.21;
  const cutR = size * 0.165;
  const cutCx = cx + size * 0.075;
  const cutCy = cy - size * 0.02;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const inRoundedRect = insideRoundedRect(x + 0.5, y + 0.5, size, radius);
      if (!inRoundedRect) {
        pixels[offset + 3] = 0;
        continue;
      }
      // 对角渐变:#60CDFF(左上)→ #005A9E(右下)。
      const t = (x + y) / (2 * size);
      const r = lerp(0x60, 0x00, t);
      const g = lerp(0xcd, 0x5a, t);
      const b = lerp(0xff, 0x9e, t);
      const inMain = dist(x + 0.5, y + 0.5, cx, cy) <= mainR;
      const inCut = dist(x + 0.5, y + 0.5, cutCx, cutCy) <= cutR;
      if (inMain && !inCut) {
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
      } else {
        pixels[offset] = r;
        pixels[offset + 1] = g;
        pixels[offset + 2] = b;
      }
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function dist(x1, y1, x2, y2) {
  return Math.hypot(x1 - x2, y1 - y2);
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function insideRoundedRect(x, y, size, radius) {
  const inner = size - radius;
  const corners = [
    [radius, radius],
    [inner, radius],
    [radius, inner],
    [inner, inner],
  ];
  if (x < radius && y < radius) return dist(x, y, ...corners[0]) <= radius;
  if (x > inner && y < radius) return dist(x, y, ...corners[1]) <= radius;
  if (x < radius && y > inner) return dist(x, y, ...corners[2]) <= radius;
  if (x > inner && y > inner) return dist(x, y, ...corners[3]) <= radius;
  return true;
}

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIcns(entries) {
  const parts = [];
  for (const { type, png } of entries) {
    const atom = Buffer.alloc(8);
    atom.write(type, 0, 'ascii');
    atom.writeUInt32BE(png.length + 8, 4);
    parts.push(atom, png);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

// ---------- main ----------

mkdirSync(ICONS_DIR, { recursive: true });

const sizes = [32, 128, 256, 512];
const pngs = new Map();
for (const size of sizes) {
  const png = encodePng(size, renderIcon(size));
  pngs.set(size, png);
}

writeFileSync(join(ICONS_DIR, '32x32.png'), pngs.get(32));
writeFileSync(join(ICONS_DIR, '128x128.png'), pngs.get(128));
writeFileSync(join(ICONS_DIR, '128x128@2x.png'), pngs.get(256));
writeFileSync(join(ICONS_DIR, 'icon.png'), pngs.get(512));
writeFileSync(
  join(ICONS_DIR, 'icon.icns'),
  encodeIcns([
    { type: 'ic07', png: pngs.get(128) },
    { type: 'ic08', png: pngs.get(256) },
    { type: 'ic09', png: pngs.get(512) },
  ]),
);

console.log(`icons written to ${ICONS_DIR}`);
