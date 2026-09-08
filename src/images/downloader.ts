// Загрузка изображений (ТЗ §16, §27–28): downloads API + blob-фолбек,
// имена файлов по приоритету, запрет перезаписи (uniquify).
import type { FolderMode } from "../shared/types";
import { extensionFromUrl, sanitizeFilename } from "../shared/utils";
import { makeHttpError } from "../crawler/http";

export interface DownloadParams {
  url: string;
  candidateFilename: string;
  downloadRoot: string;
  folderMode: FolderMode;
  sourcePageUrl: string;
  depth: number;
  timeoutMs: number;
  mimeType?: string;
  extension?: string;
  ensurePermission?: (url: string) => Promise<boolean>;
}

export interface DownloadResult {
  ok: boolean;
  filename?: string;
  bytes?: number;
  error?: string;
  retryable?: boolean;
}

function buildPath(p: DownloadParams): string {
  const safeRoot = sanitizeFilename(p.downloadRoot) || "images";
  switch (p.folderMode) {
    case "flat":
      return safeRoot;
    case "depth":
      return `${safeRoot}/depth-${p.depth}`;
    case "domain":
      return `${safeRoot}/${hostnamePart(p.sourcePageUrl)}`;
    case "page":
      return `${safeRoot}/${hostnamePart(p.sourcePageUrl)}/page-${pageIndex(p.sourcePageUrl)}`;
  }
}

function hostnamePart(url: string): string {
  try {
    return sanitizeFilename(new URL(url).hostname) || "site";
  } catch {
    return "site";
  }
}

const pageIndexCache = new Map<string, number>();
let pageCounter = 0;
function pageIndex(url: string): number {
  let n = pageIndexCache.get(url);
  if (n === undefined) {
    n = ++pageCounter;
    pageIndexCache.set(url, n);
  }
  return n;
}

/** Ожидание завершения скачивания по id. */
function waitForDownload(id: number, timeoutMs: number): Promise<{ state: string; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (state: string, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      resolve({ state, error });
    };
    const timer = setTimeout(() => {
      void chrome.downloads.cancel(id).catch(() => undefined);
      finish("interrupted", "Timeout");
    }, timeoutMs);
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id) return;
      if (delta.state?.current === "complete") finish("complete");
      else if (delta.state?.current === "interrupted") finish("interrupted", delta.error?.current || "interrupted");
    };
    chrome.downloads.onChanged.addListener(listener);
    void chrome.downloads.search({ id }).then((items) => {
      const st = items[0]?.state;
      if (st === "complete") finish("complete");
      else if (st === "interrupted") finish("interrupted", items[0]?.error || "interrupted");
    }).catch(() => undefined);
  });
}

export async function downloadImage(p: DownloadParams): Promise<DownloadResult> {
  const filename = sanitizeFilename(p.candidateFilename);
  const path = `${buildPath(p)}/${filename}`;
  const url = p.url;

  const tryDirect = async (): Promise<DownloadResult> => {
    const id = await chrome.downloads.download({
      url,
      filename: path,
      conflictAction: "uniquify", // image.jpg, image (1).jpg — не перезаписываем (ТЗ §28)
      saveAs: false,
    });
    const res = await waitForDownload(id, p.timeoutMs);
    let bytes: number | undefined;
    try {
      const items = await chrome.downloads.search({ id });
      if (items[0]) bytes = items[0].fileSize ?? undefined;
    } catch {
      // не критично
    }
    if (res.state === "complete") {
      return { ok: true, filename: path, bytes };
    }
    return { ok: false, error: `Download interrupted: ${res.error || "unknown"}`, retryable: true };
  };

  // 1) Прямой путь через downloads API.
  try {
    return await tryDirect();
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    // 2) Нет host-permission для URL → фолбек: fetch → blob → downloads.
    if (/permission/i.test(msg)) {
      return await tryBlobFallback(p, path);
    }
    return { ok: false, error: msg, retryable: true };
  }
}

async function tryBlobFallback(p: DownloadParams, path: string): Promise<DownloadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs);
  try {
    const resp = await fetch(p.url, { signal: controller.signal, mode: "cors", credentials: "include" as RequestCredentials, referrer: p.sourcePageUrl });
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
        throw makeHttpError(`${resp.status} (${p.url})`, "HTTP", false, resp.status);
      }
      throw makeHttpError(`${resp.status} (${p.url})`, "HTTP", true, resp.status);
    }
    const buf = await resp.arrayBuffer();
    const blob = new Blob([buf], { type: p.mimeType || resp.headers.get("content-type") || "application/octet-stream" });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const id = await chrome.downloads.download({
        url: objectUrl,
        filename: path,
        conflictAction: "uniquify",
        saveAs: false,
      });
      const res = await waitForDownload(id, p.timeoutMs);
      if (res.state === "complete") {
        return { ok: true, filename: path, bytes: buf.byteLength };
      }
      return { ok: false, error: `Download interrupted: ${res.error || "unknown"}`, retryable: true };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return { ok: false, error: `Timeout (${p.timeoutMs}ms)`, retryable: true };
    }
    const err = e as { code?: string; message: string };
    if (err.code === "HTTP" || err.code === "NO_PERMISSION") {
      return { ok: false, error: err.message, retryable: !!((e as { retryable?: boolean }).retryable) };
    }
    return { ok: false, error: `Network error: ${err.message}`, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Имя файла по приоритету ТЗ §28: Content-Disposition → URL → alt → title → generated. */
export function resolveCandidateFilename(
  c: { imageUrl: string; alt?: string; title?: string; mimeType?: string; extension?: string },
  contentDisposition?: string
): string {
  let name = "";
  if (contentDisposition) name = sanitizeFilename(contentDisposition);
  if (!name) {
    try {
      const pathname = new URL(c.imageUrl).pathname;
      const base = decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
      if (base) name = sanitizeFilename(base);
    } catch {
      // ignore
    }
  }
  if (!name && c.alt) name = sanitizeFilename(c.alt);
  if (!name && c.title) name = sanitizeFilename(c.title);

  const ext = c.extension || (c.mimeType ? mimeToExtSimple(c.mimeType) : undefined) || extensionFromUrl(c.imageUrl);
  if (!name) {
    name = `image-${Date.now().toString(36)}`;
  }
  if (ext && !name.toLowerCase().endsWith(`.${ext}`)) {
    name = `${name}.${ext}`;
  }
  return name;
}

function mimeToExtSimple(mime: string): string | undefined {
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp", "image/x-icon": "ico",
  };
  return map[mime.toLowerCase().split(";")[0].trim()];
}