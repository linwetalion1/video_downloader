// Генератор иконок расширения (чистые PNG, без внешних зависимостей).
// Рисует тёмно-синий скруглённый квадрат с белым play-треугольником.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "..", "icons");
const BG = [37, 99, 235, 255];        // #2563eb (indigo-600)
const RING = [255, 255, 255, 255];    // белая рамка
const PLAY = [255, 255, 255, 255];    // белая «play»

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
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
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

  // Фон — скруглённый квадрат
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (roundedRect(x + 0.5, y + 0.5, S - 1, S - 1, S * 0.22, [x, y])) set(x, y, BG);
    }
  }

  // Кольцо (рамка)
  const cx = S / 2, cy = S / 2;
  const ringR = S * 0.32;
  const ringW = Math.max(1.5, S * 0.05);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= ringR && d >= ringR - ringW) set(x, y, RING);
    }
  }

  // Play-треугольник внутри кольца
  const triCx = cx - S * 0.04;
  const triCy = cy;
  const triR = S * 0.16;
  for (let y = Math.round(triCy - triR); y <= triCy + triR; y++) {
    for (let x = Math.round(triCx); x <= triCx + triR * 1.2; x++) {
      // треугольник: x ∈ [triCx, triCx + triR*(1 - |y-triCy|/triR)]
      const ny = (y - triCy) / triR;
      if (ny < -1 || ny > 1) continue;
      const maxX = triCx + triR * 1.1 * (1 - Math.abs(ny));
      if (x <= maxX) set(x, y, PLAY);
    }
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
