// ─── Общие типы расширения ────────────────────────────────────────────────

export type SourceType =
  | "img"
  | "srcset"
  | "picture"
  | "background"
  | "meta"
  | "link"
  | "lazy"
  | "other";

export type ScanStatus =
  | "discovered"
  | "checking"
  | "ready"
  | "failed"
  | "downloaded"
  | "skipped";

export type TaskType = "PAGE_DISCOVERY" | "PAGE_SCAN" | "IMAGE_METADATA" | "IMAGE_DOWNLOAD";
export type TaskStatus = "QUEUED" | "WAITING" | "RUNNING" | "SUCCESS" | "FAILED" | "SKIPPED" | "CANCELLED";
export type JobStatus = "idle" | "running" | "paused" | "completed" | "cancelled" | "failed";
export type JobMode = "page" | "crawl";
export type FilterMode = "AND" | "OR";
export type CrawlScope = "origin" | "site" | "all";
export type FolderMode = "flat" | "page" | "domain" | "depth";
export type ViewMode = "grid" | "compact" | "list";
export type SortKey = "fileSize" | "width" | "height" | "resolution" | "name" | "url" | "depth" | "page" | "selected";
export type SortDir = "asc" | "desc";
export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

/** Вариант URL изображения (например разные разрешения из srcset / query-param). */
export interface ImageVariant {
  url: string;
  canonicalUrl: string;
  width?: number;
  height?: number;
  sourceType: SourceType;
}

export interface ImageCandidate {
  id: string;
  imageUrl: string;
  canonicalUrl: string;
  variants: ImageVariant[];
  sourcePageUrl: string;
  sourcePageTitle?: string;
  sourceDomain: string;
  /** Реальные размеры файла (после проверки) — приоритет над naturalWidth/Height. */
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
  extension?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  aspectRatio?: number;
  displayWidth?: number;
  displayHeight?: number;
  depth: number;
  sourceType: SourceType;
  alt?: string;
  title?: string;
  fingerprint?: string;
  selected: boolean;
  status: ScanStatus;
  error?: string;
  /** строка вида "DL: 403 Forbidden" — чтобы retry знал, что перезапускать. */
  retryKind?: "metadata" | "download";
}

export interface Task {
  id: string;
  type: TaskType;
  url: string;
  priority: number;
  depth: number;
  createdAt: number;
  status: TaskStatus;
  retryCount: number;
  retryAt?: number;
  data?: Record<string, unknown>;
  error?: string;
}

export interface TaskCounts {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  total: number;
}

export interface JobStats {
  pagesVisited: number;
  imagesFound: number;
  downloadsCompleted: number;
  downloadBytes: number;
  errors: number;
  limitImagesReached: boolean;
  limitPagesReached: boolean;
}

export interface JobError {
  id: string;
  taskType: TaskType;
  url: string;
  message: string;
  retryable: boolean;
  time: number;
}

export interface UILogEntry {
  time: number;
  level: LogLevel;
  message: string;
}

export interface HistoryEntry {
  id: string;
  rootUrl: string;
  mode: JobMode;
  startedAt: number;
  finishedAt: number;
  status: JobStatus;
  imagesFound: number;
  downloadsCompleted: number;
}

// ─── Настройки и фильтры ──────────────────────────────────────────────────

export interface Filters {
  minWidth: number;
  minHeight: number;
  minFileSizeKB: number;
  filterMode: FilterMode;
  minAspect: number; // 0 = выключено
  maxAspect: number; // 0 = выключено
  /** null = любые форматы; массив = только эти. */
  includeFormats: string[] | null;
  excludeFormats: string[];
  excludeSVG: boolean;
  excludeTiny: boolean;
  excludeTrackingPixels: boolean;
}

export interface CrawlOptions {
  maxDepth: number;
  maxPages: number;
  maxImages: number;
  scope: CrawlScope;
  respectRobotsTxt: boolean;
  pageDelayMin: number;
  pageDelayMax: number;
  imageDelayMin: number;
  imageDelayMax: number;
  downloadDelayMin: number;
  downloadDelayMax: number;
  pageTimeout: number;
  imageTimeout: number;
  downloadTimeout: number;
  maxRetries: number;
  concurrency: number;
  maxBackoffMs: number;
  monitoringWindowMs: number;
  maxTotalDownloadMB: number;
  folderMode: FolderMode;
  saveTo: string;
}

export interface Settings extends Filters, CrawlOptions {
  viewMode: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
}

// ─── Сообщения между UI и service worker ──────────────────────────────────

export type PanelToWorkerMsg =
  | { type: "IDE_SCAN_PAGE"; autoScroll?: boolean; monitorMs?: number }
  | { type: "IDE_START_JOB"; settings: Settings; rootUrl: string }
  | { type: "IDE_PAUSE" }
  | { type: "IDE_RESUME" }
  | { type: "IDE_CANCEL" }
  | { type: "IDE_GET_STATE" }
  | { type: "IDE_UPDATE_SETTINGS"; settings: Partial<Settings> }
  | { type: "IDE_DOWNLOAD_SELECTED"; ids: string[] }
  | { type: "IDE_RETRY_FAILED" }
  | { type: "IDE_CLEAR_JOB" }
  | { type: "IDE_PING" };

export type WorkerToPanelMsg =
  | { type: "IDE_SNAPSHOT"; payload: JobView }
  | { type: "IDE_CANDIDATE"; candidate: ImageCandidate }
  | { type: "IDE_CANDIDATE_UPDATE"; id: string; patch: Partial<ImageCandidate> }
  | { type: "IDE_STATS"; stats: JobStats }
  | { type: "IDE_STATUS"; status: JobStatus }
  | { type: "IDE_TASKS"; tasks: TaskCounts }
  | { type: "IDE_ERROR_ITEM"; error: JobError }
  | { type: "IDE_LOG"; entry: UILogEntry }
  | { type: "IDE_HISTORY"; history: HistoryEntry[] }
  | { type: "IDE_SETTINGS"; settings: Settings }
  | { type: "IDE_SCAN_SUMMARY"; summary: ScanSummary }
  | { type: "IDE_PONG"; ts: number; swVersion: string };

export interface JobView {
  jobId: string;
  mode: JobMode;
  rootUrl: string;
  status: JobStatus;
  startedAt?: number;
  finishedAt?: number;
  settings: Settings;
  candidates: ImageCandidate[];
  errors: JobError[];
  taskCounts: TaskCounts;
  queueByType?: Record<TaskType, number>;
  limiterInfo?: { page: string; image: string; download: string };
  msUntilNextRetry?: number;
  stats: JobStats;
  logTail: UILogEntry[];
}

export interface RawVariant {
  url: string;
  width?: number;
  height?: number;
  sourceType: SourceType;
}

export interface RawHit {
  variants: RawVariant[];
  naturalWidth?: number;
  naturalHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  alt?: string;
  title?: string;
}

export interface ScanResult {
  hits: RawHit[];
  links: string[];
  pageMeta: { title: string; url: string };
  scanTimeMs: number;
  stats: ScanStats;
}

/** Диагностическая статистика сканирования страницы. */
export interface ScanStats {
  imgElements: number;
  canvasElements: number;
  shadowRootsOpened: number;
  sourceTypeCounts: Partial<Record<SourceType, number>>;
  links: number;
  autoScrollSteps: number;
  mutationHits: number;
  scanTimeMs: number;
}

/** Сводка скана для отладочной панели. */
export interface ScanSummary {
  ok: boolean;
  tabUrl?: string;
  injected: boolean;
  error?: string;
  hits: number;
  links: number;
  candidates: number;
  timeMs: number;
  stats?: ScanStats;
}

/** Снимок сканера, отправляемый контент-скриптом в service worker. */
export interface ContentScanResponse {
  ok: boolean;
  result?: ScanResult;
  error?: string;
}