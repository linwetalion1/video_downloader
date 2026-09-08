// Генератор иконок расширения (чистые PNG, без внешних зависимостей).
// Рисует синий скруглённый квадрат с белой пиктограммой «картинка».
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "icons");
const BG = [26, 115, 232, 255];      // #1a73e8
const SUN = [255, 213, 79, 255];     // жёлтое солнце
const MOUNT = [255, 255, 255, 255];  // белая «гора»
const EMBER = [200, 225, 255, 255];  // светлый фон рамки

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function roundedRect(x, y, w, h, r, px) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = Math.max(0, Math.abs(px[0] - cx) - (w / 2 - r));
  const dy = Math.max(0, Math.abs(px[1] - cy) - (h / 2 - r));
  return dx * dx + dy * dy <= r * r;
}

function makeIcon(size) {
  const S = size;
  const px = Buffer.alloc(S * S * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  };
  const inside = (x, y, x0, y0, w, h) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!roundedRect(x + 0.5, y + 0.5, S - 1, S - 1, S * 0.22, [x, y])) continue;
      set(x, y, BG);
    }
  }
  // рамка «картинки»
  const pad = S * 0.16;
  const fw = S * 0.68;
  const fh = S * 0.52;
  const fx = (S - fw) / 2;
  const fy = (S - fh) / 2;
  for (let y = Math.round(fy); y < fy + fh; y++)
    for (let x = Math.round(fx); x < fx + fw; x++) {
      if (inside(x, y, fx, fy, fw, fh)) set(x, y, EMBER);
    }
  // «гора» (треугольник)
  const mx = fx + fw * 0.5;
  const triY = fy + fh * 0.62;
  for (let y = Math.round(triY) - 1; y < fy + fh; y++) {
    const t = (y - triY) / (fh * 0.38);
    const half = fw * 0.22 * t;
    for (let x = Math.round(mx - half); x <= mx + half; x++) set(x, y, MOUNT);
  }
  // второстепенная «гора»
  const tri2X = fx + fw * 0.24;
  for (let y = Math.round(fy + fh * 0.72); y < fy + fh; y++) {
    const t = (y - (fy + fh * 0.72)) / (fh * 0.28);
    const half = fw * 0.14 * t;
    for (let x = Math.round(tri2X - half); x <= tri2X + half; x++) set(x, y, MOUNT);
  }
  // «солнце»
  const sx = fx + fw * 0.66;
  const sy = fy + fh * 0.3;
  const r = S * 0.075;
  for (let y = Math.round(sy - r); y <= sy + r; y++)
    for (let x = Math.round(sx - r); x <= sx + r; x++) {
      const dx = x - sx, dy = y - sy;
      if (dx * dx + dy * dy <= r * r) set(x, y, SUN);
    }

  return encodePng(S, px);
}

export function ensureIcons() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const s of [16, 32, 48, 128]) {
    writeFileSync(path.join(OUT_DIR, `icon${s}.png`), makeIcon(s));
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  ensureIcons();
  console.log("Icons generated in", OUT_DIR);
}