// Service worker (MV3). Клей между content script, crawler и UI.
// Каждый шаг — лог. UI всегда знает, что происходит.
import { Crawler } from "../crawler/orchestrator";
import { addHistoryEntry, loadHistory, loadJobSnapshot, loadSettings, saveJobSnapshot, saveSettings } from "../storage/settings";
import { addLogListener, initLogsFromStorage, logger, setLogLevel, swLog } from "../shared/logger";
import type { HistoryEntry, JobView, PanelToWorkerMsg, Settings, WorkerToPanelMsg } from "../shared/types";
import { uid } from "../shared/utils";

let crawler: Crawler | null = null;
let currentSettings: Settings | null = null;
const ports = new Set<chrome.runtime.Port>();

// ─── Init ─────────────────────────────────────────────────────────────────

void initLogsFromStorage();
setLogLevel("INFO");

// Пересылаем каждую запись логгера в активные порты (UI) + сохраняем в ring.
addLogListener((entry) => {
  const msg: WorkerToPanelMsg = { type: "VDE_LOG", entry };
  broadcast(msg);
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function ensureSettingsLoaded(): Promise<Settings> {
  if (!currentSettings) currentSettings = await loadSettings();
  return currentSettings;
}

function broadcast(msg: WorkerToPanelMsg): void {
  for (const port of ports) {
    try { port.postMessage(msg); } catch { ports.delete(port); }
  }
}

function emptyJobView(settings: Settings): JobView {
  return {
    jobId: "", status: "idle", rootUrl: "",
    settings, candidates: [], logTail: [],
    taskCounts: { queued: 0, running: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0, total: 0, byType: {} },
    stats: { totalFound: 0, totalChecked: 0, totalDownloaded: 0, totalFailed: 0, totalSkipped: 0, totalBytes: 0, activeTask: null, activeCandidateId: null, startedAt: null, finishedAt: null, msUntilNextRetry: 0, backoffFactor: 1 },
    activeMessage: "Готов к работе",
    errors: [], history: [],
  };
}

const crawlerEvents = (ev: import("../shared/types").CrawlerEvent): void => {
  switch (ev.type) {
    case "candidate": broadcast({ type: "VDE_CANDIDATE", candidate: ev.candidate }); break;
    case "candidateUpdate": broadcast({ type: "VDE_CANDIDATE_UPDATE", id: ev.id, patch: ev.patch }); break;
    case "stats": broadcast({ type: "VDE_STATS", stats: ev.stats }); break;
    case "status": broadcast({ type: "VDE_SNAPSHOT", payload: getJobView() }); void onJobFinished(); break;
    case "tasks": {
      const v = getJobView();
      v.taskCounts = ev.counts;
      broadcast({ type: "VDE_SNAPSHOT", payload: v });
      break;
    }
    // Логи в UI доставляет глобальный addLogListener (ниже) — иначе записи дублируются ×2.
    case "log": break;
    case "logBatch": break;
    case "error": break;
  }
};

function getJobView(): JobView {
  if (!crawler) {
    return emptyJobView(currentSettings ?? ({} as Settings));
  }
  return crawler.snapshot();
}

// ─── Permissions ──────────────────────────────────────────────────────────

async function hasOriginPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin;
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch { return false; }
}

async function ensureOriginPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin;
    const pattern = `${origin}/*`;
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch { return false; }
}

// ─── Active tab & injection ───────────────────────────────────────────────

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = tabs[0];
  if (!tab) { tabs = await chrome.tabs.query({ active: true, currentWindow: true }); tab = tabs[0]; }
  if (!tab?.id) throw new Error("Нет активной вкладки");
  if (!tab.url) {
    try {
      const full = await chrome.tabs.get(tab.id);
      if (full.url) tab = full;
      else if ((full as any).pendingUrl) (tab as any).url = (full as any).pendingUrl;
    } catch { /* */ }
  }
  if (!tab.url) {
    const pu = (tab as any).pendingUrl;
    if (pu) (tab as any).url = pu;
  }
  return tab;
}

async function ensureContentScript(tabId: number, tabUrl: string): Promise<boolean> {
  const tryInject = async () => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  };
  try {
    await tryInject();
    return true;
  } catch (e1) {
    swLog.warn(`Инжекция не удалась: ${(e1 as Error).message}`);
    const ok = await ensureOriginPermission(tabUrl);
    if (!ok) {
      swLog.error("Доступ к сайту не предоставлен — пользователь отклонил prompt или Edge не показал его.");
      return false;
    }
    try {
      await tryInject();
      return true;
    } catch (e2) {
      swLog.error(`Повторная инжекция не удалась: ${(e2 as Error).message}`);
      return false;
    }
  }
}

async function scanActiveTab(): Promise<{ candidates: import("../shared/types").RawVideoCandidate[]; pageMeta: { title: string; url: string }; tabUrl: string; }> {
  const t0 = Date.now();
  const tab = await getActiveTab();
  const tabUrl = tab.url || (tab as any).pendingUrl || "";
  if (!tabUrl || /^(chrome|edge|about|chrome-extension):/.test(tabUrl)) {
    throw new Error(`Сканировать можно только http/https страницы. Текущая: ${tabUrl || "(нет URL)"}`);
  }
  swLog.info(`Сканирование вкладки ${tab.id}: ${tabUrl}`);
  const injected = await ensureContentScript(tab.id!, tabUrl);
  if (!injected) throw new Error("Не удалось инжектировать content script");

  // Передаём пользовательские настройки скана (иначе content script получит пустой opts
  // и ВСЕ детекторы окажутся выключены).
  const settingsForScan = await ensureSettingsLoaded();
  const send = () => chrome.tabs.sendMessage(tab.id!, {
    type: "VDE_SCAN_PAGE",
    opts: {
      autoScroll: settingsForScan.autoScroll,
      monitorMs: settingsForScan.monitorMs,
      scanIframes: settingsForScan.scanIframes,
      detectPlayers: settingsForScan.detectPlayers,
      detectSocial: settingsForScan.detectSocial,
      sniffPerfResources: settingsForScan.sniffPerfResources,
      expandManifests: settingsForScan.expandManifests,
      downloadBlobs: settingsForScan.downloadBlobs,
    },
  });
  let resp: any;
  try { resp = await send(); }
  catch (e) {
    swLog.warn(`Контент-скрипт не ответил (${(e as Error).message}) — повторная попытка`);
    await new Promise((r) => setTimeout(r, 400));
    try { resp = await send(); }
    catch (e2) {
      swLog.warn(`Вторая попытка не удалась (${(e2 as Error).message}) — ещё одна`);
      await new Promise((r) => setTimeout(r, 700));
      resp = await send();
    }
  }
  if (!resp?.ok || !resp.result) {
    throw new Error(resp?.error || "Контент-скрипт не вернул результат");
  }
  swLog.info(`Скан OK: ${resp.result.candidates.length} кандидатов за ${Date.now() - t0}ms`);
  return { candidates: resp.result.candidates, pageMeta: resp.result.pageMeta, tabUrl };
}

// ─── Job lifecycle ────────────────────────────────────────────────────────

async function ensureCrawlerFromSnapshot(): Promise<boolean> {
  if (crawler) return true;
  try {
    const snap = await loadJobSnapshot();
    if (!snap || !snap.candidates?.length) return false;
    const settings = await ensureSettingsLoaded();
    crawler = Crawler.fromSnapshot(snap, {
      settings: snap.settings ?? settings,
      rootUrl: snap.rootUrl,
      rootTitle: snap.rootTitle,
      ensureOriginPermission,
      hasOriginPermission,
      onEvent: crawlerEvents,
      persist: () => void saveJobSnapshot(crawler?.snapshot() ?? null),
    });
    swLog.info(`Восстановлена задача из снапшота: ${snap.candidates.length} кандидатов`);
    return true;
  } catch (e) {
    swLog.warn(`Не удалось восстановить задачу: ${(e as Error).message}`);
    return false;
  }
}

async function startJob(): Promise<void> {
  if (crawler) {
    swLog.warn("Предыдущая задача ещё активна — отменяем");
    crawler.cancel();
    await new Promise((r) => setTimeout(r, 100));
  }
  const settings = await ensureSettingsLoaded();
  const { candidates, pageMeta, tabUrl } = await scanActiveTab();

  crawler = new Crawler({
    settings, rootUrl: tabUrl, rootTitle: pageMeta.title,
    ensureOriginPermission, hasOriginPermission, onEvent: crawlerEvents,
    persist: () => saveJobSnapshot(crawler?.snapshot() ?? null),
  });
  crawler.addCandidates(candidates, tabUrl, pageMeta.title);
  crawler.start();
  broadcast({ type: "VDE_SNAPSHOT", payload: crawler.snapshot() });
  broadcast({
    type: "VDE_SCAN_SUMMARY",
    summary: {
      ok: true, tabUrl, injected: true, hits: candidates.length,
      candidates: crawler.snapshot().candidates.length,
      byType: countByType(crawler.snapshot().candidates),
      byContainer: countByContainer(crawler.snapshot().candidates),
      drmCount: crawler.snapshot().candidates.filter((c) => c.isDRM).length,
      manifestCount: crawler.snapshot().candidates.filter((c) => c.isManifest).length,
      blobCount: crawler.snapshot().candidates.filter((c) => c.isBlob).length,
      timeMs: 0, pageTitle: pageMeta.title,
    },
  });
}

function countByType(cands: import("../shared/types").VideoCandidate[]): Partial<Record<import("../shared/types").SourceType, number>> {
  const m: any = {};
  for (const c of cands) m[c.sourceType] = (m[c.sourceType] ?? 0) + 1;
  return m;
}
function countByContainer(cands: import("../shared/types").VideoCandidate[]): Partial<Record<import("../shared/types").Container, number>> {
  const m: any = {};
  for (const c of cands) m[c.container] = (m[c.container] ?? 0) + 1;
  return m;
}

async function onJobFinished(): Promise<void> {
  if (!crawler) return;
  const view = crawler.snapshot();
  if (view.status !== "completed" && view.status !== "cancelled" && view.status !== "failed") return;
  const entry: HistoryEntry = {
    id: view.jobId,
    rootUrl: view.rootUrl,
    rootTitle: view.rootTitle,
    startedAt: view.startedAt ?? Date.now(),
    finishedAt: view.finishedAt ?? Date.now(),
    status: view.status,
    totalFound: view.stats.totalFound,
    totalDownloaded: view.stats.totalDownloaded,
    totalBytes: view.stats.totalBytes,
  };
  const history = await addHistoryEntry(entry);
  broadcast({ type: "VDE_HISTORY", history });
  await saveJobSnapshot(view);
}

// ─── Message router ───────────────────────────────────────────────────────

async function handleMessage(msg: PanelToWorkerMsg, port: chrome.runtime.Port): Promise<void> {
  try {
    switch (msg.type) {
      case "VDE_PING": {
        port.postMessage({ type: "VDE_PONG", ts: Date.now(), swVersion: chrome.runtime.getManifest().version || "?" });
        break;
      }
      case "VDE_SCAN_PAGE": {
        await startJob();
        break;
      }
      case "VDE_DOWNLOAD": {
        if (!crawler) {
          const restored = await ensureCrawlerFromSnapshot();
          if (!restored) await startJob();
        }
        if (!crawler) throw new Error("Не удалось создать задачу");
        crawler.enqueueDownloads(msg.ids);
        broadcast({ type: "VDE_SNAPSHOT", payload: crawler.snapshot() });
        break;
      }
      case "VDE_CANCEL_DOWNLOAD": {
        if (crawler) {
          crawler.cancelDownloads(msg.ids);
          broadcast({ type: "VDE_SNAPSHOT", payload: crawler.snapshot() });
        }
        break;
      }
      case "VDE_PAUSE": crawler?.pause(); break;
      case "VDE_RESUME": crawler?.resume(); break;
      case "VDE_RETRY": {
        if (!crawler) await ensureCrawlerFromSnapshot();
        if (crawler) {
          crawler.retry(msg.ids);
          broadcast({ type: "VDE_SNAPSHOT", payload: crawler.snapshot() });
        }
        break;
      }
      case "VDE_SET_SELECTED": {
        crawler?.setSelected(msg.ids, msg.selected);
        if (crawler) broadcast({ type: "VDE_SNAPSHOT", payload: crawler.snapshot() });
        break;
      }
      case "VDE_GET_STATE": {
        const settings = await ensureSettingsLoaded();
        const history = await loadHistory();
        const v = crawler ? crawler.snapshot() : emptyJobView(settings);
        v.history = history;
        port.postMessage({ type: "VDE_SNAPSHOT", payload: v });
        port.postMessage({ type: "VDE_SETTINGS", settings });
        port.postMessage({ type: "VDE_HISTORY", history });
        break;
      }
      case "VDE_UPDATE_SETTINGS": {
        const settings = await ensureSettingsLoaded();
        currentSettings = { ...settings, ...msg.settings };
        await saveSettings(currentSettings);
        port.postMessage({ type: "VDE_SETTINGS", settings: currentSettings });
        if (crawler) broadcast({ type: "VDE_SNAPSHOT", payload: crawler.snapshot() });
        break;
      }
      case "VDE_CLEAR_JOB": {
        if (crawler) { crawler.cancel(); crawler = null; }
        await saveJobSnapshot(null);
        const settings = await ensureSettingsLoaded();
        broadcast({ type: "VDE_SNAPSHOT", payload: emptyJobView(settings) });
        break;
      }
      case "VDE_SELECT_VARIANT": {
        if (crawler) {
          crawler.setVariant(msg.id, msg.variantId);
          broadcast({ type: "VDE_SNAPSHOT", payload: crawler.snapshot() });
        }
        break;
      }
      case "VDE_GET_LOG": {
        // Уже всё передаётся push'ом; для запроса истории читаем из storage.
        // (не критично, можно опустить)
        break;
      }
    }
  } catch (e) {
    const errMsg = (e as Error)?.message || String(e);
    swLog.error(`Команда не выполнена: ${errMsg}`);
    broadcast({
      type: "VDE_SCAN_SUMMARY",
      summary: { ok: false, injected: false, error: errMsg, hits: 0, candidates: 0, byType: {}, byContainer: {}, drmCount: 0, manifestCount: 0, blobCount: 0, timeMs: 0 },
    });
  }
}

// ─── Диагностика: подслушиваем настоящие заголовки медиа-запросов страницы ──
// download-helper'ы именно так узнают, что требует hotlink-защита сайта.
// Пассивный webRequest (MV3 разрешает observer без блокировки).
// Cookie НЕ логируются (приватность); 1 запись на хост, чтобы не шуметь.
const seenReqHeaders = new Map<string, number>();
function installWebRequestObserver(): void {
  if (!chrome.webRequest?.onBeforeSendHeaders) return;
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        try {
          const url = details.url || "";
          if (!/\.(mp4|webm|mkv|mov|m4v|ts|m3u8|mpd)(\?|$)/i.test(url)) return;
          const key = new URL(url).hostname;
          // До 10 наборов на хост: видны и запросы расширения (fallback) при активном DNR.
          const n = seenReqHeaders.get(key) ?? 0;
          if (n >= 10) return;
          seenReqHeaders.set(key, n + 1);
          const headers = (details.requestHeaders || [])
            .filter((h) => !/^cookie$/i.test(h.name || ""))
            .map((h) => `${h.name}: ${(h.value || "").slice(0, 160)}`)
            .join(" | ");
          swLog.info(`[webrequest] ${key} #${n + 1} (${details.type || "?"}): ${headers || "(пусто)"}`);
        } catch { /* ignore */ }
      },
      { urls: ["http://*/*", "https://*/*"] },
      ["requestHeaders", "extraHeaders"] as unknown as string[]
    );
  } catch { /* ignore */ }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
installWebRequestObserver();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void ensureSettingsLoaded();
  swLog.info("Расширение установлено / обновлено");
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void ensureSettingsLoaded();
  swLog.info("Service worker стартовал");
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  ports.add(port);
  port.onMessage.addListener((msg: PanelToWorkerMsg) => { void handleMessage(msg, port); });
  port.onDisconnect.addListener(() => { ports.delete(port); });
  void (async () => {
    const settings = await ensureSettingsLoaded();
    const history = await loadHistory();
    const v = crawler ? crawler.snapshot() : emptyJobView(settings);
    v.history = history;
    try {
      port.postMessage({ type: "VDE_PONG", ts: Date.now(), swVersion: chrome.runtime.getManifest().version || "?" });
      port.postMessage({ type: "VDE_SETTINGS", settings });
      port.postMessage({ type: "VDE_HISTORY", history });
      port.postMessage({ type: "VDE_SNAPSHOT", payload: v });
    } catch { /* */ }
  })();
});

self.addEventListener("error", (e) => {
  try { swLog.error(`SW error: ${e.message}`); } catch { /* */ }
});
self.addEventListener("unhandledrejection", (e) => {
  try { swLog.error(`SW unhandled rejection: ${String((e as PromiseRejectionEvent).reason ?? "")}`); } catch { /* */ }
});

// Восстановление состояния после рестарта SW.
void (async () => {
  try {
    const snap = await loadJobSnapshot();
    if (snap && snap.candidates.length > 0) {
      swLog.info(`Восстановление снапшота: ${snap.candidates.length} кандидатов, статус: ${snap.status}`);
      broadcast({ type: "VDE_SNAPSHOT", payload: snap });
    }
  } catch (e) {
    swLog.warn(`Восстановление не удалось: ${(e as Error).message}`);
  }
})();
