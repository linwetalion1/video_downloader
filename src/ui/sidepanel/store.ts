import { createContext, createElement, useCallback, useContext, useEffect, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import { DEFAULTS } from "../../shared/constants";
import type {
  HistoryEntry, ImageCandidate, JobError, JobStatus, JobStats,
  PanelToWorkerMsg, ScanSummary, Settings, TaskCounts, UILogEntry, WorkerToPanelMsg,
} from "../../shared/types";

export type ConnState = "connecting" | "open" | "closed";

export interface PanelState {
  jobId: string | null;
  mode: "page" | "crawl" | null;
  rootUrl: string | null;
  status: JobStatus;
  settings: Settings;
  candidates: ImageCandidate[];
  stats: JobStats;
  taskCounts: TaskCounts;
  queueByType?: Record<string, number>;
  limiterInfo?: { page: string; image: string; download: string };
  msUntilNextRetry?: number;
  errors: JobError[];
  history: HistoryEntry[];
  logs: UILogEntry[];
  scanSummary: ScanSummary | null;
  /** Диагностика соединения панель ↔ service worker. */
  conn: ConnState;
  swVersion: string | null;
  lastPong: number | null;
  /** True, если не получили НИ ОДНОГО сообщения от SW после последнего send(). */
  swSilent: boolean;
  sentCount: number;
  receivedCount: number;
}

export const emptyStats: JobStats = {
  pagesVisited: 0, imagesFound: 0, downloadsCompleted: 0, downloadBytes: 0,
  errors: 0, limitImagesReached: false, limitPagesReached: false,
};
export const emptyCounts: TaskCounts = { queued: 0, running: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0, total: 0 };

const initialState: PanelState = {
  jobId: null,
  mode: null,
  rootUrl: null,
  status: "idle",
  settings: DEFAULTS,
  candidates: [],
  stats: emptyStats,
  taskCounts: emptyCounts,
  errors: [],
  history: [],
  logs: [],
  scanSummary: null,
  conn: "connecting",
  swVersion: null,
  lastPong: null,
  swSilent: false,
  sentCount: 0,
  receivedCount: 0,
};

type Action =
  | { type: "ws"; msg: WorkerToPanelMsg }
  | { type: "selection"; ids: string[]; selected: boolean }
  | { type: "clear" }
  | { type: "conn"; status: ConnState }
  | { type: "pong"; swVersion: string }
  | { type: "localLog"; message: string; level?: UILogEntry["level"] }
  | { type: "sent" };

function upsert(list: ImageCandidate[], c: ImageCandidate): ImageCandidate[] {
  const idx = list.findIndex((x) => x.id === c.id);
  if (idx === -1) return [...list, c];
  const next = [...list];
  next[idx] = c;
  return next;
}

function patch(list: ImageCandidate[], id: string, p: Partial<ImageCandidate>): ImageCandidate[] {
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return list;
  const next = [...list];
  next[idx] = { ...next[idx], ...p };
  return next;
}

function pushLog(state: PanelState, entry: UILogEntry): PanelState {
  return { ...state, logs: [...state.logs, entry].slice(-200) };
}

function reducer(state: PanelState, action: Action): PanelState {
  switch (action.type) {
    case "clear":
      return { ...initialState, settings: state.settings, history: state.history };
    case "selection":
      return {
        ...state,
        candidates: state.candidates.map((c) =>
          action.ids.includes(c.id) ? { ...c, selected: action.selected } : c
        ),
      };
    case "conn":
      return { ...state, conn: action.status };
    case "pong":
      return { ...state, swVersion: action.swVersion, lastPong: Date.now(), swSilent: false };
    case "sent":
      return { ...state, sentCount: state.sentCount + 1 };
    case "localLog":
      return pushLog(state, { time: Date.now(), level: action.level ?? "DEBUG", message: action.message });
    case "ws": {
      const msg = action.msg;
      switch (msg.type) {
        case "IDE_SNAPSHOT": {
          const selected = new Set(state.candidates.filter((c) => c.selected).map((c) => c.id));
          const incoming = msg.payload.candidates.map((c) => selected.has(c.id) ? { ...c, selected: true } : c);
          const panelLogs = state.logs.filter((l) => l.message.startsWith("[панель]"));
          const mergedLogs = [...msg.payload.logTail, ...panelLogs]
            .sort((a, b) => a.time - b.time)
            .slice(-200);
          return {
            ...state,
            jobId: msg.payload.jobId || null,
            mode: msg.payload.mode,
            rootUrl: msg.payload.rootUrl || null,
            status: msg.payload.status,
            candidates: incoming,
            stats: msg.payload.stats,
            taskCounts: msg.payload.taskCounts,
            queueByType: msg.payload.queueByType,
            limiterInfo: msg.payload.limiterInfo,
            msUntilNextRetry: msg.payload.msUntilNextRetry,
            errors: msg.payload.errors,
            logs: mergedLogs,
            conn: "open",
            swSilent: false,
            receivedCount: state.receivedCount + 1,
          };
        }
        case "IDE_CANDIDATE":
          return { ...state, candidates: upsert(state.candidates, msg.candidate), conn: "open", swSilent: false, receivedCount: state.receivedCount + 1 };
        case "IDE_CANDIDATE_UPDATE":
          return { ...state, candidates: patch(state.candidates, msg.id, msg.patch), receivedCount: state.receivedCount + 1 };
        case "IDE_STATS":
          return { ...state, stats: msg.stats, receivedCount: state.receivedCount + 1 };
        case "IDE_STATUS":
          return { ...state, status: msg.status, receivedCount: state.receivedCount + 1 };
        case "IDE_TASKS":
          return { ...state, taskCounts: msg.tasks, receivedCount: state.receivedCount + 1 };
        case "IDE_ERROR_ITEM":
          return { ...state, errors: [msg.error, ...state.errors].slice(0, 500), receivedCount: state.receivedCount + 1 };
        case "IDE_LOG":
          return { ...pushLog(state, msg.entry), receivedCount: state.receivedCount + 1 };
        case "IDE_SCAN_SUMMARY":
          return { ...state, scanSummary: msg.summary, conn: "open", swSilent: false, receivedCount: state.receivedCount + 1 };
        case "IDE_PONG":
          return { ...state, swVersion: msg.swVersion, lastPong: msg.ts, conn: "open", swSilent: false, receivedCount: state.receivedCount + 1 };
        case "IDE_HISTORY":
          return { ...state, history: msg.history };
        case "IDE_SETTINGS":
          return { ...state, settings: msg.settings, conn: "open", swSilent: false };
      }
      return state;
    }
  }
}

export interface PanelApi {
  state: PanelState;
  send: (msg: PanelToWorkerMsg) => void;
  setSelection: (ids: string[], selected: boolean) => void;
  selectBy: (fn: (c: ImageCandidate) => boolean, selected: boolean) => void;
  selectAll: () => void;
  selectNone: () => void;
  clearLocal: () => void;
}

const PanelContext = createContext<PanelApi | null>(null);

function usePanelInternal(): PanelApi {
  const [state, dispatch] = useReducer(reducer, initialState);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const stateRef = useRef(state);
  const pendingQueueRef = useRef<PanelToWorkerMsg[]>([]);
  stateRef.current = state;

  useEffect(() => {
    let port: chrome.runtime.Port;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;
    let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

    const flushPending = () => {
      const p = portRef.current;
      if (!p || pendingQueueRef.current.length === 0) return;
      const q = [...pendingQueueRef.current];
      pendingQueueRef.current = [];
      for (const msg of q) {
        try {
          p.postMessage(msg);
          dispatch({ type: "localLog", message: `[панель] → отправлено (из очереди): ${msg.type}` });
        } catch (e) {
          pendingQueueRef.current.unshift(msg);
          dispatch({
            type: "localLog",
            level: "ERROR",
            message: `[панель] Ошибка отправки из очереди «${msg.type}»: ${String((e as Error)?.message || e)}`,
          });
          break;
        }
      }
    };

    const connect = () => {
      if (destroyed) return;
      try {
        port = chrome.runtime.connect({ name: "panel" });
      } catch (e) {
        dispatch({
          type: "localLog",
          level: "ERROR",
          message: `[панель] Не удалось открыть порт к SW: ${String((e as Error)?.message || e)}`,
        });
        dispatch({ type: "conn", status: "closed" });
        reconnectTimer = setTimeout(connect, 200);
        return;
      }
      portRef.current = port;
      dispatch({ type: "conn", status: "connecting" });
      dispatch({ type: "localLog", message: "[панель] Порт к SW открыт, ждём ответ…" });
      port.onMessage.addListener((msg: WorkerToPanelMsg) => dispatch({ type: "ws", msg }));
      port.onDisconnect.addListener(() => {
        if (portRef.current === port) portRef.current = null;
        if (destroyed) return;
        dispatch({ type: "conn", status: "closed" });
        // Уровень DEBUG для штатного сна MV3 (30с idle) — не засоряем ERROR
        dispatch({ type: "localLog", level: "DEBUG", message: "[панель] Порт к SW закрыт (MV3 idle 30с или SW перезапущен) — переподключение…" });
        reconnectTimer = setTimeout(connect, 100);
      });
      try {
        port.postMessage({ type: "IDE_GET_STATE" });
      } catch {
        // порт уже закрылся — сработает onDisconnect
      }
      // Сразу пробуем отправить накопленную очередь
      flushPending();
    };

    connect();
    // Keepalive: MV3 SW засыпает через ~30с idle несмотря на порт — шлём ping каждые 20с, пока панель открыта
    keepAliveTimer = setInterval(() => {
      const p = portRef.current;
      if (p) {
        try { p.postMessage({ type: "IDE_PING" }); } catch { /* onDisconnect переподключит */ }
      }
    }, 20000);

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (portRef.current) {
        try { portRef.current.disconnect(); } catch { /* ignore */ }
        portRef.current = null;
      }
    };
  }, []);

  const send = useCallback((msg: PanelToWorkerMsg) => {
    dispatch({ type: "sent" });
    const port = portRef.current;
    if (!port) {
      // Ставим в очередь и быстро переподключаемся — не теряем IDE_START_JOB при совпадении с MV3 сном
      pendingQueueRef.current.push(msg);
      dispatch({ type: "conn", status: "closed" });
      dispatch({
        type: "localLog",
        level: "WARN",
        message: `[панель] SW спит — сообщение «${msg.type}» поставлено в очередь, отправка после переподключения…`,
      });
      // Триггерим переподключение, если его нет: через порт будет flushPending
      try {
        const tmp = chrome.runtime.connect({ name: "panel" });
        // Если удалось синхронно — предыдущий onDisconnect уже сработал, новый порт возьмёт очередь в connect
        tmp.disconnect();
      } catch { /* ждём таймер */ }
      return;
    }
    dispatch({ type: "localLog", message: `[панель] → отправлено: ${msg.type}` });
    try {
      port.postMessage(msg);
    } catch (e) {
      pendingQueueRef.current.push(msg);
      dispatch({
        type: "localLog",
        level: "ERROR",
        message: `[панель] Ошибка отправки «${msg.type}»: ${String((e as Error)?.message || e)} — в очередь`,
      });
    }
  }, []);

  const setSelection = useCallback((ids: string[], selected: boolean) => {
    dispatch({ type: "selection", ids, selected });
  }, []);

  const selectBy = useCallback((fn: (c: ImageCandidate) => boolean, selected: boolean) => {
    const ids = stateRef.current.candidates.filter((c) => fn(c)).map((c) => c.id);
    dispatch({ type: "selection", ids, selected });
  }, []);

  const selectAll = useCallback(() => {
    const ids = stateRef.current.candidates.map((c) => c.id);
    dispatch({ type: "selection", ids, selected: true });
  }, []);

  const selectNone = useCallback(() => {
    const ids = stateRef.current.candidates.map((c) => c.id);
    dispatch({ type: "selection", ids, selected: false });
  }, []);

  const clearLocal = useCallback(() => dispatch({ type: "clear" }), []);

  return { state, send, setSelection, selectBy, selectAll, selectNone, clearLocal };
}

export function PanelProvider({ children }: { children: ReactNode }) {
  const api = usePanelInternal();
  return createElement(PanelContext.Provider, { value: api }, children);
}

// Хук-читатель: единый источник состояния для всего sidepanel.
// До рефактора каждый компонент вызывал usePanelInternal и получал изолированный порт/state,
// из-за чего App показывал "найдено 0" а логи были пустыми — скан приходил в другой инстанс.
export function usePanel(): PanelApi {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error("usePanel must be used within PanelProvider");
  return ctx;
}