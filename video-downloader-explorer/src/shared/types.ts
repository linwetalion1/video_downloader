// ─── Общие типы Video Downloader Explorer ─────────────────────────────────

/** Происхождение URL видео — откуда найдено. */
export type SourceType =
  | "video"            // <video src>
  | "source"           // <video><source src>
  | "currentSrc"       // videoEl.currentSrc (после readyState > 0)
  | "blob"             // blob: URL
  | "data"             // data: URL
  | "iframe-player"    // <iframe> (same-origin) с известным плеером
  | "hls-js"           // инстанс Hls.js в window
  | "dash-js"          // инстанс dashjs
  | "jwplayer"         // jwplayer()
  | "video-js"         // videojs.getAllPlayers()
  | "plyr"             // plyr
  | "clappr"           // Clappr
  | "vidyard"          // Vidyard
  | "brightcove"       // Brightcove
  | "kaltura"          // Kaltura
  | "wistia"           // Wistia
  | "mediael"          // MediaElement.js
  | "shaka"            // Shaka Player
  | "flowplayer"       // Flowplayer
  | "youtube"          // YouTube progressive / DASH
  | "vimeo"            // Vimeo progressive / DASH
  | "rutube"           // RuTube progressive / HLS
  | "vk"               // VK Видео
  | "ok"               // OK Видео
  | "coub"             // Coub
  | "dailymotion"      // Dailymotion
  | "twitch"           // Twitch VOD HLS
  | "reddit"           // Reddit DASH/HLS
  | "instagram"        // Instagram Reels / Posts
  | "tiktok"           // TikTok
  | "twitter"          // X / Twitter
  | "facebook"         // Facebook
  | "pinterest"        // Pinterest
  | "9gag"             // 9GAG
  | "bilibili"         // Bilibili
  | "rumble"           // Rumble
  | "perf-resource"    // performance.getEntriesByType('resource')
  | "sniff"            // перехват fetch/XHR в MAIN world страницы
  | "meta"             // <meta property="og:video">
  | "link"             // <a href="…mp4">
  | "other";

/** Формат / контейнер. */
export type Container =
  | "mp4"      // MP4 / MOV / M4V / 3GP
  | "webm"     // WebM / Matroska
  | "mkv"      // Matroska
  | "ts"       // MPEG-TS
  | "flv"      // FLV
  | "avi"      // AVI
  | "ogg"      // OGG
  | "hls"      // HLS playlist (m3u8)
  | "dash"     // DASH manifest (mpd)
  | "data"     // data: URL
  | "blob"     // blob: URL
  | "unknown";

export type ScanStatus =
  | "discovered"   // найден, метаданные ещё не получены
  | "checking"     // идёт запрос HEAD/Range/manifest
  | "ready"        // метаданные получены, готов к скачиванию
  | "queued"       // поставлен в очередь на скачивание
  | "downloading"  // скачивается
  | "paused"       // пауза скачивания
  | "downloaded"   // скачано
  | "failed"       // ошибка (смотри error)
  | "skipped"      // пропущено (DRM / фильтр / лимит)
  | "cancelled";   // отменено пользователем

export type TaskType =
  | "VIDEO_SCAN"
  | "VIDEO_METADATA"
  | "VIDEO_DOWNLOAD"
  | "HLS_PARSE"
  | "DASH_PARSE"
  | "HLS_DOWNLOAD"
  | "DASH_DOWNLOAD"
  | "BLOB_DOWNLOAD";

export type TaskStatus =
  | "QUEUED"
  | "WAITING"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED"
  | "CANCELLED";

export type JobStatus = "idle" | "running" | "paused" | "completed" | "cancelled" | "failed";
export type FilterMode = "AND" | "OR";
export type FolderMode = "flat" | "page" | "domain";
export type ViewMode = "grid" | "compact" | "list";
export type SortKey =
  | "duration" | "width" | "height" | "fileSize" | "bitrate" | "name"
  | "url" | "sourceType" | "container" | "selected" | "status";
export type SortDir = "asc" | "desc";
export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";
export type Phase =
  | "init" | "scanning" | "fetching-meta" | "waiting" | "downloading"
  | "merging" | "done" | "paused" | "cancelled" | "failed";

/** Кандидат на скачивание. */
export interface VideoCandidate {
  id: string;
  /** Главный URL — что именно пойдёт в downloads API. */
  videoUrl: string;
  canonicalUrl: string;
  /** Список URL‑альтернатив (разные качества, разные плееры для одного и того же). */
  alternatives: string[];

  // Происхождение
  sourceType: SourceType;
  sourcePageUrl: string;
  sourcePageTitle?: string;
  sourceDomain: string;
  /** Iframe src, если найдено через iframe. */
  iframeSrc?: string;

  // Контейнер / формат
  container: Container;
  mimeType?: string;
  extension?: string;
  /** true — это манифест HLS/DASH (m3u8/mpd), и нужно «раскрыть». */
  isManifest: boolean;
  /** true — содержит DRM (Widevine/PlayReady/FairPlay/SAMPLE-AES). */
  isDRM: boolean;
  /** true — содержит шифрование (AES-128). */
  isEncrypted?: boolean;
  /** true — сервер отвечает 403 без спец. заголовков (hotlink-защита) —
   *  такие сразу качаем через fetch+страницу, минуя downloads API. */
  hotlinkProtected?: boolean;
  /** true — это blob:/data: URL. */
  isBlob: boolean;
  /** true — YouTube-ссылка из signatureCipher: требует подписи, напрямую не качается. */
  needsSignature?: boolean;

  // Метаданные
  title?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fileSize?: number;
  bitrateKbps?: number;
  codecVideo?: string;
  codecAudio?: string;
  /** true — это прямой эфир (live stream). */
  isLive?: boolean;
  /** Количество HLS/DASH сегментов в потоке. */
  segmentsCount?: number;
  /** Список HLS‑вариантов (для UI выбора качества). */
  hlsVariants?: HlsVariant[];
  /** Выбранный пользователем вариант HLS/DASH (id варианта). */
  selectedVariantId?: string;

  // Состояние
  status: ScanStatus;
  selected: boolean;
  /** Подробный статус: что сейчас делаем с этим видео. */
  phase: Phase;
  /** Прогресс скачивания 0..1. */
  progress: number;
  /** Сообщение об ошибке / статусе (для тултипа). */
  message?: string;
  /** Сколько байт получено. */
  receivedBytes?: number;

  depth: number;
  fingerprint?: string;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface HlsVariant {
  id: string;
  url: string;
  bandwidth: number;       // бит/с
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  isAudioOnly: boolean;
  resolutionLabel: string;  // "1920x1080", "Audio only"
  /** Для DASH-представлений: полный список сегментов (init + media). */
  segments?: ManifestSegment[];
}

/** Сегмент манифеста (HLS init/media или DASH SegmentTemplate). */
export interface ManifestSegment {
  url: string;
  isInit: boolean;
}

export interface Task {
  id: string;
  type: TaskType;
  url: string;
  candidateId?: string;
  priority: number;
  createdAt: number;
  status: TaskStatus;
  retryCount: number;
  retryAt?: number;
  error?: string;
  /** Контекст для лога. */
  context?: Record<string, unknown>;
}

export interface TaskCounts {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  total: number;
  byType: Partial<Record<TaskType, number>>;
}

export interface JobStats {
  totalFound: number;
  totalChecked: number;
  totalDownloaded: number;
  totalFailed: number;
  totalSkipped: number;
  totalBytes: number;
  /** Текущий активный фоновый процесс. */
  activeTask: string | null;
  activeCandidateId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Сколько ещё ms до ближайшего retry. */
  msUntilNextRetry: number;
  /** Текущий rate-limit коэффициент. */
  backoffFactor: number;
}

export interface UILogEntry {
  time: number;
  level: LogLevel;
  /** Категория для фильтрации. */
  category: LogCategory;
  message: string;
  /** Доп. контекст: candidateId, taskId и т. п. */
  ref?: { kind: "candidate" | "task" | "url"; id: string };
}

export type LogCategory =
  | "scan" | "manifest" | "metadata" | "download" | "queue" | "perm"
  | "http" | "blob" | "ui" | "sw" | "general";

export interface HistoryEntry {
  id: string;
  rootUrl: string;
  rootTitle?: string;
  startedAt: number;
  finishedAt: number;
  status: JobStatus;
  totalFound: number;
  totalDownloaded: number;
  totalBytes: number;
}

// ─── Настройки и фильтры ──────────────────────────────────────────────────

export interface Filters {
  minWidth: number;
  minHeight: number;
  /** Минимальная длительность, сек (0 = без ограничений). */
  minDurationSec: number;
  /** Максимальная длительность, сек (0 = без ограничений). */
  maxDurationSec: number;
  /** Минимальный битрейт, Кбит/с. */
  minBitrateKbps: number;
  /** Минимальный размер, МБ. */
  minFileSizeMB: number;
  filterMode: FilterMode;
  /** Только эти контейнеры. null = любые. */
  includeContainers: Container[] | null;
  /** Исключить эти контейнеры. */
  excludeContainers: Container[];
  /** Исключить манифесты (HLS/DASH нераскрытые). */
  excludeManifests: boolean;
  /** Исключить DRM‑защищённые. */
  excludeDRM: boolean;
  /** Исключить blob: и data:. */
  excludeBlobs: boolean;
  /** Исключить iframe‑плееры. */
  excludeIframes: boolean;
  /** Скрыть tracking/sponsored (best‑effort). */
  excludeAds: boolean;
}

export interface DownloadOptions {
  downloadDelayMin: number;
  downloadDelayMax: number;
  downloadTimeout: number;
  maxRetries: number;
  concurrency: number;
  maxBackoffMs: number;
  maxTotalDownloadMB: number;
  folderMode: FolderMode;
  saveTo: string;
  /** Конфликт имён: uniquify / overwrite / prompt. */
  conflictAction: "uniquify" | "overwrite" | "prompt";
  /** Шаблон имени файла: {title} / {domain} / {width}x{height} / {duration} / {quality} / {ext}. */
  filenameTemplate: string;
  /** Использовать cookies текущего сайта (CORS-режим). */
  useCookies: boolean;
}

export interface ScanOptions {
  /** Включить прокрутку для ленивой загрузки. */
  autoScroll: boolean;
  /** Время окна MutationObserver, мс. */
  monitorMs: number;
  /** Пытаться извлечь видео из iframes (same-origin). */
  scanIframes: boolean;
  /** Детектировать плеерные фреймворки (HLS.js, dash.js, Video.js…). */
  detectPlayers: boolean;
  /** Детектировать соцсети (YouTube, Vimeo…). */
  detectSocial: boolean;
  /** Сниффить performance resource API. */
  sniffPerfResources: boolean;
  /** Раскрывать HLS/DASH манифесты автоматически. */
  expandManifests: boolean;
  /** Скачивать blob: и data: URL. */
  downloadBlobs: boolean;
}

export type DownloadOptionsLike = DownloadOptions & { downloadBlobs?: boolean };

export interface Settings extends Filters, DownloadOptions, ScanOptions {
  viewMode: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
}

// ─── Сообщения между UI и service worker ──────────────────────────────────

export type PanelToWorkerMsg =
  | { type: "VDE_PING" }
  | { type: "VDE_SCAN_PAGE"; opts?: Partial<ScanOptions> }
  | { type: "VDE_DOWNLOAD"; ids: string[] }
  | { type: "VDE_CANCEL_DOWNLOAD"; ids?: string[] }
  | { type: "VDE_PAUSE" }
  | { type: "VDE_RESUME" }
  | { type: "VDE_RETRY"; ids?: string[] }
  | { type: "VDE_GET_STATE" }
  | { type: "VDE_UPDATE_SETTINGS"; settings: Partial<Settings> }
  | { type: "VDE_CLEAR_JOB" }
  | { type: "VDE_SELECT_VARIANT"; id: string; variantId: string }
  | { type: "VDE_SET_SELECTED"; ids: string[]; selected: boolean }
  | { type: "VDE_GET_LOG"; sinceTime?: number; limit?: number };

export type WorkerToPanelMsg =
  | { type: "VDE_PONG"; ts: number; swVersion: string }
  | { type: "VDE_SNAPSHOT"; payload: JobView }
  | { type: "VDE_CANDIDATE"; candidate: VideoCandidate }
  | { type: "VDE_CANDIDATE_UPDATE"; id: string; patch: Partial<VideoCandidate> }
  | { type: "VDE_CANDIDATE_BATCH"; candidates: VideoCandidate[] }
  | { type: "VDE_LOG"; entry: UILogEntry }
  | { type: "VDE_LOG_BATCH"; entries: UILogEntry[] }
  | { type: "VDE_STATS"; stats: JobStats }
  | { type: "VDE_HISTORY"; history: HistoryEntry[] }
  | { type: "VDE_SETTINGS"; settings: Settings }
  | { type: "VDE_SCAN_SUMMARY"; summary: ScanSummary }
  | { type: "VDE_PROGRESS"; id: string; received: number; total?: number };

export interface JobView {
  jobId: string;
  status: JobStatus;
  rootUrl: string;
  rootTitle?: string;
  startedAt?: number;
  finishedAt?: number;
  settings: Settings;
  candidates: VideoCandidate[];
  /** Хвост лога, для немедленного отображения при открытии панели. */
  logTail: UILogEntry[];
  taskCounts: TaskCounts;
  stats: JobStats;
  /** Что прямо сейчас происходит (для status-баннера). */
  activeMessage: string;
  /** Ошибки. */
  errors: { time: number; candidateId?: string; url?: string; message: string; retryable: boolean }[];
  history: HistoryEntry[];
}

export interface ScanSummary {
  ok: boolean;
  tabUrl?: string;
  injected: boolean;
  error?: string;
  hits: number;
  candidates: number;
  byType: Partial<Record<SourceType, number>>;
  byContainer: Partial<Record<Container, number>>;
  drmCount: number;
  manifestCount: number;
  blobCount: number;
  timeMs: number;
  pageTitle?: string;
  shadowRootsOpened?: number;
  mutationHits?: number;
  autoScrollSteps?: number;
  errors?: string[];
}

/** Сырой кандидат из content script. */
export interface RawVideoCandidate {
  videoUrl: string;
  alternatives?: string[];
  sourceType: SourceType;
  iframeSrc?: string;
  container?: Container;
  mimeType?: string;
  extension?: string;
  isManifest?: boolean;
  isDRM?: boolean;
  isEncrypted?: boolean;
  title?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  bitrateKbps?: number;
  isLive?: boolean;
  segmentsCount?: number;
  hlsVariants?: HlsVariant[];
  /** Доп. контекст: readyState, natural, currentSrc chain. */
  context?: Record<string, unknown>;
}

/** События crawler → service worker → UI. */
export type CrawlerEvent =
  | { type: "candidate"; candidate: VideoCandidate }
  | { type: "candidateUpdate"; id: string; patch: Partial<VideoCandidate> }
  | { type: "stats"; stats: JobStats }
  | { type: "status"; status: JobStatus }
  | { type: "tasks"; counts: TaskCounts }
  | { type: "log"; entry: UILogEntry }
  | { type: "logBatch"; entries: UILogEntry[] }
  | { type: "error"; candidateId?: string; message: string };

export type CandidatePatch = Partial<VideoCandidate>;

/** Снимок со страницы. */
export interface ScanResult {
  candidates: RawVideoCandidate[];
  pageMeta: { title: string; url: string };
  scanTimeMs: number;
  stats: ContentScanStats;
}

export interface ContentScanStats {
  videoElements: number;
  sourceElements: number;
  shadowRootsOpened: number;
  iframesScanned: number;
  playersDetected: string[];
  mutations: number;
  perfResources: number;
  /** Кандидатов получено из MAIN-world сниффера сети. */
  sniffed?: number;
  errors: string[];
}

export interface ContentScanResponse {
  ok: boolean;
  result?: ScanResult;
  error?: string;
}
