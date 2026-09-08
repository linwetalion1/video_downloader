// Service worker (MV3). Владеет кроулером, настройками, историей и push-событиями в панель.
import { Crawler, type CrawlerEvent } from "../crawler/crawler";
import {
  addHistoryEntry, loadHistory, loadJobSnapshot, loadSettings, saveJobSnapshot, saveSettings,
} from "../storage/settings";
import type { HistoryEntry, JobView, PanelToWorkerMsg, Settings, UILogEntry, WorkerToPanelMsg } from "../shared/types";
import { throttle } from "../shared/utils";

let crawler: Crawler | null = null;
let currentSettings: Settings | null = null;
const ports = new Set<chrome.runtime.Port>();
let progressInterval: ReturnType<typeof setInterval> | undefined;

// ─── Утилиты ──────────────────────────────────────────────────────────────

async function ensureSettingsLoaded(): Promise<Settings> {
  currentSettings ??= await loadSettings();
  return currentSettings;
}

function broadcast(msg: WorkerToPanelMsg): void {
  if (ports.size === 0) {
    // SW часто перезапускается — если портов 0, лог всё равно видно в консоли SW (edge://extensions → Service Worker → Inspect)
    try { console.warn("[IDE broadcast no ports]", msg.type, msg); } catch { /* ignore */ }
  }
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch {
      ports.delete(port);
    }
  }
}

function emptyJobView(settings: Settings): JobView {
  return {
    jobId: "",
    mode: "page",
    rootUrl: "",
    status: "idle",
    settings,
    candidates: [],
    errors: [],
    taskCounts: { queued: 0, running: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0, total: 0 },
    stats: {
      pagesVisited: 0, imagesFound: 0, downloadsCompleted: 0, downloadBytes: 0,
      errors: 0, limitImagesReached: false, limitPagesReached: false,
    },
    logTail: [],
  };
}

const persistThrottled = throttle(() => {
  void (async () => {
    try {
      if (crawler) await saveJobSnapshot(crawler.snapshot());
    } catch (e) {
      broadcastLog("WARN", `Не удалось сохранить снимок: ${String((e as Error)?.message || e)}`);
    }
  })();
}, 1200);

let lastPersistedStatus = "";
const persistOnStatus = async (status: string) => {
  if (status === lastPersistedStatus) return;
  lastPersistedStatus = status;
  if (crawler && ["completed", "cancelled", "failed"].includes(status)) {
    persistThrottled.flush();
    await saveJobSnapshot(crawler.snapshot());
    await onJobFinished();
  }
};

const crawlerEvents = (ev: CrawlerEvent): void => {
  switch (ev.type) {
    case "candidate": broadcast({ type: "IDE_CANDIDATE", candidate: ev.candidate }); break;
    case "candidate_update": broadcast({ type: "IDE_CANDIDATE_UPDATE", id: ev.id, patch: ev.patch }); break;
    case "stats": broadcast({ type: "IDE_STATS", stats: ev.stats }); break;
    case "status":
      broadcast({ type: "IDE_STATUS", status: ev.status });
      void persistOnStatus(ev.status);
      break;
    case "tasks": broadcast({ type: "IDE_TASKS", tasks: ev.counts }); break;
    case "error": broadcast({ type: "IDE_ERROR_ITEM", error: ev.error }); break;
    case "log": broadcast({ type: "IDE_LOG", entry: ev.entry }); break;
  }
  void persistThrottled();
};

async function onJobFinished(): Promise<void> {
  if (!crawler || !crawler.snapshot().startedAt) return;
  const view = crawler.snapshot();
  const entry: HistoryEntry = {
    id: view.jobId,
    rootUrl: view.rootUrl,
    mode: view.mode,
    startedAt: view.startedAt ?? Date.now(),
    finishedAt: view.finishedAt ?? Date.now(),
    status: view.status,
    imagesFound: view.stats.imagesFound,
    downloadsCompleted: view.stats.downloadsCompleted,
  };
  const history = await addHistoryEntry(entry);
  broadcast({ type: "IDE_HISTORY", history });
}

// ─── Permissions ──────────────────────────────────────────────────────────

async function hasOriginPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin;
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

async function ensureOriginPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin;
    const pattern = `${origin}/*`;
    const has = await chrome.permissions.contains({ origins: [pattern] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

// ─── Контент-скрипт ───────────────────────────────────────────────────────

/** Инжектирует content.js в вкладку (activeTab; фолбек — optional host permission). */
async function ensureContentScript(tabId: number, tabUrl?: string): Promise<boolean> {
  const tryInject = async () => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  };
  try {
    await tryInject();
    return true;
  } catch (e1) {
    broadcastLog("DEBUG", `Инжекция не удалась (${String((e1 as Error)?.message || e1)}) — запрашиваю разрешение…`);
    try {
      const ok = await ensureOriginPermission(tabUrl ?? "");
      if (!ok) {
        broadcastLog(
          "ERROR",
          "Доступ к сайту не предоставлен (chrome.permissions.request вернул false без диалога — Edge не показал prompt из фона). " +
          "Решение: edge://extensions → карточка расширения → «Сведения о сайте»/«Site access» → «Разрешить на всех сайтах» или добавьте hosts в manifest host_permissions и перезагрузите расширение. " +
          "Альтернатива: sidePanel теперь запрашивает разрешение напрямую при клике «Найти» — нажмите кнопку ещё раз."
        );
        return false;
      }
      await tryInject();
      return true;
    } catch (e2) {
      broadcastLog("ERROR", `Инжекция контент-скрипта провалилась: ${String((e2 as Error)?.message || e2)} — проверьте host_permissions в manifest и доступ к сайту в edge://extensions`);
      return false;
    }
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  // Пробуем lastFocusedWindow, затем currentWindow — без "tabs" URL часто пустой (активная вкладка без host permission).
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = tabs[0];
  if (!tab) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  }
  if (!tab?.id) throw new Error("Нет активной вкладки (chrome.tabs.query вернул пусто — проверьте, что окно в фокусе)");
  // Если url скрыт из-за отсутствия "tabs" permission, пробуем дочитать через get (требует tabs)
  if (!tab.url && tab.id) {
    try {
      const full = await chrome.tabs.get(tab.id);
      if (full.url) tab = full;
      else if ((full as unknown as { pendingUrl?: string }).pendingUrl) {
        (tab as unknown as { url: string }).url = (full as unknown as { pendingUrl: string }).pendingUrl!;
      }
    } catch {
      // ignore
    }
  }
  // Фолбек на pendingUrl (навигация в процессе)
  if (!tab.url) {
    const pu = (tab as unknown as { pendingUrl?: string }).pendingUrl;
    if (pu) (tab as unknown as { url: string }).url = pu;
  }
  return tab;
}

async function scanActiveTab(autoScroll: boolean, monitorMs?: number) {
  const t0 = performance.now();
  const tab = await getActiveTab();
  const tabUrl = tab.url || (tab as unknown as { pendingUrl?: string }).pendingUrl || "";
  if (!tabUrl || /^(chrome|edge|about|chrome-extension):/.test(tabUrl)) {
    throw new Error(
      `Эту страницу нельзя сканировать: ${tabUrl || "(нет URL)"}. ` +
      `Откройте обычную https:// страницу и убедитесь, что расширение имеет разрешение "tabs" (перезагрузите расширение). tabId=${tab.id} title="${tab.title || ""}"`
    );
  }
  // Используем единый tabUrl далее
  const effectiveUrl = tabUrl;
  broadcastLog("INFO", `Сканирование вкладки ${tab.id}: ${effectiveUrl}`);
  const injected = await ensureContentScript(tab.id!, effectiveUrl);
  if (!injected) {
    throw new Error("Не удалось внедрить контент-скрипт: нет доступа к вкладке");
  }
  const requestScan = () =>
    chrome.tabs.sendMessage(tab.id!, {
      type: "IDE_SCAN_PAGE",
      autoScroll,
      monitorMs,
    } satisfies PanelToWorkerMsg);
  let resp;
  try {
    resp = await requestScan();
  } catch (e) {
    // Ресивер может быть ещё не готов после инжекции — повторяем до 2 раз с нарастающей задержкой.
    broadcastLog("WARN", `Контент-скрипт не ответил (${String((e as Error)?.message || e)}) — повторная попытка…`);
    await new Promise((r) => setTimeout(r, 400));
    try {
      resp = await requestScan();
    } catch (e2) {
      broadcastLog("WARN", `Вторая попытка не удалась (${String((e2 as Error)?.message || e2)}) — ещё одна попытка…`);
      await new Promise((r) => setTimeout(r, 700));
      resp = await requestScan();
    }
  }
  if (!resp?.ok || !resp.result) {
    const errText = resp?.error || "Контент-скрипт не ответил";
    broadcastLog("ERROR", `Скан завершился ошибкой: ${errText}`);
    throw new Error(errText);
  }
  const s = resp.result.stats;
  broadcastLog(
    "INFO",
    `Скан OK: hits=${resp.result.hits.length}, links=${s.links}, img-элементов=${s.imgElements}, ` +
      `canvas=${s.canvasElements}, shadowRoots=${s.shadowRootsOpened}, ` +
      `по типам=${JSON.stringify(s.sourceTypeCounts)}, автоскролл=${s.autoScrollSteps} шаг., ` +
      `мутаций=${s.mutationHits}, ${Math.round(s.scanTimeMs)}ms`
  );
  if (resp.result.hits.length === 0) {
    broadcastLog(
      "WARN",
      "Найдено 0 изображений. Возможные причины: контент в закрытых shadow root / canvas / JS-рендер. " +
        "Включите прокрутку и мониторинг динамики, откройте вкладку «Отладка» в панели."
    );
  }
  return { result: resp.result, tab, effectiveUrl, timeMs: Math.round(performance.now() - t0) };
}

function broadcastLog(level: UILogEntry["level"], message: string): void {
  broadcast({ type: "IDE_LOG", entry: { time: Date.now(), level, message } });
}


// ─── Команды панели ───────────────────────────────────────────────────────

function startProgressInterval(): void {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(() => {
    if (crawler && (crawler.getState() === "running" || crawler.getState() === "paused")) {
      try { broadcast({ type: "IDE_SNAPSHOT", payload: crawler.snapshot() }); } catch { /* ignore */ }
    } else {
      if (progressInterval) { clearInterval(progressInterval); progressInterval = undefined; }
    }
  }, 1500);
}
function stopProgressInterval(): void {
  if (progressInterval) { clearInterval(progressInterval); progressInterval = undefined; }
}

function crawlerDeps(settings: Settings, rootUrl: string, mode: "page" | "crawl") {
  return {
    settings,
    rootUrl,
    mode,
    ensureOriginPermission,
    hasOriginPermission,
    onEvent: crawlerEvents,
    persist: () => persistThrottled(),
  };
}

async function restoreCrawlerIfNeeded(): Promise<Crawler | null> {
  if (crawler) return crawler;
  const snap = await loadJobSnapshot();
  if (!snap || !snap.candidates?.length) return null;
  const settings = await ensureSettingsLoaded();
  crawler = Crawler.fromSnapshot(snap, crawlerDeps(snap.settings ?? settings, snap.rootUrl, snap.mode));
  startProgressInterval();
  return crawler;
}

async function startPageJob(autoScroll: boolean, monitorMs?: number): Promise<void> {
  stopCurrent();
  const t0 = performance.now();
  const { result, tab: _tab, effectiveUrl, timeMs } = await scanActiveTab(autoScroll, monitorMs);
  const settings = await ensureSettingsLoaded();
  crawler = new Crawler({
    settings,
    rootUrl: effectiveUrl || result.pageMeta.url,
    mode: "page",
    ensureOriginPermission,
    hasOriginPermission,
    onEvent: crawlerEvents,
    persist: () => void persistThrottled(),
  });
  crawler.addSourcePageTitle(result.pageMeta.url, result.pageMeta.title);
  crawler.addPageHits(result.hits, result.pageMeta.url, 0, result.pageMeta.title);
  crawler.startSchedulerOnly();
  startProgressInterval();
  const view = crawler.snapshot();
  broadcast({ type: "IDE_SNAPSHOT", payload: view });
  broadcast({
    type: "IDE_SCAN_SUMMARY",
    summary: {
      ok: true,
      tabUrl: effectiveUrl,
      injected: true,
      hits: result.hits.length,
      links: result.stats.links,
      candidates: view.candidates.length,
      timeMs: Math.round(performance.now() - t0) + timeMs,
      stats: result.stats,
    },
  });
  void persistThrottled();
}

async function startCrawlJob(rootUrl: string, settings: Settings): Promise<void> {
  stopCurrent();
  currentSettings = settings;
  await saveSettings(settings);
  if (!rootUrl) {
    try {
      const tab = await getActiveTab();
      rootUrl = tab.url ?? "";
    } catch {
      rootUrl = "";
    }
  }
  if (!rootUrl) {
    throw new Error("Нет активной вкладки для глубокого поиска");
  }
  const granted = await ensureOriginPermission(rootUrl);
  if (!granted) {
    throw new Error(`Нет доступа к ${rootUrl} — глубокий поиск невозможен. Разрешите доступ к сайту.`);
  }
  crawler = new Crawler({
    settings,
    rootUrl,
    mode: "crawl",
    ensureOriginPermission,
    hasOriginPermission,
    onEvent: crawlerEvents,
    persist: () => void persistThrottled(),
  });
  crawler.startCrawl();
  startProgressInterval();
  broadcast({ type: "IDE_SNAPSHOT", payload: crawler.snapshot() });
  void persistThrottled();
}

function stopCurrent(): void {
  stopProgressInterval();
  persistThrottled.flush();
  if (crawler) {
    const st = crawler.getState();
    if (st !== "completed" && st !== "cancelled" && st !== "failed") {
      try { crawler.cancel(); } catch { /* ignore */ }
    }
    crawler = null;
  }
}

// ─── Роутер ───────────────────────────────────────────────────────────────

async function handleMessage(msg: PanelToWorkerMsg, port: chrome.runtime.Port): Promise<void> {
  try {
    switch (msg.type) {
      case "IDE_SCAN_PAGE": {
        await startPageJob(!!msg.autoScroll, msg.monitorMs);
        break;
      }
      case "IDE_START_JOB": {
        await startCrawlJob(msg.rootUrl, msg.settings);
        break;
      }
      case "IDE_PAUSE": crawler?.pause(); break;
      case "IDE_RESUME": crawler?.resume(); break;
      case "IDE_CANCEL": stopCurrent(); break;
      case "IDE_GET_STATE": {
        const settings = await ensureSettingsLoaded();
        const history = await loadHistory();
        const live = await restoreCrawlerIfNeeded();
        if (live) {
          port.postMessage({ type: "IDE_SNAPSHOT", payload: live.snapshot() } satisfies WorkerToPanelMsg);
        } else {
          port.postMessage({ type: "IDE_SNAPSHOT", payload: emptyJobView(settings) } satisfies WorkerToPanelMsg);
        }
        port.postMessage({ type: "IDE_SETTINGS", settings } satisfies WorkerToPanelMsg);
        port.postMessage({ type: "IDE_HISTORY", history } satisfies WorkerToPanelMsg);
        break;
      }
      case "IDE_UPDATE_SETTINGS": {
        const settings = await ensureSettingsLoaded();
        const merged: Settings = { ...settings, ...msg.settings };
        currentSettings = merged;
        await saveSettings(merged);
        port.postMessage({ type: "IDE_SETTINGS", settings: merged } satisfies WorkerToPanelMsg);
        break;
      }
      case "IDE_DOWNLOAD_SELECTED": {
        const live = await restoreCrawlerIfNeeded();
        if (!live) throw new Error("Нет активной задачи");
        live.enqueueDownloads(msg.ids);
        startProgressInterval();
        break;
      }
      case "IDE_RETRY_FAILED": {
        const live = await restoreCrawlerIfNeeded();
        if (!live) throw new Error("Нет активной задачи");
        live.retryFailed();
        startProgressInterval();
        break;
      }
      case "IDE_PING": {
        port.postMessage({
          type: "IDE_PONG",
          ts: Date.now(),
          swVersion: chrome.runtime.getManifest().version || "?",
        } satisfies WorkerToPanelMsg);
        break;
      }
      case "IDE_CLEAR_JOB": {
        stopCurrent();
        await saveJobSnapshot(null);
        const settings = await ensureSettingsLoaded();
        broadcast({ type: "IDE_SNAPSHOT", payload: emptyJobView(settings) });
        break;
      }
    }
  } catch (e) {
    const errMsg = (e as Error)?.message || String(e);
    broadcastLog("ERROR", `Команда не выполнена: ${errMsg}`);
    broadcast({
      type: "IDE_SCAN_SUMMARY",
      summary: { ok: false, injected: false, error: errMsg, hits: 0, links: 0, candidates: 0, timeMs: 0 },
    });
  }
}

// ─── Жизненный цикл ───────────────────────────────────────────────────────

// КРИТИЧНО: setPanelBehavior должен вызываться на верхнем уровне (не только в onInstalled),
// иначе после «Перезагрузить» в edge://extensions клик по иконке не открывает панель.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void ensureSettingsLoaded();
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void ensureSettingsLoaded();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  ports.add(port);
  port.onMessage.addListener((msg: PanelToWorkerMsg) => {
    void handleMessage(msg, port);
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
  });
  void port.postMessage({ type: "IDE_HISTORY", history: [] } satisfies WorkerToPanelMsg);
  void (async () => {
    const history = await loadHistory();
    const settings = await ensureSettingsLoaded();
    try {
      port.postMessage({ type: "IDE_PONG", ts: Date.now(), swVersion: chrome.runtime.getManifest().version || "?" } satisfies WorkerToPanelMsg);
      port.postMessage({ type: "IDE_SETTINGS", settings } satisfies WorkerToPanelMsg);
      port.postMessage({ type: "IDE_HISTORY", history } satisfies WorkerToPanelMsg);
    } catch { /* порт закрылся */ }
  })();
});

// Перехват ошибок SW: любая необработанная ошибка видна в панели (отладка).
self.addEventListener("error", (e) => {
  try {
    broadcastLog("ERROR", `SW error: ${e.message}`);
  } catch { /* noop */ }
});
self.addEventListener("unhandledrejection", (e) => {
  try {
    broadcastLog("ERROR", `SW unhandled rejection: ${String((e as PromiseRejectionEvent).reason ?? "")}`);
  } catch { /* noop */ }
});

// Восстановление состояния после перезапуска SW (ТЗ §40).
void (async () => {
  try {
    const snapshot = await loadJobSnapshot();
    if (snapshot && snapshot.candidates.length > 0 && snapshot.status !== "completed") {
      // Просто отдаём снимок — UI сам решает, продолжать ли (resume создаст новый crawler).
      broadcast({ type: "IDE_SNAPSHOT", payload: snapshot });
    }
  } catch (e) {
    broadcastLog("WARN", `Восстановление снимка не удалось: ${String((e as Error)?.message || e)}`);
  }
})();