// Store: общение с service worker через long-lived Port, реактивное состояние.
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { JobView, PanelToWorkerMsg, Settings, UILogEntry, VideoCandidate, WorkerToPanelMsg } from "../../shared/types";
import { DEFAULTS } from "../../shared/constants";

export interface State {
  view: JobView;
  settings: Settings;
  logs: UILogEntry[];
  /** Текущее активное действие, выводимое на status-баннере. */
  activeBanner: string;
  /** Connection status. */
  connected: boolean;
  /** Таймстамп последнего сообщения от SW. */
  lastMsgAt: number;
  /** True — идёт скачивание. */
  busy: boolean;
  /** Подробный scan summary (последний). */
  scanSummary: import("../../shared/types").ScanSummary | null;
}

type Action =
  | { type: "connected" }
  | { type: "snapshot"; payload: JobView }
  | { type: "settings"; settings: Settings }
  | { type: "candidate"; candidate: VideoCandidate }
  | { type: "candidateUpdate"; id: string; patch: Partial<VideoCandidate> }
  | { type: "log"; entry: UILogEntry }
  | { type: "logBatch"; entries: UILogEntry[] }
  | { type: "stats"; stats: import("../../shared/types").JobStats }
  | { type: "history"; history: import("../../shared/types").HistoryEntry[] }
  | { type: "scanSummary"; summary: import("../../shared/types").ScanSummary }
  | { type: "setActiveBanner"; message: string }
  | { type: "selectAll"; selected: boolean }
  | { type: "selectIds"; ids: string[]; selected: boolean };

const initial: State = {
  view: {
    jobId: "", status: "idle", rootUrl: "",
    settings: structuredClone(DEFAULTS) as Settings, candidates: [], logTail: [],
    taskCounts: { queued: 0, running: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0, total: 0, byType: {} },
    stats: { totalFound: 0, totalChecked: 0, totalDownloaded: 0, totalFailed: 0, totalSkipped: 0, totalBytes: 0, activeTask: null, activeCandidateId: null, startedAt: null, finishedAt: null, msUntilNextRetry: 0, backoffFactor: 1 },
    activeMessage: "Готов к работе", errors: [], history: [],
  },
  settings: structuredClone(DEFAULTS) as Settings,
  logs: [],
  activeBanner: "Готов к работе",
  connected: false,
  lastMsgAt: 0,
  busy: false,
  scanSummary: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "connected":
      return { ...state, connected: true };
    case "snapshot": {
      const v = action.payload;
      const banner = v.activeMessage || `Статус: ${v.status}`;
      const busy = v.status === "running" || v.status === "paused";
      return { ...state, view: v, activeBanner: banner, busy, lastMsgAt: Date.now() };
    }
    case "settings":
      return { ...state, settings: action.settings };
    case "candidate": {
      const exists = state.view.candidates.find((c) => c.id === action.candidate.id);
      if (exists) return state;
      return { ...state, view: { ...state.view, candidates: [action.candidate, ...state.view.candidates], stats: { ...state.view.stats, totalFound: state.view.stats.totalFound + 1 } } };
    }
    case "candidateUpdate": {
      const list = state.view.candidates.map((c) => c.id === action.id ? { ...c, ...action.patch } : c);
      return { ...state, view: { ...state.view, candidates: list } };
    }
    case "log": {
      const e = action.entry;
      if (!e || !e.level || !e.message) return state;
      return { ...state, logs: [...state.logs, e].slice(-300) };
    }
    case "logBatch": {
      const safe = (action.entries || []).filter((e) => e && e.level && e.message);
      const merged = [...state.logs, ...safe].slice(-300);
      return { ...state, logs: merged };
    }
    case "stats":
      return { ...state, view: { ...state.view, stats: { ...state.view.stats, ...action.stats } } };
    case "history":
      return { ...state, view: { ...state.view, history: action.history } };
    case "scanSummary":
      return { ...state, scanSummary: action.summary };
    case "setActiveBanner":
      return { ...state, activeBanner: action.message };
    case "selectAll": {
      const list = state.view.candidates.map((c) => ({ ...c, selected: action.selected }));
      return { ...state, view: { ...state.view, candidates: list } };
    }
    case "selectIds": {
      const ids = action.ids;
      const sel = action.selected;
      const list = state.view.candidates.map((c) => (ids.includes(c.id) ? { ...c, selected: sel } : c));
      return { ...state, view: { ...state.view, candidates: list } };
    }
  }
  return state;
}

let port: chrome.runtime.Port | null = null;

export interface PanelApi {
  state: State;
  send: (m: PanelToWorkerMsg) => void;
  selectAll: () => void;
  selectNone: () => void;
  setBanner: (msg: string) => void;
  setSelected: (ids: string[], selected: boolean) => void;
  deleteCandidates: (ids: string[]) => void;
}

export function usePanel(): PanelApi {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!port) {
      port = chrome.runtime.connect({ name: "panel" });
      port.onMessage.addListener((msg: WorkerToPanelMsg) => {
        switch (msg.type) {
          case "VDE_PONG": dispatch({ type: "connected" }); break;
          case "VDE_SNAPSHOT": dispatch({ type: "snapshot", payload: msg.payload }); break;
          case "VDE_SETTINGS": dispatch({ type: "settings", settings: msg.settings }); break;
          case "VDE_CANDIDATE": dispatch({ type: "candidate", candidate: msg.candidate }); break;
          case "VDE_CANDIDATE_UPDATE": dispatch({ type: "candidateUpdate", id: msg.id, patch: msg.patch }); break;
          case "VDE_CANDIDATE_BATCH": {
            for (const c of msg.candidates) dispatch({ type: "candidate", candidate: c });
            break;
          }
          case "VDE_LOG": dispatch({ type: "log", entry: msg.entry }); break;
          case "VDE_LOG_BATCH": dispatch({ type: "logBatch", entries: msg.entries }); break;
          case "VDE_STATS": dispatch({ type: "stats", stats: msg.stats }); break;
          case "VDE_HISTORY": dispatch({ type: "history", history: msg.history }); break;
          case "VDE_SCAN_SUMMARY": dispatch({ type: "scanSummary", summary: msg.summary }); break;
        }
      });
      port.onDisconnect.addListener(() => {
        port = null;
        setTimeout(() => { if (!port) { /* SW перезапустился — попробуем переподключиться через 1 с */ 
          const t = setTimeout(() => location.reload(), 1500);
          window.addEventListener("focus", () => { clearTimeout(t); location.reload(); }, { once: true });
        } }, 1000);
      });
    }
    port.postMessage({ type: "VDE_GET_STATE" });
    return () => { /* port живёт пока жив sidepanel */ };
  }, []);

  const send = useCallback((m: PanelToWorkerMsg) => {
    try { port?.postMessage(m); } catch { /* */ }
  }, []);

  const selectAll = useCallback(() => {
    const ids = stateRef.current.view.candidates.map((c) => c.id);
    dispatch({ type: "selectAll", selected: true });
    send({ type: "VDE_SET_SELECTED", ids, selected: true });
  }, [send]);

  const selectNone = useCallback(() => {
    const ids = stateRef.current.view.candidates.map((c) => c.id);
    dispatch({ type: "selectAll", selected: false });
    send({ type: "VDE_SET_SELECTED", ids, selected: false });
  }, [send]);

  const setBanner = useCallback((msg: string) => dispatch({ type: "setActiveBanner", message: msg }), []);

  const setSelected = useCallback((ids: string[], selected: boolean) => {
    // Локально — сразу (чекбокс реагирует мгновенно), в SW — для снапшота.
    dispatch({ type: "selectIds", ids, selected });
    send({ type: "VDE_SET_SELECTED", ids, selected });
  }, [send]);

  const deleteCandidates = useCallback((ids: string[]) => {
    // На текущий момент — просто пересоздаём задание. Можно реализовать точечное удаление.
    send({ type: "VDE_CLEAR_JOB" });
  }, [send]);

  return { state, send, selectAll, selectNone, setBanner, setSelected, deleteCandidates };
}
