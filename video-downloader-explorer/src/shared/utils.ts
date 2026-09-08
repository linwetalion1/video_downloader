// ─── Утилиты общего назначения ────────────────────────────────────────────

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

export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
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

export function isBlobUrl(u: string): boolean {
  return u.startsWith("blob:");
}

export function isDataUrl(u: string): boolean {
  return u.startsWith("data:");
}

export function originOf(u: string): string {
  try { return new URL(u).origin; } catch { return ""; }
}

export function hostnameOf(u: string): string {
  try { return new URL(u).hostname; } catch { return ""; }
}

import { TRACKING_PARAMS, VOLATILE_QUERY_PARAMS } from "./constants";

/** Канонический URL: без hash и трекинг-параметров. */
export function canonicalUrl(u: string): string {
  if (isBlobUrl(u) || isDataUrl(u)) return u;
  const n = normalizeUrl(u);
  if (!n) return u;
  try {
    const url = new URL(n);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) url.searchParams.delete(k);
    }
    if ([...url.searchParams.keys()].length === 0) url.search = "";
    return url.href;
  } catch {
    return n;
  }
}

/** Уникальный ключ кандидата: origin + path + «значимые» query-параметры.
 *  Волатильные токены (подписи, expiry) вырезаются — дубликаты склеиваются,
 *  а разные качества (itag/clen/mime у googlevideo) остаются разными
 *  кандидатами. */
export function variantGroupKey(videoUrl: string): string {
  if (isBlobUrl(videoUrl) || isDataUrl(videoUrl)) return videoUrl;
  const n = normalizeUrl(videoUrl);
  if (!n) return videoUrl;
  try {
    const u = new URL(n);
    u.hash = "";
    const significant: [string, string][] = [];
    for (const [k, v] of u.searchParams.entries()) {
      const kl = k.toLowerCase();
      if (TRACKING_PARAMS.has(kl) || VOLATILE_QUERY_PARAMS.has(kl)) continue;
      significant.push([kl, v]);
    }
    significant.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return u.origin + u.pathname + (significant.length ? "?" + significant.map(([k, v]) => `${k}=${v}`).join("&") : "");
  } catch {
    return n;
  }
}

// ─── Файлы / имена ────────────────────────────────────────────────────────

export function sanitizeFilename(name: string): string {
  const cleaned = name
    // Приводим Unicode к форме NFC (Composed), чтобы в macOS Finder и APFS/HFS+
    // составные символы (диакритики, кириллица) не вызывали ошибку chrome.downloads
    .normalize("NFC")
    // Запрещённые Windows & macOS Finder символы + управляющие символы:
    // Windows запрещает <>:"/\|?*, macOS Finder резервирует : и /
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    // Emoji (суррогатные пары), вариационные селекторы, zero-width/ZWL/ZWNJ,
    // BOM, приватные символы — вызывают "Invalid filename" в Chrome
    .replace(/[\uD800-\uDFFF\uFE0F\uFEFF\u200B-\u200F\u2028-\u202E\u2060-\u2064\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // В macOS файлы с точкой в начале становятся скрытыми в Finder
    .replace(/^[.\s_\-]+/, "")
    // Завершающие точки и пробелы не поддерживаются Chrome при скачивании
    .replace(/[.\s_\-]+$/, "")
    .slice(0, 120);
  return cleaned || "video";
}

/** Определение платформы macOS (работает в браузере, Service Worker, Node). */
export function isMacOS(): boolean {
  if (typeof navigator !== "undefined") {
    return /Mac|iPhone|iPod|iPad/i.test(navigator.userAgent || (navigator as { platform?: string }).platform || "");
  }
  const proc = (globalThis as { process?: { platform?: string } }).process;
  if (proc && proc.platform) {
    return proc.platform === "darwin";
  }
  return false;
}

/** Символ клавиши-модификатора (⌘ для macOS, Ctrl для остальных). */
export function getModifierKeyLabel(): string {
  return isMacOS() ? "⌘" : "Ctrl";
}


/** Парсит Content-Disposition. */
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

export function extensionFromUrl(u: string): string | undefined {
  if (isBlobUrl(u) || isDataUrl(u)) return undefined;
  try {
    const p = new URL(u).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(p);
    return m ? m[1].toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "video/x-flv": "flv",
  "video/mp2t": "ts",
  "application/x-mpegurl": "m3u8",
  "application/vnd.apple.mpegurl": "m3u8",
  "application/dash+xml": "mpd",
  "application/octet-stream": undefined as unknown as string,
  "audio/mp4": "m4a",
  "audio/webm": "weba",
};

export function mimeToExt(mime?: string): string | undefined {
  if (!mime) return undefined;
  const key = mime.toLowerCase().split(";")[0].trim();
  return EXT_BY_MIME[key];
}

export function extToMime(ext: string): string | undefined {
  const m: Record<string, string> = {
    mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg",
    mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
    flv: "video/x-flv", ts: "video/mp2t", m3u8: "application/x-mpegurl",
    mpd: "application/dash+xml", m4a: "audio/mp4",
  };
  return m[ext.toLowerCase()];
}

// ─── Форматирование ───────────────────────────────────────────────────────

export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("ru-RU");
}

export function formatDuration(sec?: number | null): string {
  if (sec === undefined || sec === null || isNaN(sec) || !isFinite(sec) || sec < 0) return "—";
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export function formatDurationHuman(sec?: number | null): string {
  if (sec === undefined || sec === null || isNaN(sec) || !isFinite(sec) || sec <= 0) return "";
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин ${s} с`;
  return `${s} с`;
}

export function isObscureTitle(title?: string | null): boolean {
  if (!title) return true;
  const t = title.trim().toLowerCase();
  if (t === "video" || t === "video.m3u8" || t === "master.m3u8" || t === "index.m3u8" || t === "playlist.m3u8") return true;
  if (t === "videoplayback" || t.startsWith("videoplayback")) return true;
  if (t.startsWith("http://") || t.startsWith("https://")) return true;
  if (t === "стена | вконтакте" || t === "вконтакте" || t === "vk" || t === "видеозаписи" || t === "стена") return true;
  if (/^dash_[\d_.]+\.mpd$/i.test(t) || /^hls_[\d_.]+\.m3u8$/i.test(t)) return true;
  if (/^expires\/\d+/i.test(t)) return true;
  return false;
}

export function formatBitrate(kbps?: number | null): string {
  if (kbps === undefined || kbps === null || isNaN(kbps)) return "—";
  if (kbps < 1000) return `${Math.round(kbps)} Кбит/с`;
  return `${(kbps / 1000).toFixed(1)} Мбит/с`;
}

export function formatResolution(w?: number, h?: number): string {
  if (!w || !h) return "—";
  return `${w}×${h}`;
}

export function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return "только что";
  if (diff < 60_000) return `${Math.floor(diff / 1000)} с назад`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
  return new Date(ts).toLocaleString("ru-RU");
}

// ─── Хеширование ──────────────────────────────────────────────────────────

export async function sha1Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array ? data : new Uint8Array(data);
    const copy = new Uint8Array(bytes);
    const buf = await subtle.digest("SHA-1", copy.buffer);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? data : new Uint8Array(data);
  let h1 = 5381, h2 = 52711;
  for (const b of bytes) { h1 = (h1 * 33) ^ b; h2 = (h2 * 31) ^ b; }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(32, "0");
}

// ─── Random / Delay ───────────────────────────────────────────────────────

export function randomDelay(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

export function randHex(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/** Применить шаблон имени файла. Доступные плейсхолдеры:
 *  {title}, {domain}, {width}, {height}, {duration}, {quality}, {ext}, {format}, {date}.
 *  Неизвестные плейсхолдеры заменяются на пустую строку. */
export function applyFilenameTemplate(
  template: string,
  vars: { title?: string; domain?: string; width?: number; height?: number;
          duration?: number; quality?: string; ext?: string; format?: string }
): string {
  // Пустые значения НЕ заменяются дефолтом «video» — иначе в имени файла
  // появляются фантомные слова (video_x_s_video.mp4).
  const safe: Record<string, string> = {
    title: vars.title ? sanitizeFilename(vars.title) : "",
    domain: vars.domain ? sanitizeFilename(vars.domain) : "",
    width: vars.width ? String(vars.width) : "",
    height: vars.height ? String(vars.height) : "",
    duration: vars.duration ? String(Math.round(vars.duration)) : "",
    quality: vars.quality ? sanitizeFilename(vars.quality) : "",
    ext: (vars.ext || "mp4").toLowerCase(),
    format: vars.format ? sanitizeFilename(vars.format) : "",
    date: new Date().toISOString().slice(0, 10),
  };
  let out = template.replace(/\{(\w+)\}/g, (_, k: string) => safe[k] ?? "");
  // Схлопываем «дырки» от пустых плейсхолдеров и подрезаем края:
  // "clip_.mp4" → "clip.mp4", "--name-" → "name".
  out = out
    .replace(/[_\-\s]{2,}/g, "_")
    .replace(/^[\s_\-]+/, "")
    .replace(/[\s_\-]+(?=\.)/g, "")
    .replace(/[\s_\-]+$/, "")
    .trim();
  if (out.startsWith(".")) out = `video${out}`;
  return out || "video";
}

/** Нормализация перехваченных playpack-URL: убираем параметры range/rn/rbuf —
 *  сниффер ловит адреса СЕГМЕНТНЫХ запросов плеера, а для скачивания нужен
 *  полный файл. Остальные параметры (подпись, itag, clen) сохраняются. */
export function normalizePlaybackUrl(u: string): string {
  try {
    const url = new URL(u);
    if (!/videoplayback/i.test(url.pathname) && !/googlevideo\.com$/i.test(url.hostname)) return u;
    for (const p of ["range", "rn", "rbuf"]) url.searchParams.delete(p);
    return url.href;
  } catch {
    return u;
  }
}

/** Похоже ли начало данных на HTML/JSON-заглушку (ошибка сервера вместо медиа). */
export function looksLikeErrorPayload(head: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(head.subarray(0, 512)).trimStart().toLowerCase();
    if (!text) return false;
    if (text.startsWith("<!doctype") || text.startsWith("<html")) return true;
    if (/^\{\s*"error"/.test(text)) return true;
    if (/^\{\s*"(responsecontext|playabilitystatus|errormessage)"/.test(text)) return true;
    if (/"error"\s*:/.test(text.slice(0, 200)) && text.startsWith("{")) return true;
    return false;
  } catch {
    return false;
  }
}

// ─── Bytes sniffing ───────────────────────────────────────────────────────

export const ascii = (b: Uint8Array, o: number, len: number): string => {
  if (o + len > b.length) return "";
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[o + i]);
  return s;
};

export const be16 = (b: Uint8Array, o: number): number | undefined => {
  if (o + 2 > b.length) return undefined;
  return ((b[o] << 8) | b[o + 1]) >>> 0;
};

export const be32 = (b: Uint8Array, o: number): number | undefined => {
  if (o + 4 > b.length) return undefined;
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
};

export const le32 = (b: Uint8Array, o: number): number | undefined => {
  if (o + 4 > b.length) return undefined;
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
};

/** Безопасное чтение строки из Uint8Array как UTF-8 (для m3u8, mpd). */
export function bytesToText(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(b);
  } catch {
    return new TextDecoder().decode(b);
  }
}
