// Скачивание видео. Маршруты:
//   1) hotlink-сайты (HEAD/GET 403 при метаданных) → сразу fetch+blob;
//   2) обычные → chrome.downloads API (быстро, родная папка);
//   3) 403 на downloads → fetch из SW (DNR: Referer+Origin+Sec-Fetch+cookies) → сохранение;
//   4) 403 → fetch из контекста страницы (CORS-CDN).
//
// ВАЖНО: в service worker НЕТ URL.createObjectURL — поэтому сохранение байтов
// идёт через data: URL (малые файлы) или чанками в страницу (<a download>).

import { applyFilenameTemplate, hostnameOf, looksLikeErrorPayload, mimeToExt, normalizePlaybackUrl, parseContentDisposition, sanitizeFilename, uid } from "../shared/utils";
import { downloadLog, blobLog, manifestLog } from "../shared/logger";
import { fetchAndParseHls, downloadHlsSegments } from "./hls";
import { fetchAndParseDash } from "./dash";
import { MAX_BLOB_BYTES } from "../shared/constants";
import type { DownloadOptions, VideoCandidate } from "../shared/types";

export interface DownloadParams {
  candidate: VideoCandidate;
  options: DownloadOptions & { downloadBlobs?: boolean };
  /** Force origin permission check. */
  ensurePermission?: (url: string) => Promise<boolean>;
  /** Send progress updates (0..1). */
  onProgress?: (received: number, total: number | undefined) => void;
  /** Set phase/status text (will be set on candidate and broadcast). */
  setMessage?: (msg: string) => void;
  /** set phase. */
  setPhase?: (phase: VideoCandidate["phase"]) => void;
  /** abort signal. */
  signal?: AbortSignal;
}

export interface DownloadResult {
  ok: boolean;
  filename?: string;
  bytes?: number;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

function pickExt(c: VideoCandidate): string {
  if (c.extension && c.extension !== "unknown") return c.extension;
  if (c.mimeType) {
    const e = mimeToExt(c.mimeType);
    if (e) return e;
  }
  if (c.container && c.container !== "unknown") return c.container;
  return "mp4";
}

function buildFilename(candidate: VideoCandidate, options: DownloadOptions, contentDisposition?: string): string {
  if (contentDisposition) {
    const cd = parseContentDisposition(contentDisposition);
    if (cd) return sanitizeFilename(cd);
  }
  const tpl = options.filenameTemplate || "{title}.{ext}";
  const quality = candidate.width && candidate.height ? `${candidate.width}x${candidate.height}` : (candidate.bitrateKbps ? `${Math.round(candidate.bitrateKbps)}k` : "");
  return applyFilenameTemplate(tpl, {
    title: candidate.title || "video",
    domain: hostnameOf(candidate.sourcePageUrl),
    width: candidate.width,
    height: candidate.height,
    duration: candidate.durationSec,
    quality,
    ext: pickExt(candidate),
    format: candidate.container === "unknown" ? undefined : candidate.container,
  });
}

function buildPath(candidate: VideoCandidate, options: DownloadOptions): string {
  const root = sanitizeFilename(options.saveTo) || "videos";
  const host = sanitizeFilename(hostnameOf(candidate.sourcePageUrl)) || "site";
  switch (options.folderMode) {
    case "flat": return root;
    case "domain": return `${root}/${host}`;
    case "page": return `${root}/${host}/${sanitizeFilename((candidate.sourcePageTitle || "page").slice(0, 60))}`;
  }
}

// ─── DNR (Referer/Origin/Sec-Fetch/cookies для hotlink-защиты) ────────────

// Централизованный аллокатор id динамических правил: хеш хоста mod 100000
// давал коллизии между разными хостами.
const usedRuleIds = new Set<number>();
function acquireRuleId(): number {
  let id = 200_000;
  while (usedRuleIds.has(id) && id < 300_000) id++;
  usedRuleIds.add(id);
  return id;
}
function releaseRuleId(id: number): void {
  usedRuleIds.delete(id);
}

async function addRefererRule(url: string, referer: string, useCookies: boolean): Promise<{ ruleId: number | null; cookieNames: string[] }> {
  try {
    const host = new URL(url).hostname;
    const ruleId = acquireRuleId();
    // Точный набор заголовков медиа-запроса страницы (подслушан webRequest'ом):
    // Referer: корень сайта; Sec-Fetch-Site: same-site; Sec-Fetch-Dest: video; без Origin.
    let rootReferer = referer;
    try {
      const u = new URL(referer);
      rootReferer = u.origin + "/";
    } catch { /* ignore */ }
    const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [
      { header: "Referer", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: rootReferer },
      { header: "Accept", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "*/*" },
      { header: "Sec-Fetch-Dest", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "video" },
      { header: "Sec-Fetch-Mode", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "no-cors" },
      { header: "Sec-Fetch-Site", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: "same-site" },
    ];

    // Cookies ТОЛЬКО по явной настройке useCookies (приватность по умолчанию).
    let cookieHeader = "";
    const cookieNames: string[] = [];
    if (useCookies) {
      try {
        const hostCookies = await chrome.cookies.getAll({ url: `https://${host}/` });
        const parent = host.split(".").slice(-2).join(".");
        const parentCookies = parent !== host ? await chrome.cookies.getAll({ domain: parent }) : [];
        const seen = new Set<string>();
        const merged = [...parentCookies, ...hostCookies].filter((c) => {
          if (seen.has(c.name)) return false;
          seen.add(c.name);
          return true;
        });
        cookieNames.push(...merged.map((c) => c.name));
        cookieHeader = merged.map((c) => `${c.name}=${c.value}`).join("; ");
      } catch { /* cookies permission недоступен — игнор */ }
    }

    const apply = async (headers: chrome.declarativeNetRequest.ModifyHeaderInfo[]) => {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleId],
        addRules: [{
          id: ruleId,
          priority: 1,
          action: {
            type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: headers,
          },
          condition: { urlFilter: `||${host}` },
        }],
      });
    };

    try {
      if (cookieHeader) {
        await apply([...requestHeaders, {
          header: "Cookie",
          operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
          value: cookieHeader,
        }]);
      } else {
        await apply(requestHeaders);
      }
    } catch (e1) {
      downloadLog.warn(`DNR: правило с Cookie отклонено (${(e1 as Error).message}) — применяем без Cookie`);
      await apply(requestHeaders);
      cookieHeader = "";
    }

    // Пауза: браузер применяет динамическое правило до первого запроса.
    await new Promise((r) => setTimeout(r, 120));

    downloadLog.info(
      `DNR: правило ${ruleId} для ${host}: Referer=${rootReferer}, Sec-Fetch-Site=same-site` +
      (cookieNames.length ? `, cookies: ${cookieNames.join(",")}` : ", cookies: нет")
    );
    return { ruleId, cookieNames };
  } catch (e) {
    downloadLog.warn(`DNR: не удалось добавить Referer-правило: ${(e as Error).message}`);
    return { ruleId: null, cookieNames: [] };
  }
}

async function removeRefererRule(ruleId: number | null): Promise<void> {
  if (ruleId == null) return;
  releaseRuleId(ruleId);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
    downloadLog.info(`DNR: Referer-правило ${ruleId} удалено`);
  } catch { /* ignore */ }
}

// ─── Прямое скачивание через chrome.downloads ─────────────────────────────

// ─── Проверка «а видео ли вообще скачалось» ───────────────────────────────
// googlevideo/анти-боты часто отвечают 200 с крошечным HTML/JSON — раньше
// это считалось успешным скачиванием («✓ … (0 MB)»). Теперь такие ответы
// ловим и честно падаем с понятной ошибкой.

const MIN_PLAUSIBLE_VIDEO_BYTES = 16 * 1024;

function classifySuspicious(mime?: string, bytes?: number | null): string | null {
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  if (/^(text\/html|text\/plain|application\/json|application\/xml|application\/xhtml)/i.test(m)) {
    return `сервер вернул «${m}» вместо видео (требуется подпись/PO-токен или доступ)`;
  }
  if (bytes != null && bytes > 0 && bytes < MIN_PLAUSIBLE_VIDEO_BYTES) {
    return `файл подозрительно мал (${bytes} Б) — вероятно, заглушка, а не медиа`;
  }
  return null;
}

async function directDownload(
  url: string,
  path: string,
  conflictAction: "uniquify" | "overwrite" | "prompt",
  timeoutMs: number,
  signal?: AbortSignal,
  referer?: string,
  useCookies = false
): Promise<{ id?: number; error?: string; retryable?: boolean; bytes?: number; mime?: string }> {
  if (signal?.aborted) return { error: "Aborted", retryable: false };
  const { ruleId } = referer && /^https?:/i.test(url)
    ? await addRefererRule(url, referer, useCookies)
    : { ruleId: null as number | null };
  try {
    return await new Promise((resolve) => {
      let done = false;
      const finish = (result: { id?: number; error?: string; retryable?: boolean; bytes?: number; mime?: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { chrome.downloads.onChanged.removeListener(listener); } catch { /* */ }
        resolve(result);
      };
      // После "complete" уточняем итоговый размер/mime из истории загрузок.
      const finishWithInfo = (id: number) => {
        try {
          chrome.downloads.search({ id }, (items) => {
            const it = items?.[0];
            finish({ id, bytes: it?.fileSize, mime: it?.mime });
          });
        } catch {
          finish({ id });
        }
      };
      // Слушатель ДО chrome.downloads.download — иначе interrupted может
      // прийти раньше, чем listener подписался.
      let dlId = -1;
      const timer = setTimeout(() => finish({ error: `Timeout (${timeoutMs}ms)`, retryable: true }), timeoutMs);
      const listener = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== dlId || dlId === -1) return;
        if (delta.state?.current === "complete") finishWithInfo(dlId);
        else if (delta.state?.current === "interrupted") {
          const err = delta.error?.current || "interrupted";
          // Чистим болванку (.htm при 403) — файл и запись из истории.
          try { void chrome.downloads.removeFile(dlId); } catch { /* */ }
          try { void chrome.downloads.erase({ id: dlId }); } catch { /* */ }
          // 403/401 — не временная ошибка, retry бесполезен.
          const retryable = err !== "SERVER_FORBIDDEN" && err !== "SERVER_UNAUTHORIZED";
          finish({ id: dlId, error: err, retryable });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      chrome.downloads.download({ url, filename: path, conflictAction, saveAs: false }, (id) => {
        if (chrome.runtime.lastError) {
          finish({ error: chrome.runtime.lastError.message || "Download API error", retryable: false });
          return;
        }
        dlId = id;
      });
      signal?.addEventListener("abort", () => {
        if (dlId !== -1) { try { void chrome.downloads.cancel(dlId); } catch { /* */ } }
        finish({ error: "Aborted", retryable: false });
      }, { once: true });
    });
  } finally {
    await removeRefererRule(ruleId);
  }
}

// ─── Сохранение байтов (SW-совместимо) ────────────────────────────────────
// В service worker НЕТ URL.createObjectURL. Поэтому:
//   - малые файлы (≤ 20 МБ) → data: URL → chrome.downloads;
//   - большие → чанками в активную вкладку (<a download> на странице).

const SAVE_CHUNK_BYTES = 4 * 1024 * 1024; // 4 МБ на сообщение
const DATA_URL_MAX = 20 * 1024 * 1024;   // data: URL только для небольших

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return `data:${mime};base64,` + btoa(bin);
}

/** Выбор вкладки для page-маршрутов: сначала вкладка страницы-источника,
 *  затем любая http(s) — иначе чанки уйдут в чужой сайт при переключении. */
async function pickTabId(hintUrl?: string): Promise<number | null> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  if (hintUrl) {
    try {
      const origin = new URL(hintUrl).origin;
      const match = tabs.find((t) => { try { return new URL(t.url || "").origin === origin; } catch { return false; } });
      if (match?.id) return match.id;
    } catch { /* ignore */ }
  }
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active[0]?.id && /^https?:/i.test(active[0].url || "")) return active[0].id;
  return tabs.find((t) => t.id)?.id ?? null;
}

async function ensureContentJs(tabId: number): Promise<void> {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); } catch { /* уже есть */ }
}

async function saveViaPageChunks(
  bytes: Uint8Array,
  path: string,
  mime: string,
  hintUrl?: string
): Promise<{ ok: boolean; error?: string }> {
  const tabId = await pickTabId(hintUrl);
  if (!tabId) return { ok: false, error: "нет подходящей вкладки" };
  await ensureContentJs(tabId);
  const jobId = uid("s");
  const count = Math.max(1, Math.ceil(bytes.length / SAVE_CHUNK_BYTES));
  const baseName = path.split("/").pop() || "video.mp4";
  downloadLog.info(`Сохраняем через страницу: ${baseName} (${count} чанков)`);
  for (let i = 0; i < count; i++) {
    const part = bytes.subarray(i * SAVE_CHUNK_BYTES, Math.min(bytes.length, (i + 1) * SAVE_CHUNK_BYTES));
    const copy = part.slice();
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: "VDE_SAVE_CHUNK", jobId, index: i, count, bytes: copy.buffer,
    });
    if (!resp?.ok) return { ok: false, error: resp?.error || "страница не приняла чанк" };
  }
  const done = await chrome.tabs.sendMessage(tabId, {
    type: "VDE_SAVE_COMMIT", jobId, filename: baseName, mime,
  });
  if (!done?.ok) return { ok: false, error: done?.error || "сохранение не завершено" };
  return { ok: true };
}

/** Offscreen document: там есть URL.createObjectURL и chrome.downloads. */
async function withOffscreen<T>(fn: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"] as chrome.offscreen.Reason[],
      justification: "Сохранить скачанные медиа на диск",
    });
  } catch { /* возможно, уже создан */ }
  try {
    return await fn();
  } finally {
    try { await chrome.offscreen.closeDocument(); } catch { /* ignore */ }
  }
}

async function sendChunkToOffscreen(
  jobId: string, index: number, count: number, part: Uint8Array
): Promise<{ ok: boolean; error?: string }> {
  const copy = part.slice();
  const resp = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_SAVE_CHUNK", jobId, index, count, bytes: copy.buffer,
  });
  return resp?.ok ? { ok: true } : { ok: false, error: resp?.error || "offscreen не принял чанк" };
}

async function commitOffscreen(jobId: string, path: string, mime: string): Promise<{ ok: boolean; error?: string }> {
  const done = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_SAVE_COMMIT", jobId, filename: path, mime,
  });
  return done?.ok ? { ok: true } : { ok: false, error: done?.error || "сохранение не завершено" };
}

async function saveViaOffscreen(
  bytes: Uint8Array,
  path: string,
  mime: string
): Promise<{ ok: boolean; error?: string }> {
  return withOffscreen(async () => {
    const jobId = uid("o");
    const count = Math.max(1, Math.ceil(bytes.length / SAVE_CHUNK_BYTES));
    downloadLog.info(`Сохраняем через offscreen: ${path} (${count} чанков)`);
    for (let i = 0; i < count; i++) {
      const part = bytes.subarray(i * SAVE_CHUNK_BYTES, Math.min(bytes.length, (i + 1) * SAVE_CHUNK_BYTES));
      const r = await sendChunkToOffscreen(jobId, i, count, part);
      if (!r.ok) return { ok: false, error: r.error };
    }
    return commitOffscreen(jobId, path, mime);
  }) as Promise<{ ok: boolean; error?: string }>;
}

async function saveBytesToFile(
  bytes: Uint8Array,
  path: string,
  mime: string
): Promise<{ ok: boolean; error?: string }> {
  // 1) Малые файлы — data: URL прямо из SW.
  if (bytes.length <= DATA_URL_MAX) {
    try {
      const r = await directDownload(bytesToDataUrl(bytes, mime), path, "uniquify", 300_000);
      if (!r.error) return { ok: true };
      downloadLog.warn(`data:URL сохранение не вышло (${r.error}) — пробуем offscreen`);
    } catch { /* далее offscreen */ }
  }
  // 2) Большие файлы — offscreen document (папка сохраняется как задано).
  const viaOffscreen = await saveViaOffscreen(bytes, path, mime);
  if (viaOffscreen.ok) return viaOffscreen;
  downloadLog.warn(`offscreen не сработал (${viaOffscreen.error}) — пробуем страницу`);
  // 3) Последний резерв — страница.
  return saveViaPageChunks(bytes, path, mime);
}

// ─── Fallback 2: fetch из контекста страницы ──────────────────────────────

async function contentFetchDownload(
  url: string,
  path: string,
  _timeoutMs: number,
  _conflictAction: "uniquify" | "overwrite" | "prompt",
  hintUrl?: string
): Promise<{ id?: number; error?: string; retryable?: boolean; bytes?: number }> {
  try {
    const tabId = await pickTabId(hintUrl);
    if (!tabId) return { error: "нет подходящей вкладки", retryable: false };
    await ensureContentJs(tabId);
    const resp = await chrome.tabs.sendMessage(tabId, { type: "VDE_FETCH_URL", url });
    if (!resp?.ok || !resp.bytes) {
      return { error: resp?.error || "не удалось", retryable: false };
    }
    const buf = new Uint8Array(resp.bytes as ArrayBuffer);
    downloadLog.info(`content-fetch: получено ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB${resp.mime ? " (" + resp.mime + ")" : ""}`);
    const saved = await saveBytesToFile(buf, path, resp.mime || "application/octet-stream");
    if (!saved.ok) return { error: saved.error || "не сохранилось", retryable: false };
    return { bytes: buf.byteLength };
  } catch (e) {
    return { error: `content-fetch: ${(e as Error).message}`, retryable: false };
  }
}

// ─── Fallback 1: fetch из SW со стримингом и прогрессом ───────────────────

/** Стримим ответ напрямую в offscreen (без удвоения памяти в SW).
 *  Чанки идут последовательно с индексом от 0 — offscreen собирает по порядку. */
async function streamToOffscreen(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  path: string,
  mime: string,
  onProgress?: (received: number, total: number | undefined) => void,
  totalHint?: number
): Promise<{ ok: boolean; error?: string; bytes: number }> {
  return withOffscreen(async () => {
    const jobId = uid("o");
    let received = 0;
    let index = 0;
    const count = totalHint ? Math.max(1, Math.ceil(totalHint / SAVE_CHUNK_BYTES)) : 0;
    let carry: Uint8Array | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      let block: Uint8Array;
      if (carry && carry.length > 0) {
        block = new Uint8Array(carry.length + value.length);
        block.set(carry); block.set(value, carry.length);
        carry = null;
      } else {
        block = value;
      }
      while (block.length >= SAVE_CHUNK_BYTES) {
        const r = await sendChunkToOffscreen(jobId, index++, count, block.subarray(0, SAVE_CHUNK_BYTES));
        if (!r.ok) return { ok: false, error: r.error, bytes: received };
        received += SAVE_CHUNK_BYTES;
        onProgress?.(received, totalHint);
        block = block.subarray(SAVE_CHUNK_BYTES);
      }
      carry = block.length ? block.slice() : null;
    }
    if (carry && carry.length > 0) {
      const r = await sendChunkToOffscreen(jobId, index++, count, carry);
      if (!r.ok) return { ok: false, error: r.error, bytes: received };
      received += carry.byteLength;
    }
    onProgress?.(received, totalHint);
    const committed = await commitOffscreen(jobId, path, mime);
    return { ...committed, bytes: received };
  }) as Promise<{ ok: boolean; error?: string; bytes: number }>;
}

async function fetchBlobDownload(
  url: string,
  path: string,
  _conflictAction: "uniquify" | "overwrite" | "prompt",
  onProgress?: (received: number, total: number | undefined) => void,
  signal?: AbortSignal,
  hintUrl?: string
): Promise<{ id?: number; error?: string; retryable?: boolean; bytes?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60_000); // 10 минут
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      credentials: "include" as RequestCredentials,
      redirect: "follow",
    });
    if (!resp.ok) {
      const ct = resp.headers.get("content-type") || "";
      downloadLog.warn(`fetch+blob: сервер ответил HTTP ${resp.status} (${ct.slice(0, 60)}).`);
      return { error: `HTTP ${resp.status}`, retryable: false };
    }
    downloadLog.info(`fetch+blob: HTTP 200, стримим байты с прогрессом…`);
    const mime = resp.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
    const total = parseInt(resp.headers.get("content-length") || "0", 10) || undefined;

    // Сразу отсекаем HTML/JSON-заглушки по content-type…
    const sus = classifySuspicious(mime, total);
    if (sus && total !== undefined) {
      downloadLog.warn(`fetch+blob: ${sus}`);
      return { error: sus, retryable: false };
    }

    let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>> | null = resp.body?.getReader() ?? null;

    // …и по содержимому первого чанка (content-type бывает обманчив).
    let first: Uint8Array | undefined;
    if (reader) {
      const head = await reader.read();
      if (head.value) first = head.value as Uint8Array;
    }
    if (first && looksLikeErrorPayload(first)) {
      try { await resp.body?.cancel(); } catch { /* */ }
      const msg = "сервер отдал HTML/JSON вместо видео (требуется подпись/PO-токен или авторизация)";
      downloadLog.warn(`fetch+blob: ${msg}`);
      return { error: msg, retryable: false };
    }
    if (!first && reader) {
      reader = null; // поток пуст
    }
    // Оборачиваем: сначала уже прочитанный первый чанк, затем остаток потока.
    if (first && reader) {
      const src: ReadableStreamDefaultReader<Uint8Array> = reader;
      const wrapped = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
        },
        async pull(controller) {
          const { done, value } = await src.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value as Uint8Array);
        },
        cancel() { try { src.cancel(); } catch { /* */ } },
      });
      reader = wrapped.getReader();
    }

    // Основной путь — стриминг прямо в offscreen: память SW не растёт.
    if (reader && (!total || total > DATA_URL_MAX)) {
      const streamed = await streamToOffscreen(reader as ReadableStreamDefaultReader<Uint8Array>, path, mime, onProgress, total);
      if (streamed.ok) {
        downloadLog.info(`✓ ${path} (fetch → offscreen, ${(streamed.bytes / 1024 / 1024).toFixed(1)} MB)`);
        return { bytes: streamed.bytes };
      }
      downloadLog.warn(`стриминг в offscreen не удался (${streamed.error}) — перезапуск с буферизацией`);
      // Reader частично прочитан: продолжать нельзя (битый файл). Перезапрашиваем.
      try { await resp.body?.cancel(); } catch { /* */ }
      const retry = await fetch(url, { method: "GET", signal: controller.signal, credentials: "include" as RequestCredentials, redirect: "follow" });
      if (!retry.ok) return { error: `HTTP ${retry.status}`, retryable: false };
      reader = retry.body?.getReader() ?? null;
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastLogAt = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.byteLength;
          onProgress?.(received, total);
          const now = Date.now();
          if (now - lastLogAt > 5000) {
            lastLogAt = now;
            downloadLog.info(`fetch+blob: ${(received / 1024 / 1024).toFixed(1)} MB${total ? " / " + (total / 1024 / 1024).toFixed(1) + " MB" : ""}`);
          }
        }
      }
    } else {
      const buf = await resp.arrayBuffer();
      chunks.push(new Uint8Array(buf));
      received = buf.byteLength;
    }
    onProgress?.(received, total);
    downloadLog.info(`fetch+blob: получено ${(received / 1024 / 1024).toFixed(1)} MB (${mime})`);

    // Склеиваем и сохраняем (data: URL или страница — НЕ URL.createObjectURL).
    const merged = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    const saved = await saveBytesToFile(merged, path, mime);
    if (!saved.ok) {
      return { error: saved.error || "не удалось сохранить файл", retryable: false };
    }
    downloadLog.info(`✓ ${path} (через fetch+blob)`);
    return { bytes: received };
  } catch (e) {
    const name = (e as Error).name || "";
    downloadLog.warn(`fetch+blob: ошибка сети/таймаут (${name}): ${(e as Error).message}`);
    return { error: `fetch fallback: ${(e as Error).message}`, retryable: false };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Blob: / data: URL ────────────────────────────────────────────────────

async function downloadBlobUrl(candidate: VideoCandidate, params: DownloadParams): Promise<DownloadResult> {
  blobLog.info(`Blob download: ${candidate.videoUrl.slice(0, 80)}…`);
  params.setPhase?.("fetching-meta");
  params.setMessage?.("Чтение blob…");

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!tabId) {
    blobLog.error("Blob: нет активной вкладки");
    return { ok: false, error: "Blob: нет активной вкладки", errorCode: "NO_TAB", retryable: false };
  }

  let resp: { ok: boolean; bytes?: ArrayBuffer; mime?: string; error?: string; mseLikely?: boolean } | null = null;
  try {
    params.setPhase?.("downloading");
    params.setMessage?.("Скачиваем blob из страницы…");
    resp = await chrome.tabs.sendMessage(tabId, { type: "VDE_READ_BLOB", url: candidate.videoUrl });
  } catch (e) {
    blobLog.error(`Blob: не удалось получить из content script: ${(e as Error).message}`);
    return { ok: false, error: `Blob недоступен: ${(e as Error).message}`, errorCode: "NO_TAB", retryable: false };
  }

  if (!resp?.ok || !resp.bytes) {
    const err = resp?.error || "пусто";
    const mse = resp?.mseLikely;
    blobLog.error(`Blob: ошибка чтения: ${err}${mse ? " [MSE]" : ""}`);
    const hint = mse
      ? " Это сегментированный поток (MediaSource): файла в блобе нет. Ищите в результатах исходную HLS/DASH/плеерную ссылку, либо включите детекторы соцсетей/плееров в настройках."
      : "";
    return { ok: false, error: `Blob: ${err}${hint}`, errorCode: "BLOB_ERROR", retryable: false };
  }

  const bytes = new Uint8Array(resp.bytes);
  params.onProgress?.(bytes.byteLength, bytes.byteLength);
  blobLog.info(`Blob: прочитано ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB, mime=${resp.mime}`);

  if (bytes.byteLength > MAX_BLOB_BYTES) {
    blobLog.error(`Blob: размер ${bytes.byteLength} > лимита ${MAX_BLOB_BYTES}`);
    return { ok: false, error: "Blob превышает 2 ГБ", errorCode: "TOO_BIG", retryable: false };
  }

  params.setPhase?.("merging");
  params.setMessage?.("Сохраняем blob в файл…");
  const filename = buildFilename(candidate, params.options);
  const path = `${buildPath(candidate, params.options)}/${filename}`;
  blobLog.info(`Blob: сохранение в ${path}`);
  const saved = await saveBytesToFile(bytes, path, resp.mime || candidate.mimeType || "application/octet-stream");
  if (!saved.ok) {
    blobLog.error(`Blob: не удалось сохранить: ${saved.error}`);
    return { ok: false, error: saved.error || "сохранение не удалось", errorCode: "DOWNLOAD", retryable: false };
  }
  return { ok: true, filename: path, bytes: bytes.byteLength };
}

// ─── HLS / DASH ────────────────────────────────────────────────────────────

async function downloadHls(candidate: VideoCandidate, params: DownloadParams): Promise<DownloadResult> {
  manifestLog.info(`HLS → file: ${candidate.videoUrl}`);
  params.setPhase?.("fetching-meta");
  params.setMessage?.("Парсим HLS плейлист…");
  const parsed = await fetchAndParseHls(candidate.videoUrl);
  if (!parsed.ok) {
    return { ok: false, error: `HLS: ${parsed.error}`, errorCode: "HLS_PARSE", retryable: false };
  }
  if (parsed.isDRM) {
    return { ok: false, error: "HLS защищён SAMPLE-AES (DRM), скачивание недоступно", errorCode: "DRM", retryable: false };
  }
  if (parsed.isEncrypted && !parsed.keyUri) {
    return { ok: false, error: "HLS AES-128 без доступного ключа", errorCode: "ENCRYPTED", retryable: false };
  }

  if (parsed.isMaster) {
    if (parsed.variants.length === 0) {
      return { ok: false, error: "HLS master: нет вариантов", errorCode: "HLS_NO_VARIANTS", retryable: false };
    }
    const best = [...parsed.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
    manifestLog.info(`HLS master: выбран ${best.resolutionLabel} (${Math.round(best.bandwidth / 1000)}kbps)`);
    const sub = await fetchAndParseHls(best.url);
    if (!sub.ok || !sub.segments || sub.segments.length === 0) {
      return { ok: false, error: `HLS media: ${sub.error || "нет сегментов"}`, errorCode: "HLS_MEDIA", retryable: false };
    }
    return downloadMergedHls(candidate, sub.segments, params, best.resolutionLabel);
  }
  if (!parsed.segments || parsed.segments.length === 0) {
    return { ok: false, error: "HLS media: нет сегментов", errorCode: "HLS_NO_SEG", retryable: false };
  }
  return downloadMergedHls(candidate, parsed.segments, params, "auto");
}

async function downloadMergedHls(
  candidate: VideoCandidate,
  segments: NonNullable<Awaited<ReturnType<typeof fetchAndParseHls>>["segments"]>,
  params: DownloadParams,
  quality: string
): Promise<DownloadResult> {
  params.setPhase?.("downloading");
  params.setMessage?.(`Скачиваем ${segments.length} сегментов HLS…`);
  try {
    const blob = await downloadHlsSegments(segments, candidate.videoUrl, undefined, (received, total) => {
      params.onProgress?.(received, total);
      params.setMessage?.(`HLS: ${(received / 1024 / 1024).toFixed(1)} MB`);
    }, params.signal);
    params.setPhase?.("merging");
    params.setMessage?.("Склеиваем в один файл…");
    const buf = new Uint8Array(await blob.arrayBuffer());
    const isFmp4 = blob.type.includes("mp4");
    const ext = isFmp4 ? "mp4" : "ts";
    const filename = buildFilename(candidate, params.options).replace(/\.[^.]+$/, "") + `__${quality}.${ext}`;
    const path = `${buildPath(candidate, params.options)}/${filename}`;
    const saved = await saveBytesToFile(buf, path, blob.type);
    if (!saved.ok) {
      return { ok: false, error: saved.error || "сохранение не удалось", errorCode: "DOWNLOAD", retryable: false };
    }
    return { ok: true, filename: path, bytes: buf.byteLength };
  } catch (e) {
    if (params.signal?.aborted || (e as Error).message === "Aborted") {
      return { ok: false, error: "Отменено", errorCode: "ABORTED", retryable: false };
    }
    return { ok: false, error: `HLS: ${(e as Error).message}`, errorCode: "HLS_FETCH", retryable: true };
  }
}

async function downloadDash(candidate: VideoCandidate, params: DownloadParams): Promise<DownloadResult> {
  manifestLog.info(`DASH → file: ${candidate.videoUrl}`);
  params.setPhase?.("fetching-meta");
  params.setMessage?.("Парсим DASH манифест…");
  const parsed = await fetchAndParseDash(candidate.videoUrl);
  if (!parsed.ok) {
    return { ok: false, error: `DASH: ${parsed.error}`, errorCode: "DASH_PARSE", retryable: false };
  }
  if (parsed.isDRM) {
    return { ok: false, error: "DASH защищён (DRM), скачивание недоступно", errorCode: "DRM", retryable: false };
  }
  if (parsed.variants.length === 0) {
    return { ok: false, error: "DASH: нет представлений", errorCode: "DASH_NO_REP", retryable: false };
  }
  // Выбираем лучшее ВИДЕО-представление (audio-only отбрасываем — иначе
  // вместо фильма скачается звуковая дорожка).
  const videoReps = parsed.variants.filter((v) => !v.isAudioOnly);
  const pool = videoReps.length ? videoReps : parsed.variants;
  const best = [...pool].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  manifestLog.info(`DASH: выбран ${best.resolutionLabel} (${Math.round(best.bandwidth / 1000)}kbps), сегментов: ${best.segments?.length ?? 0}`);

  const baseName = buildFilename(candidate, params.options).replace(/\.[^.]+$/, "") + `__${best.resolutionLabel}.mp4`;
  const path = `${buildPath(candidate, params.options)}/${baseName}`;

  if (!best.segments || best.segments.length === 0) {
    // Единичный файл (SegmentBase/BaseURL) — обычное прямое скачивание.
    params.setPhase?.("downloading");
    params.setMessage?.(`Скачиваем DASH: ${best.url}`);
    const r = await directDownload(best.url, path, params.options.conflictAction, params.options.downloadTimeout, params.signal, candidate.sourcePageUrl, params.options.useCookies);
    if (r.error) return { ok: false, error: r.error, errorCode: "DOWNLOAD", retryable: !!r.retryable };
    return { ok: true, filename: path };
  }

  // Полное скачивание: init первым байтом, затем все media-сегменты подряд.
  params.setPhase?.("downloading");
  try {
    const parts: Uint8Array[] = [];
    let received = 0;
    let index = 0;
    for (const seg of best.segments) {
      if (params.signal?.aborted) throw new Error("Aborted");
      index++;
      params.setMessage?.(seg.isInit
        ? `Скачиваем DASH init (${index}/${best.segments.length})…`
        : `Скачиваем DASH сегменты: ${index} / ${best.segments.length}`);
      const ruleId = /^https?:/i.test(seg.url)
        ? (await addRefererRule(seg.url, candidate.sourcePageUrl, params.options.useCookies)).ruleId
        : null;
      try {
        const resp = await fetch(seg.url, { signal: params.signal, credentials: "include" as RequestCredentials });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        parts.push(buf);
        received += buf.byteLength;
        params.onProgress?.(index / best.segments.length, 1);
      } finally {
        await removeRefererRule(ruleId);
      }
    }
    params.setPhase?.("merging");
    params.setMessage?.("Склеиваем DASH в один файл…");
    const merged = new Uint8Array(received);
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.byteLength; }
    if (merged.length > MAX_BLOB_BYTES * 2) {
      return { ok: false, error: `DASH-результат слишком велик (${(merged.length / 1024 / 1024 / 1024).toFixed(2)} GB)`, errorCode: "TOO_BIG", retryable: false };
    }
    const saved = await saveBytesToFile(merged, path, "video/mp4");
    if (!saved.ok) return { ok: false, error: saved.error || "сохранение не удалось", errorCode: "DOWNLOAD", retryable: false };
    return { ok: true, filename: path, bytes: merged.length };
  } catch (e) {
    if (params.signal?.aborted || (e as Error).message === "Aborted") {
      return { ok: false, error: "Отменено", errorCode: "ABORTED", retryable: false };
    }
    return { ok: false, error: `DASH: ${(e as Error).message}`, errorCode: "DASH_FETCH", retryable: true };
  }
}

// ─── Главный downloader ────────────────────────────────────────────────────

export async function downloadVideo(params: DownloadParams): Promise<DownloadResult> {
  const { candidate } = params;
  downloadLog.info(`→ ${candidate.title || candidate.videoUrl.slice(0, 60)} (${candidate.container}, ${candidate.isManifest ? "manifest" : "file"})`);

  // 1) blob: и data:
  if (candidate.videoUrl.startsWith("blob:") || candidate.videoUrl.startsWith("data:")) {
    if (!params.options.downloadBlobs) {
      downloadLog.warn("Blob: отключено в настройках");
      return { ok: false, error: "Скачивание blob: отключено в настройках", errorCode: "DISABLED", retryable: false };
    }
    return downloadBlobUrl(candidate, params);
  }

  // 2) HLS manifest
  if (candidate.isManifest && candidate.container === "hls") {
    return downloadHls(candidate, params);
  }

  // 3) DASH manifest
  if (candidate.isManifest && candidate.container === "dash") {
    return downloadDash(candidate, params);
  }

  // 4) Скачивание. DNR-правило (Referer+Origin+Sec-Fetch+cookies) живёт весь маршрут.
  //    Для hotlink-сайтов (HEAD/GET дали 403 при метаданных) сразу идём через
  //    fetch+blob — не будет ни 403, ни .htm-болванок от downloads API.
  params.setPhase?.("downloading");
  params.setMessage?.("Начинаем скачивание…");
  const filename = buildFilename(candidate, params.options);
  const path = `${buildPath(candidate, params.options)}/${filename}`;
  downloadLog.info(`Direct: ${path} ← ${candidate.videoUrl.slice(0, 80)}`);
  const useCookies = params.options.useCookies === true;
  const ruleId = /^https?:/i.test(candidate.videoUrl)
    ? (await addRefererRule(candidate.videoUrl, candidate.sourcePageUrl, useCookies)).ruleId
    : null;
  try {
    let r: { error?: string; retryable?: boolean; bytes?: number; mime?: string; id?: number };
    const hotlink = !!candidate.hotlinkProtected;
    const progress = (received: number, total?: number) => {
      candidate.receivedBytes = received;
      candidate.progress = total ? received / total : 0;
      params.onProgress?.(received, total);
    };

    if (hotlink && /^https?:/i.test(candidate.videoUrl)) {
      downloadLog.info(`Hotlink-защита обнаружена — сразу fetch+blob (минуем downloads API)`);
      r = await fetchBlobDownload(candidate.videoUrl, path, params.options.conflictAction, progress, params.signal, candidate.sourcePageUrl);
    } else {
      r = await directDownload(candidate.videoUrl, path, params.options.conflictAction, params.options.downloadTimeout, params.signal, undefined, useCookies);

      // «Успешное» скачивание может оказаться HTML/JSON-заглушкой — проверяем.
      if (!r.error) {
        const suspect = classifySuspicious(r.mime, r.bytes ?? undefined);
        if (suspect) {
          // Удаляем болванку с диска и из истории.
          if (r.id != null) {
            try { void chrome.downloads.removeFile(r.id); } catch { /* */ }
            try { void chrome.downloads.erase({ id: r.id }); } catch { /* */ }
          }
          downloadLog.warn(`Direct: ${suspect} — пробуем fetch-маршрут`);
          r = { error: suspect, retryable: false, mime: r.mime };
          (r as { suspect?: boolean }).suspect = true;
        }
      }

      const isSuspect = !!(r as { suspect?: boolean }).suspect;
      if ((r.error === "SERVER_FORBIDDEN" || isSuspect) && /^https?:/i.test(candidate.videoUrl)) {
        params.setMessage?.("Пробуем fetch из фона…");
        downloadLog.warn(`${r.error} → fetch+blob fallback (DNR активен): ${candidate.videoUrl.slice(0, 80)}`);
        r = await fetchBlobDownload(candidate.videoUrl, path, params.options.conflictAction, progress, params.signal, candidate.sourcePageUrl);
      }
    }

    // Последний шанс: fetch из контекста страницы.
    if (r.error && !params.signal?.aborted && /^https?:/i.test(candidate.videoUrl)) {
      params.setMessage?.("Пробуем fetch со страницы…");
      downloadLog.warn(`${r.error} → content-fetch fallback: ${candidate.videoUrl.slice(0, 80)}`);
      r = await contentFetchDownload(candidate.videoUrl, path, params.options.downloadTimeout, params.options.conflictAction, candidate.sourcePageUrl);
    }

    // Финальная валидация размера для fetch-маршрутов.
    if (!r.error && r.bytes != null && r.bytes > 0 && r.bytes < MIN_PLAUSIBLE_VIDEO_BYTES) {
      const msg = `файл подозрительно мал (${r.bytes} Б) — вероятно, заглушка, а не медиа`;
      downloadLog.warn(`Direct: ${msg}`);
      return { ok: false, error: msg, errorCode: "TOO_SMALL", retryable: false };
    }

    if (r.error) {
      downloadLog.error(`Direct: ошибка: ${r.error}`);
      return { ok: false, error: r.error, errorCode: "DOWNLOAD", retryable: !!r.retryable };
    }
    downloadLog.info(`✓ ${path}`);
    return { ok: true, filename: path, bytes: r.bytes };
  } finally {
    await removeRefererRule(ruleId);
  }
}
