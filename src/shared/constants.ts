import type { Settings } from "./types";

// ─── Значения по умолчанию (ТЗ §55) ───────────────────────────────────────

export const DEFAULTS: Settings = {
  // Фильтры
  minWidth: 0,
  minHeight: 0,
  minFileSizeKB: 0,
  filterMode: "AND",
  minAspect: 0,
  maxAspect: 0,
  includeFormats: null,
  excludeFormats: [],
  excludeSVG: false,
  excludeTiny: false,
  excludeTrackingPixels: false,
  // Crawler
  maxDepth: 0,
  maxPages: 100,
  maxImages: 1000,
  scope: "origin",
  respectRobotsTxt: true,
  // Скорость (ТЗ §55)
  pageDelayMin: 800,
  pageDelayMax: 1800,
  imageDelayMin: 300,
  imageDelayMax: 1200,
  downloadDelayMin: 500,
  downloadDelayMax: 2000,
  // Таймауты (ТЗ §14)
  pageTimeout: 15000,
  imageTimeout: 10000,
  downloadTimeout: 60000,
  maxRetries: 2,
  concurrency: 2,
  maxBackoffMs: 60000,
  monitoringWindowMs: 10000,
  maxTotalDownloadMB: 2048, // 2 GB
  folderMode: "flat",
  saveTo: "images",
  // UI
  viewMode: "grid",
  sortKey: "fileSize",
  sortDir: "desc",
};

export const EXTENSION_NAME = "Image Downloader Explorer";
export const STORAGE_KEYS = {
  settings: "ide:settings",
  jobSnapshot: "ide:jobSnapshot",
  history: "ide:history",
  logs: "ide:logs",
} as const;

/** Опции максимального количества страниц (ТЗ §11). */
export const PAGE_LIMIT_OPTIONS = [10, 25, 50, 100, 250, 500];
export const IMAGE_LIMIT_OPTIONS = [100, 250, 500, 1000, 2500, 5000];
export const MAX_DEPTH = 2;
export const DEPTH_OPTIONS = [0, 1, 2];
export const FORMAT_OPTIONS = ["jpg", "png", "gif", "webp", "avif", "svg", "bmp"] as const;
export const CONCURRENCY_OPTIONS = [1, 2, 4, 8];
export const STORAGE_LIMIT_HISTORY = 50;
export const STORAGE_LIMIT_LOGS = 200;
export const MAX_PAGE_BYTES = 8 * 1024 * 1024; // страницы > 8MB не читаем целиком

/** Приоритеты задач (ТЗ §21): выше = раньше. */
export const PRIORITIES = {
  DOWNLOAD: 2000,
  DISCOVERY_D0: 1000,
  SCAN_D0: 999,
  METADATA_D0: 900,
  DISCOVERY_D1: 700,
  SCAN_D1: 695,
  METADATA_D1: 650,
  DISCOVERY_D2: 400,
  SCAN_D2: 395,
  METADATA_D2: 350,
} as const;

export const MAX_CONCURRENT_TASKS_GUARD = 8;

/** Ширина/высота считается «tiny» (иконка). */
export const TINY_ICON_PX = 16;
/** Tracking-pixel. */
export const TRACKING_PIXEL_PX = 2;