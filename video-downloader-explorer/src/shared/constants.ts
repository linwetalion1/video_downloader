import type { Settings, Container } from "./types";

// ─── Значения по умолчанию ────────────────────────────────────────────────

export const DEFAULTS: Settings = {
  // Filters
  minWidth: 0,
  minHeight: 0,
  minDurationSec: 0,
  maxDurationSec: 0,
  minBitrateKbps: 0,
  minFileSizeMB: 0,
  filterMode: "AND",
  includeContainers: null,
  excludeContainers: [],
  excludeManifests: false,
  excludeDRM: false,
  excludeBlobs: false,
  excludeIframes: false,
  excludeAds: false,
  // DownloadOptions
  downloadDelayMin: 300,
  downloadDelayMax: 1200,
  downloadTimeout: 120_000,
  maxRetries: 2,
  concurrency: 2,
  maxBackoffMs: 60_000,
  maxTotalDownloadMB: 10_240, // 10 GB
  folderMode: "domain",
  saveTo: "videos",
  conflictAction: "uniquify",
  filenameTemplate: "{title}_{quality}.{ext}",
  useCookies: false,
  // ScanOptions
  autoScroll: true,
  monitorMs: 5000,
  scanIframes: true,
  detectPlayers: true,
  detectSocial: true,
  sniffPerfResources: true,
  expandManifests: true,
  downloadBlobs: true,
  // UI
  viewMode: "grid",
  sortKey: "duration",
  sortDir: "desc",
};

export const EXTENSION_NAME = "Video Downloader Explorer";
export const STORAGE_KEYS = {
  settings: "vde:settings",
  /** Карта снапшотов задач по вкладкам: Record<tabId:string, JobView>. */
  jobSnapshots: "vde:jobSnapshots",
  history: "vde:history",
  logs: "vde:logs",
} as const;

export const CONCURRENCY_OPTIONS = [1, 2, 4, 6];
export const CONTAINER_OPTIONS: Container[] = [
  "mp4", "webm", "mkv", "ts", "flv", "avi", "ogg", "hls", "dash", "blob", "data"
];

export const STORAGE_LIMIT_HISTORY = 50;
export const STORAGE_LIMIT_LOGS = 500;
export const MAX_LOG_TAIL = 200;

export const PRIORITIES = {
  DOWNLOAD: 2000,
  METADATA: 1000,
  HLS_PARSE: 800,
  DASH_PARSE: 800,
  HLS_DOWNLOAD: 1900,
  DASH_DOWNLOAD: 1900,
  BLOB_DOWNLOAD: 1950,
  SCAN: 500,
} as const;

/** Сколько байт запрашивать для sniff (HEAD + Range). */
export const SNIFF_BYTES = 64 * 1024;
/** Сколько максимум читать для парсинга HLS m3u8. */
export const HLS_PARSE_BYTES = 1024 * 1024;
/** Сколько максимум читать для парсинга DASH mpd. */
export const DASH_PARSE_BYTES = 4 * 1024 * 1024;
/** Максимальный размер blob, который качаем одной операцией. */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
/** Размер чанка для blob-стрима. */
export const BLOB_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MB
/** Максимальный размер файла, который качаем одной операцией downloads API. */
export const MAX_DIRECT_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB

/** Tracking-параметры, которые нужно вырезать из canonical URL. */
export const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "dclid", "msclkid", "yclid", "mc_cid", "mc_eid",
]);

/** Волатильные/токен-параметры CDN: разные значения — то же самое видео
 *  (подписи, expiry, IP-binding). Вырезаются при группировке вариантов,
 *  но значимые для качества параметры (itag, clen, mime) сохраняются. */
export const VOLATILE_QUERY_PARAMS = new Set([
  // googlevideo / общие подписи и чанки
  "expires", "expire", "sig", "signature", "lsig", "sparams",
  "ip", "ipbits", "cp", "c", "eit", "ei", "oi", "pl", "gir",
  "ratebypass", "keepalive", "lmt", "mt", "mv", "ms", "source",
  "range", "rn", "rbuf", "sq",
  // Instagram / Meta CDN
  "efg", "_nc_ohc", "_nc_ht", "_nc_sid", "_nc_cat", "_nc_log", "_nc_rid",
  "oh", "oe", "se", "ccb", "ig_cache_key", "dl", "nc_ht",
  // Общие токены доступа
  "token", "access_token",
]);

/** Хосты, которые часто запрещают скачивание (best-effort, не запрет). */
export const KNOWN_DOMAINS_HEAVY_DRM = new Set([
  "netflix.com", "disneyplus.com", "hulu.com", "primevideo.com",
  "hbomax.com", "max.com", "paramountplus.com", "appletv.com",
  "peacocktv.com", "crunchyroll.com",
]);
