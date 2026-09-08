// HTTP-обёртка для service worker: таймауты, классификация ошибок, лимит размера.
import { MAX_PAGE_BYTES } from "../shared/constants";

export type HttpErrorCode =
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "HTTP"
  | "SIZE_LIMIT"
  | "ABORTED"
  | "NO_PERMISSION";

export interface HttpError extends Error {
  code: HttpErrorCode;
  status?: number;
  retryable: boolean;
}

export interface HttpResult {
  ok: boolean;
  status: number;
  statusText: string;
  isHtml: boolean;
  headers: Record<string, string>;
  bodyText?: string;
  arrayBuffer?: ArrayBuffer;
  timeMs: number;
  finalUrl: string;
}

export interface HttpFetchOptions {
  url: string;
  method?: "GET" | "HEAD";
  timeoutMs: number;
  headers?: Record<string, string>;
  maxBytes?: number;
  onStatus?: (status: number) => void;
  fetchLike?: typeof fetch;
}

export function makeHttpError(message: string, code: HttpErrorCode, retryable: boolean, status?: number): HttpError {
  const e = new Error(message) as HttpError;
  e.code = code;
  e.retryable = retryable;
  e.status = status;
  return e;
}

/** Классификация HTTP-статуса по ТЗ §15 (retry: timeout, 5xx, 429; не retry: 401/403/404). */
export function classifyHttpStatus(status: number, url: string): void {
  if (status === 401 || status === 403 || status === 404) {
    throw makeHttpError(`${status} ${statusText(status)} (${url})`, "HTTP", false, status);
  }
  if (status === 429 || status >= 500) {
    throw makeHttpError(`${status} ${statusText(status)} (${url})`, "HTTP", true, status);
  }
}

function statusText(status: number): string {
  const map: Record<number, string> = {
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 408: "Request Timeout", 410: "Gone", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  };
  return map[status] || "HTTP Error";
}

export function isHtmlContentType(ct: string | undefined): boolean {
  if (!ct) return true; // неизвестно — считаем HTML
  const t = ct.toLowerCase();
  return t.includes("text/html") || t.includes("application/xhtml") || t.startsWith("text/");
}

/** Основной запрос. Бросает HttpError при сетевой/HTTP-ошибке. */
export async function httpFetch(opts: HttpFetchOptions): Promise<HttpResult> {
  const { url, method = "GET", timeoutMs, maxBytes = MAX_PAGE_BYTES } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  const doFetch = opts.fetchLike ?? fetch;

  try {
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        signal: controller.signal,
        headers: { "Accept-Language": "en,ru;q=0.8", ...opts.headers },
        redirect: "follow",
        credentials: "include" as RequestCredentials,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw makeHttpError(`Timeout (${timeoutMs}ms): ${url}`, "TIMEOUT", true);
      }
      const msg = String((e as Error)?.message || e);
      if (/permission/i.test(msg)) {
        throw makeHttpError(`No host permission: ${url}`, "NO_PERMISSION", false);
      }
      throw makeHttpError(`Network error: ${msg} (${url})`, "NETWORK_ERROR", true);
    }

    opts.onStatus?.(response.status);
    classifyHttpStatus(response.status, url);

    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));

    let arrayBuffer: ArrayBuffer | null = null;
    let bodyText: string | undefined;
    if (method === "GET") {
      const reader = response.body?.getReader();
      if (reader) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const room = maxBytes - total;
          if (room <= 0) {
            await reader.cancel();
            break;
          }
          if (value.byteLength > room) {
            chunks.push(value.subarray(0, room));
            total += room;
            await reader.cancel();
            break;
          }
          chunks.push(value);
          total += value.byteLength;
        }
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.byteLength;
        }
        arrayBuffer = merged.buffer;
      } else {
        const full = await response.arrayBuffer();
        arrayBuffer = full.byteLength > maxBytes ? full.slice(0, maxBytes) : full;
      }
      bodyText = new TextDecoder().decode(arrayBuffer);
    }

    const isHtml = method === "GET" ? isHtmlContentType(headers["content-type"]) : true;
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      isHtml,
      headers,
      bodyText,
      arrayBuffer: arrayBuffer ?? undefined,
      timeMs: performance.now() - t0,
      finalUrl: response.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}