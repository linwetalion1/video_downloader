// ─── Расширенный логгер ───────────────────────────────────────────────────
//
// Логгер — ядро визуализации. События пишутся в UI через chrome.runtime.Port,
// сохраняются в chrome.storage.local (последние STORAGE_LIMIT_LOGS записей)
// и моментально стримятся в React-панель.
//
// Категории логирования:
//   - scan        : сканирование страницы
//   - manifest    : парсинг HLS/DASH
//   - metadata    : HEAD/Range, определение размеров и кодеков
//   - download    : скачивание файлов
//   - queue       : задачи планировщика
//   - perm        : разрешения сайтов
//   - http        : HTTP-уровень
//   - blob        : blob: и data: URL
//   - ui          : действия пользователя
//   - sw          : service worker
//   - general     : всё остальное
//
// Уровни (от низкого к высокому): TRACE < DEBUG < INFO < WARN < ERROR.
// По умолчанию активны INFO+. Через настройки можно поднять до DEBUG или TRACE.

import { MAX_LOG_TAIL, STORAGE_KEYS, STORAGE_LIMIT_LOGS } from "./constants";
import type { LogCategory, LogLevel, UILogEntry } from "./types";

export type LogListener = (entry: UILogEntry) => void;

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4,
};

let currentMinLevel: LogLevel = "INFO";
const listeners = new Set<LogListener>();
const ringBuffer: UILogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const pendingForStorage: UILogEntry[] = [];
let storageReady = false;

export function setLogLevel(level: LogLevel): void {
  currentMinLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentMinLevel;
}

export function addLogListener(fn: LogListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tail ring buffer (последние MAX_LOG_TAIL записей) — мгновенно показывается при открытии панели. */
export function getLogTail(): UILogEntry[] {
  return [...ringBuffer];
}

/** Загружает сохранённые логи (при инициализации SW). */
export async function initLogsFromStorage(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.logs);
    const arr = (stored[STORAGE_KEYS.logs] as UILogEntry[] | undefined) ?? [];
    ringBuffer.length = 0;
    for (const e of arr.slice(-MAX_LOG_TAIL)) ringBuffer.push(e);
    storageReady = true;
  } catch {
    storageReady = false;
  }
}

function formatMessage(level: LogLevel, category: LogCategory, message: string, ref?: UILogEntry["ref"]): UILogEntry {
  return { time: Date.now(), level, category, message, ref };
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[currentMinLevel];
}

function deliver(entry: UILogEntry): UILogEntry {
  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_LOG_TAIL) ringBuffer.shift();

  pendingForStorage.push(entry);
  if (pendingForStorage.length > STORAGE_LIMIT_LOGS) {
    pendingForStorage.splice(0, pendingForStorage.length - STORAGE_LIMIT_LOGS);
  }

  for (const fn of listeners) {
    try { fn(entry); } catch { /* ignore listener errors */ }
  }

  // Батчевая запись в storage (раз в 2 секунды, чтобы не молотить по диску).
  if (storageReady && !flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushLogsToStorage();
    }, 2000);
  }
  return entry;
}

async function flushLogsToStorage(): Promise<void> {
  if (pendingForStorage.length === 0) return;
  const batch = pendingForStorage.splice(0, pendingForStorage.length);
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.logs);
    const arr = (stored[STORAGE_KEYS.logs] as UILogEntry[] | undefined) ?? [];
    arr.push(...batch);
    while (arr.length > STORAGE_LIMIT_LOGS) arr.shift();
    await chrome.storage.local.set({ [STORAGE_KEYS.logs]: arr });
  } catch {
    // ignore storage errors
  }
}

export interface LogContext {
  category?: LogCategory;
  ref?: UILogEntry["ref"];
}

export interface Logger {
  /** Возвращает запись лога (даже если она не попала в UI по уровню — вернёт undefined). */
  trace(msg: string, ctx?: LogContext): UILogEntry | undefined;
  debug(msg: string, ctx?: LogContext): UILogEntry | undefined;
  info(msg: string, ctx?: LogContext): UILogEntry | undefined;
  warn(msg: string, ctx?: LogContext): UILogEntry | undefined;
  error(msg: string, ctx?: LogContext): UILogEntry | undefined;
  child(defaultCategory: LogCategory): Logger;
}

function makeLogger(defaultCategory: LogCategory = "general"): Logger {
  const emit = (level: LogLevel) => (msg: string, ctx: LogContext = {}): UILogEntry | undefined => {
    if (!shouldLog(level)) return undefined;
    const entry = formatMessage(level, ctx.category ?? defaultCategory, msg, ctx.ref);
    return deliver(entry);
  };
  const log: Logger = {
    trace: emit("TRACE") as Logger["trace"],
    debug: emit("DEBUG") as Logger["debug"],
    info: emit("INFO") as Logger["info"],
    warn: emit("WARN") as Logger["warn"],
    error: emit("ERROR") as Logger["error"],
    child: (cat) => makeLogger(cat),
  };
  return log;
}

export const logger = makeLogger("general");
export const scanLog = makeLogger("scan");
export const manifestLog = makeLogger("manifest");
export const metadataLog = makeLogger("metadata");
export const downloadLog = makeLogger("download");
export const queueLog = makeLogger("queue");
export const permLog = makeLogger("perm");
export const httpLog = makeLogger("http");
export const blobLog = makeLogger("blob");
export const uiLog = makeLogger("ui");
export const swLog = makeLogger("sw");

/** Helpers for structured events с прогрессом. */
export function logPhase(
  log: Logger,
  level: LogLevel,
  candidateId: string,
  phase: string,
  detail?: string
): void {
  const msg = detail ? `[${phase}] ${detail}` : `[${phase}]`;
  log[level.toLowerCase() as "info" | "warn" | "error" | "debug"](msg, { ref: { kind: "candidate", id: candidateId } });
}
