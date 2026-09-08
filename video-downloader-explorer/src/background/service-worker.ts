// Service worker (MV3). Клей между content script, crawler и UI.
//
// ИЗОЛЯЦИЯ ПО ВКЛАДКАМ: у каждой вкладки — свой Crawler и свой снапшот.
// Панель всегда показывает состояние АКТИВНОЙ вкладки («с чистого листа»,
// если на ней ничего не сканировали). Скачивания в других вкладках
// продолжаются в фоне; при переключении вкладки панель получает их снапшот.
import { Crawler } from "../crawler/orchestrator";
import type { CrawlerDeps } from "../crawler/orchestrator";
import { VDE_MAIN_WORLD_SNIFFER } from "./main-world-sniffer";
import {
  addHistoryEntry, loadHistory, loadJobSnapshotFor, loadSettings,
  removeJobSnapshot, saveJobSnapshotFor, saveSettings,
} from "../storage/settings";
import { addLogListener, initLogsFromStorage, logger, setLogLevel, swLog } from "../shared/logger";
import type { HistoryEntry, JobView, PanelToWorkerMsg, Settings, WorkerToPanelMsg, CrawlerEvent } from "../shared/types";
import { uid } from "../shared/utils";

const crawlers = new Map<number, Crawler>();
let currentTabId: number | null = null;
let currentSettings: Settings | null = null;
const ports = new Set<chrome.runtime.Port>();

// ─── Init ─────────────────────────────────────────────────────────────────

void initLogsFromStorage();
setLogLevel("INFO");

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

function snapshotOf(tabId: number): JobView {
  const c = crawlers.get(tabId);
  if (c) return c.snapshot();
  return emptyJobView(currentSettings ?? ({} as Settings));
}

/** События конкретного краулера: в UI уходят только если его вкладка активна. */
function makeCrawlerEvents(tabId: number): (ev: CrawlerEvent) => void {
  return (ev: CrawlerEvent): void => {
    const isCurrent = tabId === currentTabId;
    switch (ev.type) {
      case "candidate":
        if (isCurrent) broadcast({ type: "VDE_CANDIDATE", candidate: ev.candidate });
        break;
      case "candidateUpdate":
        if (isCurrent) broadcast({ type: "VDE_CANDIDATE_UPDATE", id: ev.id, patch: ev.patch });
        break;
      case "stats":
        if (isCurrent) broadcast({ type: "VDE_STATS", stats: ev.stats });
        break;
      case "status":
        void onJobFinished(tabId);
        if (isCurrent) broadcast({ type: "VDE_SNAPSHOT", payload: snapshotOf(tabId) });
        break;
      case "tasks": {
        if (!isCurrent) break;
        const v = snapshotOf(tabId);
        v.taskCounts = ev.counts;
        broadcast({ type: "VDE_SNAPSHOT", payload: v });
        break;
      }
      // Логи в UI доставляет глобальный addLogListener — иначе дублируются ×2.
      case "log": break;
      case "logBatch": break;
      case "error": break;
    }
  };
}

function makeCrawlerDeps(tabId: number, settings: Settings, rootUrl: string, rootTitle?: string): CrawlerDeps {
  return {
    settings, rootUrl, rootTitle,
    ensureOriginPermission,
    hasOriginPermission,
    onEvent: makeCrawlerEvents(tabId),
    persist: () => {
      const c = crawlers.get(tabId);
      if (c) void saveJobSnapshotFor(tabId, c.snapshot());
    },
  };
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

/** Определяет активную вкладку и запоминает её как «текущую» для панели. */
async function resolveActiveTabId(): Promise<number | null> {
  try {
    const tab = await getActiveTab();
    currentTabId = tab.id ?? null;
  } catch { /* нет окна/вкладки — оставляем прежнюю */ }
  return currentTabId;
}

async function ensureContentScript(tabId: number, tabUrl: string): Promise<boolean> {
  const tryInject = async () => {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    }
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

/** MAIN-world сниффер fetch/XHR страницы: манифесты, mp4, JSON API
 *  (Instagram GraphQL и т.п.). Инжект до каждого скана — идемпотентен. */
async function installMainWorldSniffer(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN" as chrome.scripting.ExecutionWorld, func: VDE_MAIN_WORLD_SNIFFER });
    swLog.info("MAIN-world сниффер сети установлен");
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN" as chrome.scripting.ExecutionWorld, func: VDE_MAIN_WORLD_SNIFFER });
      swLog.info("MAIN-world сниффер сети установлен (главный фрейм)");
    } catch (e) {
      swLog.warn(`MAIN-world сниффер не установлен: ${(e as Error).message}`);
    }
  }
}

async function scanActiveTab(): Promise<{ candidates: import("../shared/types").RawVideoCandidate[]; pageMeta: { title: string; url: string }; tabUrl: string; }> {
  const t0 = Date.now();
  const tab = await getActiveTab();
  const tabUrl = tab.url || (tab as any).pendingUrl || "";
  if (!tabUrl || /^(chrome|edge|about|chrome-extension|edge-extension):/.test(tabUrl)) {
    throw new Error(`Сканировать можно только http/https страницы. Текущая: ${tabUrl || "(нет URL)"}`);
  }
  swLog.info(`Сканирование вкладки ${tab.id}: ${tabUrl}`);
  const injected = await ensureContentScript(tab.id!, tabUrl);
  if (!injected) throw new Error("Не удалось инжектировать content script");
  await installMainWorldSniffer(tab.id!);

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
  const domCandidates: import("../shared/types").RawVideoCandidate[] = resp.result.candidates || [];
  const netCandidates: import("../shared/types").RawVideoCandidate[] = Array.from(tabMediaRequests.get(tab.id!)?.values() || []);

  const seenUrls = new Set<string>();
  const candidates: import("../shared/types").RawVideoCandidate[] = [];
  for (const c of [...domCandidates, ...netCandidates]) {
    if (!seenUrls.has(c.videoUrl)) {
      seenUrls.add(c.videoUrl);
      candidates.push(c);
    }
  }

  swLog.info(`Скан OK: ${candidates.length} кандидатов (${domCandidates.length} из DOM, ${netCandidates.length} из сети) за ${Date.now() - t0}ms`);
  return { candidates, pageMeta: resp.result.pageMeta, tabUrl };
}

// ─── Job lifecycle (per-tab) ──────────────────────────────────────────────

/** Восстановление краулера вкладки из её снапшота (после рестарта SW). */
async function restoreCrawlerFor(tabId: number): Promise<Crawler | undefined> {
  if (crawlers.has(tabId)) return crawlers.get(tabId);
  try {
    const snap = await loadJobSnapshotFor(tabId);
    if (!snap || !snap.candidates?.length) return undefined;
    const settings = snap.settings ?? (await ensureSettingsLoaded());
    const restored = Crawler.fromSnapshot(snap, makeCrawlerDeps(tabId, settings, snap.rootUrl, snap.rootTitle));
    crawlers.set(tabId, restored);
    swLog.info(`Восстановлена задача вкладки ${tabId}: ${snap.candidates.length} кандидатов`);
    return restored;
  } catch (e) {
    swLog.warn(`Не удалось восстановить задачу вкладки ${tabId}: ${(e as Error).message}`);
    return undefined;
  }
}

async function startJob(): Promise<void> {
  const tab = await getActiveTab();
  const tabId = tab.id!;
  currentTabId = tabId;
  const settings = await ensureSettingsLoaded();

  // Предыдущая задача ЭТОЙ вкладки отменяется; другие вкладки не трогаем.
  const prev = crawlers.get(tabId);
  if (prev) {
    swLog.warn("Предыдущая задача этой вкладки ещё активна — отменяем");
    prev.cancel();
    prev.destroy();
    await new Promise((r) => setTimeout(r, 100));
  }

  const { candidates, pageMeta, tabUrl } = await scanActiveTab();

  const crawler = new Crawler(makeCrawlerDeps(tabId, settings, tabUrl, pageMeta.title));
  crawlers.set(tabId, crawler);
  crawler.addCandidates(candidates, tabUrl, pageMeta.title);
  crawler.start();

  const view = crawler.snapshot();
  broadcast({ type: "VDE_SNAPSHOT", payload: view });
  broadcast({
    type: "VDE_SCAN_SUMMARY",
    summary: {
      ok: true, tabUrl, injected: true, hits: candidates.length,
      candidates: view.candidates.length,
      byType: countByType(view.candidates),
      byContainer: countByContainer(view.candidates),
      drmCount: view.candidates.filter((c) => c.isDRM).length,
      manifestCount: view.candidates.filter((c) => c.isManifest).length,
      blobCount: view.candidates.filter((c) => c.isBlob).length,
      timeMs: 0, pageTitle: pageMeta.title,
    },
  });
  void saveJobSnapshotFor(tabId, view);
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

async function onJobFinished(tabId: number): Promise<void> {
  const crawler = crawlers.get(tabId);
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
  void saveJobSnapshotFor(tabId, view);
}

/** Получить краулер текущей вкладки: из карты или восстановить из снапшота. */
async function crawlerForCurrentTab(): Promise<Crawler | undefined> {
  const tabId = await resolveActiveTabId();
  if (tabId == null) return undefined;
  let c = crawlers.get(tabId);
  if (!c) c = await restoreCrawlerFor(tabId);
  return c;
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
        let c = await crawlerForCurrentTab();
        if (!c) { await startJob(); c = await crawlerForCurrentTab(); }
        if (!c) throw new Error("Не удалось создать задачу");
        c.enqueueDownloads(msg.ids);
        const tabIdNow = await resolveActiveTabId();
        if (tabIdNow != null) broadcast({ type: "VDE_SNAPSHOT", payload: snapshotOf(tabIdNow) });
        break;
      }
      case "VDE_CANCEL_DOWNLOAD": {
        const tabId = await resolveActiveTabId();
        const c = tabId != null ? crawlers.get(tabId) : undefined;
        if (c && tabId != null) {
          c.cancelDownloads(msg.ids);
          broadcast({ type: "VDE_SNAPSHOT", payload: snapshotOf(tabId) });
        }
        break;
      }
      case "VDE_PAUSE": (await crawlerForCurrentTab())?.pause(); break;
      case "VDE_RESUME": (await crawlerForCurrentTab())?.resume(); break;
      case "VDE_RETRY": {
        const c = await crawlerForCurrentTab();
        if (c) {
          c.retry(msg.ids);
          const tabIdNow = await resolveActiveTabId();
          if (tabIdNow != null) broadcast({ type: "VDE_SNAPSHOT", payload: snapshotOf(tabIdNow) });
        }
        break;
      }
      case "VDE_SET_SELECTED": {
        const c = await crawlerForCurrentTab();
        c?.setSelected(msg.ids, msg.selected);
        if (c) {
          const tabIdNow = await resolveActiveTabId();
          if (tabIdNow != null) broadcast({ type: "VDE_SNAPSHOT", payload: snapshotOf(tabIdNow) });
        }
        break;
      }
      case "VDE_GET_STATE": {
        const settings = await ensureSettingsLoaded();
        const history = await loadHistory();
        const tabId = await resolveActiveTabId();
        const v = tabId != null ? snapshotOf(tabId) : emptyJobView(settings);
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
        if (currentTabId != null) broadcast({ type: "VDE_SNAPSHOT", payload: snapshotOf(currentTabId) });
        break;
      }
      case "VDE_CLEAR_JOB": {
        const tabId = await resolveActiveTabId();
        if (tabId != null) {
          const c = crawlers.get(tabId);
          if (c) { c.cancel(); crawlers.delete(tabId); }
          await removeJobSnapshot(tabId);
          const settings = await ensureSettingsLoaded();
          broadcast({ type: "VDE_SNAPSHOT", payload: emptyJobView(settings) });
        }
        break;
      }
      case "VDE_SELECT_VARIANT": {
        const c = await crawlerForCurrentTab();
        if (c) {
          c.setVariant(msg.id, msg.variantId);
          const tabIdNow = await resolveActiveTabId();
          if (tabIdNow != null) broadcast({ type: "VDE_SNAPSHOT", payload: snapshotOf(tabIdNow) });
        }
        break;
      }
      case "VDE_GET_LOG": {
        // Логи доставляются пушем через глобальный слушатель.
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

// ─── Сетевой перехват webRequest: ловит реальные медиа-потоки браузера ─────
// Ловит нативные <video src>, iframe-плееры, DASH/HLS манифесты и чанки,
// даже если DOM изолирован в cross-origin iframe или shadow root.
const tabMediaRequests = new Map<number, Map<string, import("../shared/types").RawVideoCandidate>>();
const seenReqHeaders = new Map<string, number>();

function installWebRequestObserver(): void {
  if (!chrome.webRequest?.onBeforeSendHeaders) return;
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        try {
          const url = details.url || "";
          const isMediaReq = details.type === "media";
          const isMediaExt = /\.(mp4|webm|mkv|mov|m4v|ts|m3u8|mpd)(\?|$)/i.test(url);
          const isKnownMediaPattern = /videoplayback|\/hls\/|\/live\/|\/stream\/|\.mmcdn\.com/i.test(url);
          if (!isMediaReq && !isMediaExt && !isKnownMediaPattern) return;

          // Регистрируем кандидата в сетевой буфер вкладки
          const isHls = /\.m3u8(\?|$)/i.test(url) || /\/hls\//i.test(url);
          const isDash = /\.mpd(\?|$)/i.test(url) || /\/dash\//i.test(url);
          const isWebm = /\.webm(\?|$)/i.test(url);
          const container = isHls ? "hls" : isDash ? "dash" : (isWebm ? "webm" : "mp4");
          const cand: import("../shared/types").RawVideoCandidate = {
            videoUrl: url,
            sourceType: "webrequest",
            container,
            isManifest: isHls || isDash,
            mimeType: isHls ? "application/x-mpegurl" : isDash ? "application/dash+xml" : (isWebm ? "video/webm" : "video/mp4"),
            context: { via: "webrequest", type: details.type },
          };

          if (details.tabId > 0) {
            let m = tabMediaRequests.get(details.tabId);
            if (!m) { m = new Map(); tabMediaRequests.set(details.tabId, m); }
            m.set(url, cand);

            const c = crawlers.get(details.tabId);
            if (c) {
              c.addCandidates([cand], c.rootUrl || url, c.rootTitle);
            }
          }

          const key = new URL(url).hostname;
          const n = seenReqHeaders.get(key) ?? 0;
          if (n < 10) {
            seenReqHeaders.set(key, n + 1);
            const headers = (details.requestHeaders || [])
              .map((h) => {
                const name = h.name || "";
                const value = h.value || "";
                if (/^cookie$|^authorization$/i.test(name)) return `${name}: <hidden>`;
                if (/^referer$/i.test(name)) {
                  try { return `Referer: ${new URL(value).origin}/`; } catch { return "Referer: <invalid>"; }
                }
                return `${name}: ${value.slice(0, 120)}`;
              })
              .join(" | ");
            swLog.info(`[webrequest] ${key} #${n + 1} (${details.type || "?"}): ${headers || "(пусто)"}`);
          }
        } catch { /* ignore */ }
      },
      { urls: ["http://*/*", "https://*/*"] },
      ["requestHeaders", "extraHeaders"] as unknown as string[]
    );
  } catch { /* ignore */ }
}

// Слушатель сообщений от sub-frame контент-скриптов
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "VDE_FRAME_CANDIDATES" && Array.isArray(msg.candidates)) {
    const tabId = sender.tab?.id;
    if (tabId && tabId > 0) {
      let m = tabMediaRequests.get(tabId);
      if (!m) { m = new Map(); tabMediaRequests.set(tabId, m); }
      for (const c of msg.candidates) {
        if (c?.videoUrl) m.set(c.videoUrl, c);
      }
      const crawler = crawlers.get(tabId);
      if (crawler) {
        crawler.addCandidates(msg.candidates, sender.tab?.url || msg.frameUrl || "", sender.tab?.title);
      }
      swLog.info(`Subframe (${sender.tab?.title || tabId}): +${msg.candidates.length} кандидатов из фрейма`);
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ─── Tabs lifecycle: переключение/закрытие/навигация ──────────────────────

chrome.tabs.onActivated.addListener(({ tabId }) => {
  currentTabId = tabId;
  // Панель мгновенно переключается на состояние этой вкладки
  // («чистый лист», если на ней ничего не сканировали).
  void (async () => {
    await ensureSettingsLoaded();
    broadcast({ type: "VDE_SNAPSHOT", payload: snapshotOf(tabId) });
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaRequests.delete(tabId);
  const c = crawlers.get(tabId);
  if (c) { c.cancel(); c.destroy(); }
  crawlers.delete(tabId);
  void removeJobSnapshot(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // Сниффер полезно ставить ЗАРАНЕЕ: тогда к моменту скана в буфере уже есть
  // манифесты/сегменты, запрошенные плеером при загрузке страницы.
  const url = info.url || tab.url || "";
  if (/^https?:/i.test(url)) {
    void installMainWorldSniffer(tabId);
  }
  if (!info.url) return;
  const c = crawlers.get(tabId);
  if (!c || !c.rootUrl) return;
  // Навигация на другой URL — сбрасываем результаты этой вкладки
  // (кроме случая, когда задача ещё активно работает).
  if (info.url !== c.rootUrl && c.getState() !== "running") {
    c.cancel();
    c.destroy();
    crawlers.delete(tabId);
    void removeJobSnapshot(tabId);
    if (tabId === currentTabId) {
      void (async () => {
        await ensureSettingsLoaded();
        broadcast({ type: "VDE_SNAPSHOT", payload: snapshotOf(tabId) });
      })();
    }
  }
});

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
    const tabId = await resolveActiveTabId();
    const v = tabId != null ? snapshotOf(tabId) : emptyJobView(settings);
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
