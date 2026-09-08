// Content script (IIFE). Инжектируется по требованию.
// Возможности:
//   - поиск всех <video> и <source> с deep-обходом shadow DOM;
//   - детекторы плееров (HLS.js, dash.js, Video.js, JWPlayer, Plyr, Clappr, Shaka, Brightcove, Vidyard, Kaltura, Wistia, MediaElement);
//   - детекторы соцсетей (YouTube, Vimeo, VK, OK, RuTube, Coub, Dailymotion, Twitch, Reddit, Instagram, TikTok, Twitter, Facebook, Pinterest, 9GAG, Bilibili, Rumble);
//   - сниффинг performance API;
//   - обработка команды VDE_READ_BLOB для downloader'а.
import { findVideoElements, collectFromElement } from "./video-scanner";
import { detectPlayers } from "./player-detector";
import { detectSocialVideos } from "./social-detector";
import { sniffPerformanceResources } from "./perf-sniffer";
import { readBlobAsArrayBuffer } from "./blob-reader";
import type { RawVideoCandidate, ContentScanResponse, ScanOptions, ScanResult, ContentScanStats, SourceType } from "../shared/types";

const FLAG = "__VIDEO_DOWNLOADER_EXPLORER_READY__";

// Чанковый протокол сохранения: SW шлёт части файла, страница копит и в конце
// собирает Blob → <a download> (createObjectURL на странице есть, в SW — нет).
const saveJobs = new Map<string, { parts: (Uint8Array | null)[]; count: number; updatedAt: number }>();
try {
  setInterval(() => {
    const now = Date.now();
    for (const [k, job] of saveJobs) {
      if (now - job.updatedAt > 15 * 60_000) saveJobs.delete(k);
    }
  }, 60_000);
} catch { /* ignore */ }

if (!(globalThis as Record<string, unknown>)[FLAG]) {
  (globalThis as Record<string, unknown>)[FLAG] = true;

  console.info("[VDE] content script ready");

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === "VDE_SCAN_PAGE") {
      // Если opts не передан/частичный — включаем все детекторы по умолчанию,
      // чтобы никогда не остаться только с нативными <video>.
      const raw = (msg.opts ?? {}) as Partial<ScanOptions>;
      const opts: ScanOptions = {
        autoScroll: raw.autoScroll ?? true,
        monitorMs: raw.monitorMs ?? 5000,
        scanIframes: raw.scanIframes ?? true,
        detectPlayers: raw.detectPlayers ?? true,
        detectSocial: raw.detectSocial ?? true,
        sniffPerfResources: raw.sniffPerfResources ?? true,
        expandManifests: raw.expandManifests ?? true,
        downloadBlobs: raw.downloadBlobs ?? true,
      };
      scanAll(opts)
        .then((result) => sendResponse({ ok: true, result } as ContentScanResponse))
        .catch((e) => {
          console.error("[VDE] scan error:", e);
          sendResponse({ ok: false, error: String(e?.message || e) } as ContentScanResponse);
        });
      return true;
    }

    if (msg.type === "VDE_READ_BLOB") {
      readBlobAsArrayBuffer(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }

    if (msg.type === "VDE_FETCH_URL") {
      // Маршрут «как download helper»: fetch из контекста страницы — браузер сам
      // добавит origin-контекст (cookies, Referer согласно политике страницы).
      // Сработает для CDN, отдающих CORS (Access-Control-Allow-Origin).
      fetch(msg.url, { credentials: "include" as RequestCredentials })
        .then(async (resp) => {
          if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}`, status: resp.status };
          const buf = await resp.arrayBuffer();
          return { ok: true, bytes: buf, mime: resp.headers.get("content-type") || undefined };
        })
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }

    if (msg.type === "VDE_SAVE_CHUNK") {
      try {
        let job = saveJobs.get(msg.jobId);
        if (!job) {
          job = { parts: new Array(msg.count).fill(null), count: msg.count, updatedAt: Date.now() };
          saveJobs.set(msg.jobId, job);
        }
        job.parts[msg.index] = new Uint8Array(msg.bytes as ArrayBuffer);
        job.updatedAt = Date.now();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return true;
    }

    if (msg.type === "VDE_SAVE_COMMIT") {
      try {
        const job = saveJobs.get(msg.jobId);
        if (!job) {
          sendResponse({ ok: false, error: "нет принятых чанков" });
          return true;
        }
        saveJobs.delete(msg.jobId);
        // СТРОГАЯ проверка полноты: не сохраняем битый файл.
        if (job.parts.some((p) => !p)) {
          sendResponse({ ok: false, error: "неполные данные (потерян чанк)" });
          return true;
        }
        let total = 0;
        for (const p of job.parts) if (p) total += p.byteLength;
        const merged = new Uint8Array(total);
        let off = 0;
        for (const p of job.parts) {
          if (p) { merged.set(p, off); off += p.byteLength; }
        }
        const blob = new Blob([merged], { type: msg.mime || "application/octet-stream" });
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = msg.filename || "video.mp4";
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 300_000);
        console.info(`[VDE] сохранено через страницу: ${msg.filename} (${(total / 1024 / 1024).toFixed(1)} MB)`);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      }
      return true;
    }
  });
}

async function scanAll(opts: ScanOptions): Promise<ScanResult> {
  const t0 = performance.now();
  const allCandidates: RawVideoCandidate[] = [];
  const allErrors: string[] = [];
  const stats: ContentScanStats = {
    videoElements: 0, sourceElements: 0, shadowRootsOpened: 0,
    iframesScanned: 0, playersDetected: [], mutations: 0,
    perfResources: 0, errors: [],
  };

  // 1) Native <video> и <source>
  try {
    const found = findVideoElements(document, { baseUrl: location.href, deepShadow: true, autoScroll: !!opts.autoScroll });
    stats.videoElements = found.videoElements;
    stats.sourceElements = found.sourceElements;
    stats.shadowRootsOpened = found.shadowRootsOpened;
    for (const c of found.candidates) {
      allCandidates.push(c);
    }
    console.info(`[VDE] native <video>: ${found.candidates.length} кандидатов (video=${found.videoElements}, source=${found.sourceElements}, shadow=${found.shadowRootsOpened})`);
  } catch (e) {
    const msg = `video-scan: ${(e as Error).message}`;
    allErrors.push(msg);
    console.warn(`[VDE] native scan error: ${msg}`);
  }

  // 2) Player frameworks
  if (opts.detectPlayers) {
    try {
      const playerCands = detectPlayers(location.href);
      for (const c of playerCands) allCandidates.push(c);
      stats.playersDetected = playerCands.map((c) => c.sourceType as string);
      console.info(`[VDE] players: ${playerCands.length} кандидатов (${[...new Set(playerCands.map((c) => c.sourceType))].join(",") || "нет"})`);
    } catch (e) {
      const msg = `player-detect: ${(e as Error).message}`;
      allErrors.push(msg);
      console.warn(`[VDE] player detect error: ${msg}`);
    }
  } else {
    console.info("[VDE] players: отключено настройками");
  }

  // 3) Social networks
  if (opts.detectSocial) {
    try {
      const socialCands = detectSocialVideos(location.href, document);
      for (const c of socialCands) allCandidates.push(c);
      console.info(`[VDE] social: ${socialCands.length} кандидатов (${[...new Set(socialCands.map((c) => c.sourceType))].join(",") || "нет"})`);
    } catch (e) {
      const msg = `social-detect: ${(e as Error).message}`;
      allErrors.push(msg);
      console.warn(`[VDE] social detect error: ${msg}`);
    }
  } else {
    console.info("[VDE] social: отключено настройками");
  }

  // 4) Performance API sniff
  if (opts.sniffPerfResources) {
    try {
      const perfCands = sniffPerformanceResources(location.href);
      stats.perfResources = perfCands.scanned;
      for (const c of perfCands.candidates) allCandidates.push(c);
      console.info(`[VDE] perf: просмотрено ${perfCands.scanned} ресурсов, ${perfCands.candidates.length} кандидатов`);
    } catch (e) {
      const msg = `perf-sniff: ${(e as Error).message}`;
      allErrors.push(msg);
      console.warn(`[VDE] perf sniff error: ${msg}`);
    }
  } else {
    console.info("[VDE] perf: отключено настройками");
  }

  // 5) MutationObserver на короткое окно
  if (opts.monitorMs > 0) {
    try {
      const mut = await monitorMutations(opts.monitorMs);
      stats.mutations = mut;
      for (const c of collectFromElement(document.body || document.documentElement, location.href, [])) {
        allCandidates.push(c);
      }
    } catch (e) {
      allErrors.push(`mutation: ${(e as Error).message}`);
    }
  }

  // 6) Дедуп по URL (игнорируем sourceType — один и тот же файл из <video>/<source>/currentSrc — одно видео).
  const dedup = new Map<string, RawVideoCandidate>();
  for (const c of allCandidates) {
    const key = c.videoUrl.split("#")[0];
    if (!dedup.has(key)) dedup.set(key, c);
  }
  const deduped = [...dedup.values()];

  stats.errors = allErrors;

  console.info(
    `[VDE] scan OK: candidates=${deduped.length}, video=${stats.videoElements}, source=${stats.sourceElements}, ` +
    `players=[${stats.playersDetected.join(",")}], perf=${stats.perfResources}, mutations=${stats.mutations}, ` +
    `errors=${allErrors.length}, ${Math.round(performance.now() - t0)}ms`
  );

  return {
    candidates: deduped,
    pageMeta: { title: document.title || location.href, url: location.href },
    scanTimeMs: performance.now() - t0,
    stats,
  };
}

function monitorMutations(ms: number): Promise<number> {
  return new Promise((resolve) => {
    let count = 0;
    const obs = new MutationObserver((muts) => {
      count += muts.length;
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(count);
    }, Math.max(500, ms));
  });
}
