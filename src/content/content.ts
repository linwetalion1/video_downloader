// Точка входа контент-скрипта. Инжектируется по требованию через scripting.executeScript
// (activeTab) и обслуживает запросы сканирования от service worker.
import { scanPage } from "./scanner";

const FLAG = "__IMAGE_DOWNLOADER_EXPLORER_READY__";

if (!(globalThis as Record<string, unknown>)[FLAG]) {
  (globalThis as Record<string, unknown>)[FLAG] = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "IDE_SCAN_PAGE") return;
    scanPage(document, {
      baseUrl: location.href,
      autoScroll: !!msg.autoScroll,
      monitorMs: typeof msg.monitorMs === "number" ? msg.monitorMs : undefined,
    })
      .then((result) => {
        // Лог в консоль страницы: видно в DevTools самой вкладки.
        console.info(
          `[IDE] scan OK: hits=${result.hits.length}, links=${result.stats.links}, ` +
          `imgElements=${result.stats.imgElements}, canvas=${result.stats.canvasElements}, ` +
          `shadowRoots=${result.stats.shadowRootsOpened}, byType=${JSON.stringify(result.stats.sourceTypeCounts)}, ` +
          `autoScrollSteps=${result.stats.autoScrollSteps}, mutationHits=${result.stats.mutationHits}, ` +
          `${Math.round(result.stats.scanTimeMs)}ms`
        );
        sendResponse({ ok: true, result });
      })
      .catch((e) => {
        console.error("[IDE] scan error:", e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
    return true; // async response
  });

  console.info("[IDE] content script ready");
}