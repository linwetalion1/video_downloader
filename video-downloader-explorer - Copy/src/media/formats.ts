// Распознавание формата видео по первым байтам (magic bytes).
// Покрывает: MP4/MOV/M4V (ftyp), WebM/MKV (EBML), AVI (RIFF), FLV, TS (sync 0x47),
// OGG, M3U8, MPD, raw audio (m4a), HLS-encrypted key (URI).
import { ascii, be32, extensionFromUrl, extToMime } from "../shared/utils";
import type { Container } from "../shared/types";

export interface FormatResult {
  container: Container;
  mime: string;
  /** Признак манифеста. */
  isManifest: boolean;
  /** Признак шифрования (AES-128, SAMPLE-AES). */
  isEncrypted: boolean;
  /** Признак DRM (CENC, Widevine, PlayReady, FairPlay). */
  isDRM: boolean;
  /** Уверенность 0..1. */
  confidence: number;
}

const DEFAULT: FormatResult = {
  container: "unknown",
  mime: "application/octet-stream",
  isManifest: false,
  isEncrypted: false,
  isDRM: false,
  confidence: 0,
};

export function detectFormat(bytes: Uint8Array, urlHint?: string, mimeHint?: string): FormatResult {
  if (bytes.length === 0) return fromHint(urlHint, mimeHint);

  // 1. Текстовые манифесты.
  const head = ascii(bytes, 0, Math.min(bytes.length, 256)).trim();
  if (/^#EXTM3U/i.test(head) || /^#EXT-X-/i.test(head)) {
    const enc = /EXT-X-KEY:.*METHOD=(?!NONE)/i.test(head);
    const drm = /SAMPLE-AES/i.test(head);
    return {
      container: "hls", mime: "application/x-mpegurl",
      isManifest: true, isEncrypted: enc, isDRM: drm, confidence: 0.99,
    };
  }
  if (/^<\?xml/i.test(head) && /<MPD[\s>]/i.test(head)) {
    const drm = /ContentProtection[\s\S]*?schemeIdUri/i.test(head);
    return {
      container: "dash", mime: "application/dash+xml",
      isManifest: true, isEncrypted: false, isDRM: drm, confidence: 0.99,
    };
  }

  // 2. ftyp → MP4/MOV/M4V/3GP/HEIF
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const major = ascii(bytes, 8, 4);
    const brandMap: Record<string, string> = {
      "isom": "video/mp4", "iso2": "video/mp4", "iso3": "video/mp4", "iso4": "video/mp4",
      "iso5": "video/mp4", "iso6": "video/mp4", "mp41": "video/mp4", "mp42": "video/mp4",
      "mp4v": "video/mp4", "mp7t": "video/mp4", "mp7b": "video/mp4",
      "avc1": "video/mp4", "hev1": "video/mp4", "hvc1": "video/mp4", "hevx": "video/mp4",
      "qt  ": "video/quicktime", "M4V ": "video/x-m4v", "M4VP": "video/x-m4v",
      "3gp4": "video/3gpp", "3gp5": "video/3gpp", "3gp6": "video/3gpp",
      "3g2a": "video/3gpp2", "3g2b": "video/3gpp2",
      "M4A ": "audio/mp4", "M4B ": "audio/mp4",
    };
    const mime = brandMap[major] ?? "video/mp4";
    return { container: "mp4", mime, isManifest: false, isEncrypted: false, isDRM: false, confidence: 0.98 };
  }

  // 3. EBML → WebM / Matroska
  if (bytes.length >= 4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
    // Ищем DocType где-то в первых ~256 байт.
    const docTypeIdx = findEbmlString(bytes, 0, "DocType");
    let isWebM = true;
    if (docTypeIdx > 0) {
      const docType = readEbmlString(bytes, docTypeIdx);
      if (/matroska/i.test(docType)) isWebM = false;
    }
    return {
      container: isWebM ? "webm" : "mkv",
      mime: isWebM ? "video/webm" : "video/x-matroska",
      isManifest: false, isEncrypted: false, isDRM: false, confidence: 0.97,
    };
  }

  // 4. RIFF AVI: "RIFF" + size + "AVI "
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "AVI ") {
    return { container: "avi", mime: "video/x-msvideo", isManifest: false, isEncrypted: false, isDRM: false, confidence: 0.98 };
  }

  // 5. FLV: "FLV"
  if (ascii(bytes, 0, 3) === "FLV") {
    return { container: "flv", mime: "video/x-flv", isManifest: false, isEncrypted: false, isDRM: false, confidence: 0.99 };
  }

  // 6. MPEG-TS: первый байт 0x47, шаг 188
  if (bytes[0] === 0x47 && (bytes.length < 188 || bytes[188] === 0x47)) {
    return { container: "ts", mime: "video/mp2t", isManifest: false, isEncrypted: false, isDRM: false, confidence: 0.85 };
  }

  // 7. OGG: "OggS"
  if (ascii(bytes, 0, 4) === "OggS") {
    return { container: "ogg", mime: "video/ogg", isManifest: false, isEncrypted: false, isDRM: false, confidence: 0.95 };
  }

  // 8. AES-128 key URI
  if (bytes.length < 64 && /^https?:\/\//i.test(head) && /key\.bin|key$/i.test(head)) {
    return {
      container: "unknown", mime: "application/octet-stream",
      isManifest: false, isEncrypted: true, isDRM: false, confidence: 0.5,
    };
  }

  // 9. Fallback на hint.
  return fromHint(urlHint, mimeHint);
}

function fromHint(urlHint?: string, mimeHint?: string): FormatResult {
  if (mimeHint) {
    const m = mimeHint.toLowerCase().split(";")[0].trim();
    if (m.startsWith("video/") || m.startsWith("audio/")) {
      const ext = extensionFromUrl(urlHint ?? "") ?? "";
      return mapMime(m, ext);
    }
  }
  if (urlHint) {
    const ext = extensionFromUrl(urlHint);
    if (ext) {
      const mime = extToMime(ext);
      if (mime) return mapMime(mime, ext);
    }
  }
  return { ...DEFAULT };
}

function mapMime(mime: string, ext: string): FormatResult {
  if (/mpegurl/i.test(mime) || ext === "m3u8") {
    return { container: "hls", mime, isManifest: true, isEncrypted: false, isDRM: false, confidence: 0.7 };
  }
  if (/dash\+xml/i.test(mime) || ext === "mpd") {
    return { container: "dash", mime, isManifest: true, isEncrypted: false, isDRM: false, confidence: 0.7 };
  }
  const map: Record<string, Container> = {
    "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogg",
    "video/quicktime": "mp4", "video/x-matroska": "mkv", "video/x-msvideo": "avi",
    "video/x-flv": "flv", "video/mp2t": "ts", "audio/mp4": "mp4", "audio/webm": "webm",
  };
  return {
    container: map[mime] ?? "unknown",
    mime,
    isManifest: false, isEncrypted: false, isDRM: false, confidence: 0.5,
  };
}

// ─── EBML helpers (для WebM/MKV) ──────────────────────────────────────────

function findEbmlString(b: Uint8Array, start: number, target: string): number {
  const targetBytes = new TextEncoder().encode(target);
  outer: for (let i = start; i < b.length - targetBytes.length; i++) {
    for (let j = 0; j < targetBytes.length; j++) {
      if (b[i + j] !== targetBytes[j]) continue outer;
    }
    return i + targetBytes.length;
  }
  return -1;
}

function readEbmlString(b: Uint8Array, off: number): string {
  const len = b[off];
  if (off + 1 + len > b.length) return "";
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + 1 + i]);
  return s;
}
