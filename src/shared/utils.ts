// ─── Общие утилиты (работают и в SW, и в контент-скрипте, и в UI) ─────────

export function uid(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** Не чаще чем раз в ms, плюс хвостовой вызов после паузы. */
export function throttle<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush: () => void } {
  let last = 0;
  let t: ReturnType<typeof setTimeout> | undefined;
  let pending: A | null = null;
  const invoke = (a: A) => {
    last = Date.now();
    pending = null;
    fn(...a);
  };
  const wrapped = ((...a: A) => {
    pending = a;
    const now = Date.now();
    const remain = ms - (now - last);
    if (remain <= 0) {
      if (t) { clearTimeout(t); t = undefined; }
      invoke(a);
      return;
    }
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      if (pending) invoke(pending);
    }, remain);
  }) as ((...a: A) => void) & { flush: () => void };
  wrapped.flush = () => {
    if (t) { clearTimeout(t); t = undefined; }
    if (pending) invoke(pending);
  };
  return wrapped;
}

// ─── URL ──────────────────────────────────────────────────────────────────

/** Абсолютизирует URL относительно base. null если нельзя. */
export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

export function isHttpUrl(u: string): boolean {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
}

export function originOf(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

export function hostnameOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "dclid", "msclkid", "yclid", "mc_cid", "mc_eid",
]);

/** Канонический URL страницы: без hash и трекинг-параметров. */
export function canonicalUrl(u: string): string {
  const n = normalizeUrl(u);
  if (!n) return u;
  try {
    const url = new URL(n);
    for (const k of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) url.searchParams.delete(k);
    }
    if ([...url.searchParams.keys()].length === 0) url.search = "";
    return url.href;
  } catch {
    return n;
  }
}

/** Параметры, которые считаются «размерными» у CDN/ресайзеров. */
const RESIZE_PARAMS = new Set([
  "w", "width", "h", "height", "size", "s", "res", "resize", "r",
  "q", "quality", "auto", "fm", "f", "format", "crop", "fit", "gravity",
  "zoom", "dpr", "strip", "fl", "progressive", "enlarge", "blur", "pad",
  "extend", "max", "min", "scale", "rotate",
]);

/**
 * Ключ группы вариантов одного изображения (ТЗ §2.1).
 * a.jpg / a.jpg?w=800 / a.jpg?w=1600 → одна группа;
 * a.jpg?id=1 / a.jpg?id=2 → разные изображения.
 */
export function variantGroupKey(imageUrl: string): string {
  const n = normalizeUrl(imageUrl);
  if (!n) return imageUrl;
  try {
    const u = new URL(n);
    u.pathname = u.pathname.replace(/\/thumb_([^/]+)$/i, "/$1");
    const names = [...u.searchParams.keys()];
    if (names.length > 0 && names.every((k) => RESIZE_PARAMS.has(k.toLowerCase()))) {
      u.search = "";
      return u.href;
    }
    return u.href;
  } catch {
    return n;
  }
}

/** Полный URL из chatpic-style /thumb_file.jpg → /file.jpg (только префикс имени). */
export function expandThumbUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const next = u.pathname.replace(/\/thumb_([^/]+)$/i, "/$1");
    if (next === u.pathname) return null;
    u.pathname = next;
    return u.href;
  } catch {
    return null;
  }
}

/** Предпочитает полный кадр (без /thumb_) и больший width. */
export function pickPrimaryVariant<T extends { url: string; width?: number }>(variants: T[]): T {
  if (variants.length <= 1) return variants[0];
  const scored = [...variants].sort((a, b) => {
    const at = /\/thumb_[^/]+$/i.test((() => { try { return new URL(a.url).pathname; } catch { return a.url; } })()) ? 0 : 1;
    const bt = /\/thumb_[^/]+$/i.test((() => { try { return new URL(b.url).pathname; } catch { return b.url; } })()) ? 0 : 1;
    if (bt !== at) return bt - at;
    return (b.width ?? 0) - (a.width ?? 0);
  });
  return scored[0];
}

// ─── Srcset ───────────────────────────────────────────────────────────────

export interface SrcsetItem {
  url: string;
  width?: number;
  height?: number;
  density?: number;
}

export function parseSrcset(srcset: string, base: string): SrcsetItem[] {
  if (!srcset) return [];
  const out: SrcsetItem[] = [];
  for (const raw of srcset.split(",")) {
    const m = raw.trim().match(/^(\S+)(?:\s+([\d.]+)([whx]))?$/);
    if (!m) continue;
    const url = normalizeUrl(m[1], base);
    if (!url) continue;
    const item: SrcsetItem = { url };
    const d = m[2];
    const unit = m[3];
    if (d && unit) {
      if (unit === "w") item.width = Math.round(parseFloat(d));
      else if (unit === "h") item.height = Math.round(parseFloat(d));
      else item.density = parseFloat(d);
    }
    out.push(item);
  }
  return out;
}

// ─── Форматы / расширения ─────────────────────────────────────────────────

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/tiff": "tiff",
};

export const IMAGE_EXT_SET = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp", "ico", "tif", "tiff"]);

export function mimeToExt(mime?: string): string | undefined {
  if (!mime) return undefined;
  const e = EXT_BY_MIME[mime.toLowerCase().split(";")[0].trim()];
  return e;
}

export function extensionFromUrl(u: string): string | undefined {
  try {
    const p = new URL(u).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(p);
    return m ? m[1].toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const NON_HTML_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp", "ico", "tif", "tiff",
  "pdf", "zip", "rar", "7z", "gz", "tar", "mp3", "mp4", "webm", "ogg", "wav",
  "avi", "mov", "mkv", "mpg", "mpeg", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "exe", "msi", "dmg", "apk", "iso", "css", "js", "json", "xml", "txt", "csv",
  "woff", "woff2", "ttf", "otf", "eot", "swf",
]);

export function isHtmlPageUrl(url: string): boolean {
  const e = extensionFromUrl(url);
  return !e || !NON_HTML_EXT.has(e);
}

// ─── Форматирование ───────────────────────────────────────────────────────

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("ru-RU");
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

// ─── Файлы ────────────────────────────────────────────────────────────────

/** Разбор Content-Disposition (filename* и filename). */
export function parseContentDisposition(cd: string | null): string | null {
  if (!cd) return null;
  const m = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  if (!m || !m[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "image";
}

// ─── Хеширование ──────────────────────────────────────────────────────────

export async function sha1Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const copy = new Uint8Array(bytes);
    const buf = await subtle.digest("SHA-1", copy.buffer);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Фолбэк (Node <20 без WebCrypto): djb2, 64-bit.
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let h1 = 5381;
  let h2 = 52711;
  for (const b of bytes) {
    h1 = (h1 * 33) ^ b;
    h2 = (h2 * 31) ^ b;
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(32, "0");
}

/** Генератор задержки из ТЗ §34. */
export function randomDelay(min: number, max: number): number {
  return min + Math.random() * (max - min);
}