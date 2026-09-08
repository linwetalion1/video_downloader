// Определение реальных характеристик изображений (ТЗ §3): HEAD + range-sniff
// + парсинг заголовков файлов (PNG/GIF/JPEG/WebP/BMP/ICO/AVIF/SVG).
import { mimeToExt, normalizeUrl, sha1Hex } from "../shared/utils";
import { httpFetch } from "../crawler/http";

export interface SniffedInfo {
  width?: number;
  height?: number;
  detectedMime?: string;
  kind: "raster" | "svg" | "unknown";
}

export interface ImageMeta {
  fileSize?: number;
  mimeType?: string;
  extension?: string;
  width?: number;
  height?: number;
  fingerprint?: string;
  contentDisposition?: string;
  finalUrl?: string;
}

export interface ResolveOptions {
  timeoutMs: number;
  /** Известные из DOM размеры — тогда можно не качать байты. */
  knownWidth?: number;
  knownHeight?: number;
  maxSniffBytes?: number;
  onStatus?: (status: number) => void;
  fetchLike?: typeof fetch;
}

const be16 = (b: Uint8Array, o: number): number | undefined =>
  o + 2 <= b.length ? ((b[o] << 8) | b[o + 1]) >>> 0 : undefined;
const be32 = (b: Uint8Array, o: number): number | undefined =>
  o + 4 <= b.length ? (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0) : undefined;
const le32 = (b: Uint8Array, o: number): number | undefined =>
  o + 4 <= b.length ? ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0) : undefined;

const ascii = (b: Uint8Array, o: number, len: number) =>
  o + len <= b.length ? String.fromCharCode(...b.subarray(o, o + len)) : "";

export function sniffImageInfo(bytes: Uint8Array, mimeHint?: string): SniffedInfo {
  const b = bytes;
  if (b.length < 9) return { kind: b.length > 0 && looksLikeSvg(b) ? "svg" : "unknown" };

  // PNG
  if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) {
    const w = be32(b, 16);
    const h = be32(b, 20);
    return { width: w, height: h, detectedMime: "image/png", kind: "raster" };
  }
  // GIF
  if (ascii(b, 0, 4) === "GIF8") {
    const w = (b[6] | (b[7] << 8)) >>> 0;
    const h = (b[8] | (b[9] << 8)) >>> 0;
    return { width: w, height: h, detectedMime: "image/gif", kind: "raster" };
  }
  // BMP
  if (ascii(b, 0, 2) === "BM") {
    const w = be32(b, 18);
    const rawH = be32(b, 22);
    const h = rawH === undefined ? undefined : (rawH & 0x7fffffff) >>> 0;
    return { width: w, height: h, detectedMime: "image/bmp", kind: "raster" };
  }
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 <= b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd9) break; // EOI
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = be16(b, i + 5);
        const w = be16(b, i + 7);
        if (w && h) return { width: w, height: h, detectedMime: "image/jpeg", kind: "raster" };
      }
      const segLen = be16(b, i + 2);
      if (!segLen || segLen < 2) break;
      i += 2 + segLen;
    }
    return { detectedMime: "image/jpeg", kind: "raster" };
  }
  // WebP
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    let i = 12;
    while (i + 8 <= b.length) {
      const fourcc = ascii(b, i, 4);
      const size = be32(b, i + 4) ?? 0;
      if (fourcc === "VP8 ") {
        const w = (b[i + 14] | (b[i + 15] << 8)) & 0x3fff;
        const h = (b[i + 16] | (b[i + 17] << 8)) & 0x3fff;
        return { width: w, height: h, detectedMime: "image/webp", kind: "raster" };
      }
      if (fourcc === "VP8L") {
        const v = le32(b, i + 9) ?? 0;
        return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, detectedMime: "image/webp", kind: "raster" };
      }
      if (fourcc === "VP8X") {
        const w = (b[i + 12] | (b[i + 13] << 8) | (b[i + 14] << 16));
        const h = (b[i + 15] | (b[i + 16] << 8) | (b[i + 17] << 16));
        return { width: w + 1, height: h + 1, detectedMime: "image/webp", kind: "raster" };
      }
      i += 8 + size + (size % 2);
    }
    return { detectedMime: "image/webp", kind: "raster" };
  }
  // AVIF (ищем ispe внутри box'ов)
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand === "avif" || brand === "avis") {
      const ispe = findFourcc(b, "ispe");
      if (ispe >= 0 && ispe + 16 <= b.length) {
        const w = be32(b, ispe + 8);
        const h = be32(b, ispe + 12);
        if (w && h) return { width: w, height: h, detectedMime: "image/avif", kind: "raster" };
      }
      return { detectedMime: "image/avif", kind: "raster" };
    }
  }
  // ICO
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    const count = (b[4] | (b[5] << 8)) >>> 0;
    if (count > 0) {
      const w = b[6] === 0 ? 256 : b[6];
      const h = b[7] === 0 ? 256 : b[7];
      return { width: w, height: h, detectedMime: "image/x-icon", kind: "raster" };
    }
  }
  if (looksLikeSvg(b)) {
    return { detectedMime: "image/svg+xml", kind: "svg", ...svgDimensions(b) };
  }
  // Неизвестный тип: верим hint'у.
  if (mimeHint && mimeHint.startsWith("image/")) {
    return { detectedMime: mimeHint, kind: /svg/.test(mimeHint) ? "svg" : "raster" };
  }
  return { kind: "unknown" };
}

function findFourcc(b: Uint8Array, fourcc: string): number {
  for (let i = 0; i + 4 <= b.length; i++) {
    if (ascii(b, i, 4) === fourcc) return i;
  }
  return -1;
}

function looksLikeSvg(b: Uint8Array): boolean {
  const head = ascii(b, 0, Math.min(b.length, 1024)).trim();
  return /^<svg[\s>]/i.test(head) || /^<\?xml[\s\S]*<svg/i.test(head) || /<(svg|image)[\s>]/i.test(head);
}

function svgDimensions(b: Uint8Array): { width?: number; height?: number } {
  const head = ascii(b, 0, Math.min(b.length, 4096));
  const wm = /<svg[^>]*\bwidth=["']([\d.]+)(?:px)?["']/.exec(head);
  const hm = /<svg[^>]*\bheight=["']([\d.]+)(?:px)?["']/.exec(head);
  return { width: wm ? Math.round(parseFloat(wm[1])) : undefined, height: hm ? Math.round(parseFloat(hm[1])) : undefined };
}

/**
 * Разрешение метаданных:
 *  - HEAD: размер файла, mime, content-disposition;
 *  - при отсутствии известных размеров — GET с Range (первые N байт) + sniff.
 * Ошибка переносится как HttpError (retry-логика в scheduler).
 */
export async function resolveImageMetadata(imageUrl: string, opts: ResolveOptions): Promise<ImageMeta> {
  const url = normalizeUrl(imageUrl) ?? imageUrl;
  const sniffBytes = opts.maxSniffBytes ?? 64 * 1024;
  let mimeType: string | undefined;
  let fileSize: number | undefined;
  let contentDisposition: string | undefined;
  let finalUrl: string | undefined;
  let bytes: Uint8Array | null = null;

  // 1) HEAD
  try {
    const head = await httpFetch({
      url,
      method: "HEAD",
      timeoutMs: opts.timeoutMs,
      fetchLike: opts.fetchLike,
      onStatus: opts.onStatus,
    });
    if (head.ok) {
      mimeType = head.headers["content-type"]?.split(";")[0].trim();
      const cl = parseInt(head.headers["content-length"] || "", 10);
      if (!isNaN(cl)) fileSize = cl;
      contentDisposition = head.headers["content-disposition"];
      finalUrl = head.finalUrl;
    }
  } catch {
    // HEAD может быть запрещён (405). Продолжаем с GET.
  }

  const needDims = opts.knownWidth === undefined || opts.knownHeight === undefined;

  // 2) Range-GET для sniff (только если нет реальных размеров из DOM)
  if (needDims) {
    try {
      const res = await httpFetch({
        url,
        method: "GET",
        timeoutMs: opts.timeoutMs,
        maxBytes: sniffBytes,
        headers: { Range: `bytes=0-${sniffBytes - 1}` },
        fetchLike: opts.fetchLike,
        onStatus: opts.onStatus,
      });
      if (res.ok && res.arrayBuffer) {
        bytes = new Uint8Array(res.arrayBuffer.slice(0, sniffBytes));
        if (!fileSize) {
          const cr = res.headers["content-range"];
          if (cr) {
            const m = /\/(\d+)\s*$/.exec(cr);
            if (m) fileSize = parseInt(m[1], 10);
          } else {
            const cl = parseInt(res.headers["content-length"] || "", 10);
            if (!isNaN(cl)) fileSize = cl;
          }
        }
        finalUrl ??= res.finalUrl;
        mimeType ??= res.headers["content-type"]?.split(";")[0].trim();
        contentDisposition ??= res.headers["content-disposition"];
      }
    } catch {
      // неудача GET — возвращаем то, что уже знаем (ТЗ §16: ошибка не роняет весь процесс)
    }
  }

  const sniff = bytes ? sniffImageInfo(bytes, mimeType) : { kind: "unknown" as const };
  const ext = mimeType ? mimeToExt(mimeType) : sniff.detectedMime ? mimeToExt(sniff.detectedMime) : undefined;

  const meta: ImageMeta = {
    fileSize,
    mimeType: sniff.detectedMime && sniff.kind !== "unknown" ? sniff.detectedMime : mimeType,
    extension: ext,
    width: sniff.width ?? opts.knownWidth,
    height: sniff.height ?? opts.knownHeight,
    contentDisposition,
    finalUrl: finalUrl !== url ? finalUrl : undefined,
  };

  if (bytes && sniff.kind !== "unknown" && (sniff.detectedMime || mimeType)?.startsWith("image/")) {
    meta.fingerprint = await sha1Hex(bytes.subarray(0, 4096) as unknown as Uint8Array);
  }
  return meta;
}