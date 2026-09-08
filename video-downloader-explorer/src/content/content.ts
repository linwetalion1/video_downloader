// Content script (IIFE). Инжектируется по требованию.
// Возможности:
//   - поиск всех <video> и <source> с deep-обходом shadow DOM;
//   - детекторы плееров (HLS.js, dash.js, Video.js, JWPlayer, Plyr, Clappr, Shaka, Brightcove, Vidyard, Kaltura, Wistia, MediaElement);
//   - детекторы соцсетей (YouTube, Vimeo, VK, OK, RuTube, Coub, Dailymotion, Twitch, Reddit, Instagram, TikTok, Twitter, Facebook, Pinterest, 9GAG, Bilibili, Rumble);
//   - сниффинг performance API;
//   - обработка команды VDE_READ_BLOB для downloader'а.
import { findVideoElements, autoScrollPage } from "./video-scanner";
import { detectPlayers } from "./player-detector";
import { detectSocialVideos } from "./social-detector";
import { sniffPerformanceResources } from "./perf-sniffer";
import { readBlobAsArrayBuffer } from "./blob-reader";
import { normalizePlaybackUrl } from "../shared/utils";
import type { RawVideoCandidate, ContentScanResponse, ScanOptions, ScanResult, ContentScanStats, SourceType } from "../shared/types";

const FLAG = "__VIDEO_DOWNLOADER_EXPLORER_READY__";

// ─── MAIN-world сниффер: приём находок через postMessage ──────────────────
// Страница (MAIN world) шлёт VDE_SNIFF_FINDING по мере перехвата и полный
// буфер по VDE_SNIFF_PING. Копим в module-level map — переживёт несколько сканов.
const sniffed = new Map<string, { url: string; mime?: string }>();
try {
  window.addEventListener("message", (ev: MessageEvent) => {
    try {
      if (ev.source !== window || !ev.data) return;
      const d = ev.data as { type?: string; finding?: { url?: string; mime?: string }; findings?: { url: string; mime?: string }[] };
      if (d.type === "VDE_SNIFF_FINDING" && d.finding?.url) {
        sniffed.set(d.finding.url.split("#")[0], { url: d.finding.url, mime: d.finding.mime });
      } else if (d.type === "VDE_SNIFF_FINDINGS" && Array.isArray(d.findings)) {
        for (const f of d.findings) {
          if (f?.url) sniffed.set(f.url.split("#")[0], { url: f.url, mime: f.mime });
        }
      }
    } catch { /* ignore */ }
  });
} catch { /* ignore */ }

function pingSniffer(): void {
  try { window.postMessage({ type: "VDE_SNIFF_PING" }, "*"); } catch { /* ignore */ }
}

function sniffedCandidates(): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  for (const { url, mime } of sniffed.values()) {
    // Сниффер ловит и сегментные запросы плеера — снимаем range-ограничения.
    const full = normalizePlaybackUrl(url);
    const key = full.split("#")[0];
    if (full !== url && sniffed.has(key)) continue; // полный URL уже есть
    const isM = /\.m3u8(\?|$)/i.test(full) || /format=m3u8/i.test(full) || /\/api\/manifest\/hls_playlist\//i.test(full);
    const isD = /\.mpd(\?|$)/i.test(full) || /\/api\/manifest\/dash\//i.test(full);
    out.push({
      videoUrl: full,
      sourceType: "sniff",
      container: isM ? "hls" : isD ? "dash" : (/\.webm(\?|$)/i.test(full) ? "webm" : "mp4"),
      mimeType: mime || undefined,
      isManifest: isM || isD,
      context: { via: "main-world-sniffer" },
    });
  }
  return out;
}

/** Если найдены ТОЛЬКО blob/MSE-кандидаты — видео не проигрывалось и плеер
 *  ничего не запросил. Пробуем тихо запустить воспроизведение: плеер начнёт
 *  тянуть манифест/сегменты, сниффер их перехватит. */
async function kickstartPlaybackAndGetStreams(maxWaitMs = 4000): Promise<RawVideoCandidate[]> {
  const before = new Set(sniffed.keys());
  const videos = Array.from(document.querySelectorAll("video")).filter((v) => /^blob:/i.test(v.currentSrc || v.src || ""));
  if (videos.length === 0) return [];
  console.info(`[VDE] kickstart: только blob-кандидаты — запускаем воспроизведение ${videos.length} <video>`);
  for (const v of videos) {
    try {
      v.muted = true;
      const p = (v as HTMLVideoElement).play();
      if (p && typeof p.then === "function") p.catch(() => undefined);
    } catch { /* ignore */ }
  }
  const deadline = Date.now() + maxWaitMs;
  const fresh: RawVideoCandidate[] = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    pingSniffer();
    fresh.length = 0;
    for (const c of sniffedCandidates()) {
      const k1 = c.videoUrl.split("#")[0];
      if (!before.has(k1) && !before.has(normalizePlaybackUrl(k1))) fresh.push(c);
    }
    if (fresh.some((c) => /^https?:/i.test(c.videoUrl))) break;
  }
  for (const v of videos) { try { v.pause(); } catch { /* ignore */ } }
  console.info(`[VDE] kickstart: +${fresh.filter((c) => /^https?:/i.test(c.videoUrl)).length} сетевых кандидатов`);
  return fresh;
}


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

  console.info(`[VDE] content script ready (${window === window.top ? "top" : "subframe"})`);

  // Если мы внутри sub-frame (iframe / embed плеер) — автоматически сканируем локальный DOM фрейма
  if (window !== window.top) {
    setTimeout(async () => {
      try {
        const res = await scanAll({
          autoScroll: false,
          monitorMs: 1500,
          scanIframes: false,
          detectPlayers: true,
          detectSocial: true,
          sniffPerfResources: true,
          expandManifests: true,
          downloadBlobs: true,
        });
        if (res.candidates.length > 0) {
          chrome.runtime.sendMessage({
            type: "VDE_FRAME_CANDIDATES",
            frameUrl: location.href,
            candidates: res.candidates,
          });
        }
      } catch { /* ignore */ }
    }, 400);
  }

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
    perfResources: 0, sniffed: 0, errors: [],
  };

  pingSniffer();

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

  // 1.5) Same-origin iframes (кросс-доменные недоступны из content script)
  if (opts.scanIframes) {
    try {
      for (const fr of Array.from(document.querySelectorAll("iframe"))) {
        let innerDoc: Document | null = null;
        try { innerDoc = (fr as HTMLIFrameElement).contentDocument; } catch { /* cross-origin */ }
        if (!innerDoc) continue;
        stats.iframesScanned++;
        try {
          const sub = findVideoElements(innerDoc, { baseUrl: fr.src || location.href, deepShadow: true, autoScroll: false });
          for (const c of sub.candidates) {
            c.iframeSrc = (fr as HTMLIFrameElement).src || undefined;
            allCandidates.push(c);
          }
          const social = detectSocialVideos(fr.src || location.href, innerDoc);
          for (const c of social) { c.iframeSrc = (fr as HTMLIFrameElement).src || undefined; allCandidates.push(c); }
        } catch { /* ignore */ }
      }
      console.info(`[VDE] iframes same-origin: ${stats.iframesScanned} просмотрено`);
    } catch (e) {
      allErrors.push(`iframes: ${(e as Error).message}`);
    }
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

  // 5) Окно наблюдения: авто-скролл + MutationObserver + ПОЛНЫЙ rescan DOM.
  //    Раньше rescan делался через collectFromElement(document.body), который
  //    всегда возвращал [] для BODY — поздно добавленные видео терялись.
  if (opts.monitorMs > 0) {
    try {
      const scrollSteps = opts.autoScroll ? await autoScrollPage(12, Math.min(700, Math.max(250, opts.monitorMs / 8))) : 0;
      const mut = await monitorMutations(Math.max(300, opts.monitorMs - (scrollSteps * Math.min(700, Math.max(250, opts.monitorMs / 8)))));
      stats.mutations = mut;
      const rescanned = findVideoElements(document, { baseUrl: location.href, deepShadow: true, autoScroll: false });
      for (const c of rescanned.candidates) allCandidates.push(c);
      if (scrollSteps > 0) console.info(`[VDE] auto-scroll: ${scrollSteps} шагов, после рескана +${rescanned.candidates.length} кандидатов`);
    } catch (e) {
      allErrors.push(`mutation: ${(e as Error).message}`);
    }
  }

  // 6) Находки MAIN-world сниффера (fetch/XHR страницы): манифесты, mp4,
  //    JSON API (Instagram GraphQL и т.п.). Финальный ping — забрать буфер.
  pingSniffer();
  await new Promise((r) => setTimeout(r, 120));
  try {
    const sn = sniffedCandidates();
    stats.sniffed = sn.length;
    for (const c of sn) allCandidates.push(c);
    console.info(`[VDE] sniff: ${sn.length} кандидатов из перехвата сети`);
  } catch (e) {
    allErrors.push(`sniff: ${(e as Error).message}`);
  }

  // 6.5) Если сетевых кандидатов нет совсем (только blob/MSE) — плеер ничего
  //      не запрашивал. Тихо запускаем воспроизведение и добираем потоки.
  const hasHttpMedia = allCandidates.some((c) => /^https?:/i.test(c.videoUrl));
  if (!hasHttpMedia) {
    try {
      const extra = await kickstartPlaybackAndGetStreams(4000);
      for (const c of extra) allCandidates.push(c);
      stats.sniffed += extra.length;
    } catch (e) {
      allErrors.push(`kickstart: ${(e as Error).message}`);
    }
  }

  // 7) Дедуп по URL (игнорируем sourceType — один и тот же файл из <video>/<source>/currentSrc — одно видео).
  //    Приоритет «богатых» источников: соцсети/сниффер не затираются голым perf-URL.
  const priorityOf = (t: SourceType): number => {
    switch (t) {
      case "youtube": case "instagram": case "tiktok": case "twitter": case "facebook":
      case "vk": case "ok": case "rutube": case "vimeo": case "bilibili": case "reddit":
        return 3;
      case "hls-js": case "dash-js": case "jwplayer": case "video-js": case "shaka":
      case "plyr": case "clappr": case "wistia": case "brightcove": case "kaltura":
      case "vidyard": case "mediael": case "flowplayer": case "iframe-player":
        return 2;
      case "sniff": return 2;
      case "video": case "source": case "currentSrc": return 1;
      default: return 0;
    }
  };
  const dedup = new Map<string, RawVideoCandidate>();
  for (const c of allCandidates) {
    const key = c.videoUrl.split("#")[0];
    const prev = dedup.get(key);
    if (!prev || priorityOf(c.sourceType) > priorityOf(prev.sourceType)) dedup.set(key, c);
  }
  const deduped = [...dedup.values()];

  stats.errors = allErrors;

  console.info(
    `[VDE] scan OK: candidates=${deduped.length}, video=${stats.videoElements}, source=${stats.sourceElements}, ` +
    `players=[${stats.playersDetected.join(",")}], perf=${stats.perfResources}, sniff=${stats.sniffed}, mutations=${stats.mutations}, ` +
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
