// Резолвер метаданных видео: HEAD + Range-sniff + парсинг MP4 (moov/trak) и WebM (EBML).
// Логирует каждый шаг.
import { be32, ascii, mimeToExt, normalizeUrl, parseContentDisposition, sha1Hex, extensionFromUrl } from "../shared/utils";
import { metadataLog } from "../shared/logger";
import { detectFormat } from "./formats";
import { SNIFF_BYTES } from "../shared/constants";
import type { Container, SourceType } from "../shared/types";

export interface VideoMeta {
  fileSize?: number;
  mimeType?: string;
  extension?: string;
  container?: Container;
  isManifest?: boolean;
  isDRM?: boolean;
  isEncrypted?: boolean;
  durationSec?: number;
  width?: number;
  height?: number;
  codecVideo?: string;
  codecAudio?: string;
  bitrateKbps?: number;
  contentDisposition?: string;
  finalUrl?: string;
  fingerprint?: string;
  /** Accept-Ranges (для докачки). */
  acceptRanges?: boolean;
  /** Сервер вернул 403 на HEAD/GET — hotlink-защита. */
  hotlinkProtected?: boolean;
}

export interface ResolveOptions {
  timeoutMs: number;
  knownWidth?: number;
  knownHeight?: number;
  knownDurationSec?: number;
  sourceType: SourceType;
  fetchLike?: typeof fetch;
  /** Referer для запросов — нужен сайтам с hotlink-защитой (403 без него). */
  referer?: string;
}

export class HttpError extends Error {
  code: "TIMEOUT" | "NETWORK_ERROR" | "HTTP" | "ABORTED" | "NO_PERMISSION" | "CORS" | "SIZE_LIMIT";
  status?: number;
  retryable: boolean;
  constructor(msg: string, code: HttpError["code"], retryable: boolean, status?: number) {
    super(msg); this.code = code; this.retryable = retryable; this.status = status;
  }
}

async function safeFetch(url: string, init: RequestInit & { timeoutMs: number; method?: string; maxBytes?: number; referer?: string }, fetchLike: typeof fetch): Promise<{ resp: Response; bytes?: Uint8Array; aborted?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    // ВАЖНО: fetch не позволяет слать Referer (forbidden header) — бросает TypeError.
    // Для hotlink-сайтов Referer добавляется правилом declarativeNetRequest при скачивании.
    const resp = await fetchLike(url, {
      method: init.method,
      signal: controller.signal,
      headers: init.headers as HeadersInit,
      redirect: "follow",
      credentials: "include" as RequestCredentials,
    });
    if (init.method === "HEAD" || (init.maxBytes ?? 0) <= 0) {
      return { resp };
    }
    // Stream up to maxBytes
    const reader = resp.body?.getReader();
    if (!reader) {
      const buf = await resp.arrayBuffer();
      return { resp, bytes: new Uint8Array(buf.slice(0, init.maxBytes ?? SNIFF_BYTES)) };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = (init.maxBytes ?? SNIFF_BYTES) - total;
      if (room <= 0) { try { await reader.cancel(); } catch { /* */ } break; }
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        total += room;
        try { await reader.cancel(); } catch { /* */ }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    return { resp, bytes: merged };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new HttpError(`Timeout (${init.timeoutMs}ms)`, "TIMEOUT", true);
    }
    const msg = String((e as Error)?.message || e);
    if (/permission/i.test(msg)) {
      throw new HttpError(`No host permission`, "NO_PERMISSION", false);
    }
    if (/cors/i.test(msg) || /failed to fetch/i.test(msg)) {
      throw new HttpError(`CORS/Network blocked`, "CORS", false);
    }
    throw new HttpError(`Network error: ${msg}`, "NETWORK_ERROR", true);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveVideoMetadata(
  videoUrl: string,
  opts: ResolveOptions
): Promise<VideoMeta> {
  const url = normalizeUrl(videoUrl) ?? videoUrl;
  const isBlob = url.startsWith("blob:") || url.startsWith("data:");
  const fetchLike = opts.fetchLike ?? fetch;

  if (isBlob) {
    metadataLog.debug(`Meta: blob/data URL, HEAD пропускаем`, { ref: { kind: "url", id: videoUrl } });
    return { mimeType: "application/octet-stream", isManifest: false };
  }

  let mimeType: string | undefined;
  let fileSize: number | undefined;
  let contentDisposition: string | undefined;
  let finalUrl: string | undefined;
  let acceptRanges: boolean | undefined;
  let bytes: Uint8Array | null = null;
  let status: number | undefined;
  let saw403 = false;

  // 1) HEAD — даёт Content-Length, Content-Type, Accept-Ranges.
  try {
    metadataLog.trace(`HEAD ${url}`);
    const { resp } = await safeFetch(url, { method: "HEAD", timeoutMs: opts.timeoutMs, referer: opts.referer }, fetchLike);
    status = resp.status;
    if (resp.status === 403 || resp.status === 401) saw403 = true;
    if (resp.ok) {
      mimeType = resp.headers.get("content-type")?.split(";")[0].trim();
      const cl = parseInt(resp.headers.get("content-length") || "", 10);
      if (!isNaN(cl)) fileSize = cl;
      contentDisposition = resp.headers.get("content-disposition") || undefined;
      finalUrl = resp.url;
      const ar = resp.headers.get("accept-ranges");
      acceptRanges = !!ar && ar.toLowerCase() !== "none";
      metadataLog.debug(`HEAD ${url} → ${resp.status}, ${fileSize ?? "?"} bytes, ${mimeType ?? "?"}`);
    } else {
      // 403/405 на HEAD — норм для YouTube/CDN: метаданные получим из query или Range-GET.
      metadataLog.debug(`HEAD ${url} → ${resp.status} (пропуск — это нормально для CDN)`);
    }
  } catch (e) {
    const err = e as HttpError;
    metadataLog.debug(`HEAD ${url} → ${err.message}`);
  }

  // 2) Range-GET для sniff.
  if (opts.knownWidth === undefined || opts.knownHeight === undefined || !fileSize) {
    try {
      const { resp, bytes: sniffed } = await safeFetch(url, {
        method: "GET",
        timeoutMs: opts.timeoutMs,
        maxBytes: SNIFF_BYTES,
        referer: opts.referer,
        headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` },
      }, fetchLike);
      if (resp.status === 403 || resp.status === 401) saw403 = true;
      if (resp.ok || resp.status === 206) {
        if (sniffed) {
          bytes = sniffed;
          if (!fileSize) {
            const cr = resp.headers.get("content-range");
            if (cr) {
              const m = /\/(\d+)\s*$/.exec(cr);
              if (m) fileSize = parseInt(m[1], 10);
            }
          }
          finalUrl = finalUrl ?? resp.url;
          mimeType = mimeType ?? resp.headers.get("content-type")?.split(";")[0].trim();
          contentDisposition = contentDisposition ?? (resp.headers.get("content-disposition") || undefined);
          acceptRanges = acceptRanges ?? /bytes/i.test(resp.headers.get("accept-ranges") || "");
        }
        metadataLog.debug(`GET ${url} → ${resp.status}, ${bytes?.byteLength ?? 0} байт для sniff`);
      }
    } catch (e) {
      const err = e as HttpError;
      metadataLog.warn(`GET-sniff ${url} → ${err.message}`);
    }
  }

  // 2.5) Fallback: метаданные прямо из query-параметров URL (googlevideo, CDN-плееры).
  // YouTube-ссылки содержат clen=…, mime=video/mp4, dur=… — они валиднее того,
  // что вернул HEAD: googlevideo на запросы БЕЗ подписи/PO-токена отвечает
  // крошечной HTML/JSON-заглушкой с Content-Length в пару сотен байт.
  const MIN_PLAUSIBLE_META_BYTES = 16 * 1024;
  let durFromQuery: number | undefined;
  try {
    const u = new URL(url);
    const clen = parseInt(u.searchParams.get("clen") || "", 10);
    const mimeParam = u.searchParams.get("mime");
    const durParam = parseFloat(u.searchParams.get("dur") || "");
    if (clen && (!fileSize || fileSize < MIN_PLAUSIBLE_META_BYTES)) {
      if (fileSize && fileSize < MIN_PLAUSIBLE_META_BYTES) {
        metadataLog.debug(`Fallback: HEAD дал подозрительно малый размер ${fileSize} Б — берём clen=${clen} из query`);
      }
      fileSize = clen;
    }
    if (!mimeType || /octet-stream|text\/html|application\/json/i.test(mimeType)) {
      if (mimeParam) {
        mimeType = mimeParam;
        metadataLog.debug(`Fallback: mime=${mimeParam} из query URL`);
      }
    }
    if (durParam) {
      durFromQuery = durParam;
      metadataLog.debug(`Fallback: dur=${durParam}s из query URL`);
    }
  } catch { /* не URL — ignore */ }

  // 3) Определяем формат.
  let container: Container = "unknown";
  let isManifest = false;
  let isDRM = false;
  let isEncrypted = false;
  let detectedMime = mimeType || "application/octet-stream";
  if (bytes && bytes.length > 0) {
    const fmt = detectFormat(bytes, url, mimeType);
    container = fmt.container;
    isManifest = fmt.isManifest;
    isDRM = fmt.isDRM;
    isEncrypted = fmt.isEncrypted;
    detectedMime = fmt.mime;
    if (fmt.confidence > 0.5) {
      metadataLog.debug(`Format: ${container.toUpperCase()} (${detectedMime}), manifest=${isManifest}, DRM=${isDRM}, enc=${isEncrypted}, conf=${(fmt.confidence * 100).toFixed(0)}%`);
    }
  } else {
    // Даже без байтов и mimeType формат узнаётся по расширению URL (.mp4 → mp4).
    const fmt = detectFormat(new Uint8Array(), url, mimeType);
    container = fmt.container;
    isManifest = fmt.isManifest;
    isDRM = fmt.isDRM;
    isEncrypted = fmt.isEncrypted;
    detectedMime = fmt.mime;
    if (container !== "unknown") {
      metadataLog.debug(`Format (по URL): ${container.toUpperCase()} (${detectedMime})`);
    }
  }

  // 4) Парсим длительность/размеры из контейнера.
  let durationSec = opts.knownDurationSec ?? durFromQuery;
  let width = opts.knownWidth;
  let height = opts.knownHeight;
  let codecVideo: string | undefined;
  let codecAudio: string | undefined;

  if (bytes) {
    try {
      if (container === "mp4") {
        const mp4 = parseMp4Boxes(bytes);
        if (mp4) {
          durationSec ??= mp4.durationSec;
          width ??= mp4.width;
          height ??= mp4.height;
          codecVideo = mp4.codecVideo;
          codecAudio = mp4.codecAudio;
          if (mp4.durationSec) metadataLog.debug(`MP4: ${width}×${height}, ${mp4.durationSec.toFixed(1)}s, video=${codecVideo}, audio=${codecAudio}`);
        }
      } else if (container === "webm" || container === "mkv") {
        const ebml = parseEbmlBasic(bytes);
        if (ebml) {
          width ??= ebml.width;
          height ??= ebml.height;
          durationSec ??= ebml.durationSec;
          codecVideo = ebml.codecVideo;
          if (ebml.durationSec) metadataLog.debug(`EBML(${container}): ${width}×${height}, ${ebml.durationSec.toFixed(1)}s, codec=${codecVideo}`);
        }
      }
    } catch (e) {
      metadataLog.warn(`Парсинг контейнера ${container} не удался: ${(e as Error).message}`);
    }
  }

  const ext = mimeToExt(detectedMime) || extensionFromUrl(url);
  const bitrateKbps = fileSize && durationSec ? Math.round((fileSize * 8) / (durationSec * 1000)) : undefined;

  let fingerprint: string | undefined;
  if (bytes && bytes.length >= 256) {
    try { fingerprint = await sha1Hex(bytes.subarray(0, 4096)); }
    catch { /* ignore */ }
  }

  if (fileSize) metadataLog.info(`Meta: ${url.slice(0, 80)} → ${container}, ${(fileSize / 1024 / 1024).toFixed(1)} MB, ${durationSec ? Math.round(durationSec) + 's' : '?'}, ${width || '?'}×${height || '?'}${bitrateKbps ? ', ' + Math.round(bitrateKbps) + 'kbps' : ''}`);

  return {
    fileSize, mimeType: detectedMime, extension: ext,
    container, isManifest, isDRM, isEncrypted,
    durationSec, width, height, codecVideo, codecAudio, bitrateKbps,
    contentDisposition, finalUrl: finalUrl !== url ? finalUrl : undefined,
    fingerprint, acceptRanges, hotlinkProtected: saw403,
  };
}

// ─── MP4 boxes parser (минимальный) ───────────────────────────────────────

interface Mp4Info {
  width?: number;
  height?: number;
  durationSec?: number;
  codecVideo?: string;
  codecAudio?: string;
}

function parseMp4Boxes(bytes: Uint8Array): Mp4Info | null {
  const info: Mp4Info = {};
  walkBoxes(bytes, 0, bytes.length, (type, payload, end) => {
    if (type === "moov") {
      walkBoxes(payload, 0, payload.length, (t2, p2) => {
        if (t2 === "trak") {
          let trackW: number | undefined, trackH: number | undefined, dur: number | undefined, codec: string | undefined;
          walkBoxes(p2, 0, p2.length, (t3, p3) => {
            if (t3 === "tkhd") {
              const v = readVersioned(p3);
              if (v.version === 1 && 32 + 8 <= p3.length) {
                dur = readU64(p3, 20 + 4);
                // tkhd v1: 32+8+8+4+4+8+8+2+2+2+2+36+4+8+4+4+4+4 (varies)
                // Безопаснее: читаем по fixed offset.
              } else if (v.version === 0 && 20 + 4 <= p3.length) {
                dur = readU32(p3, 20);
              }
              if (p3.length >= 84) {
                trackW = readU32(p3, 84);
                trackH = readU32(p3, 88);
              }
            } else if (t3 === "mdia") {
              walkBoxes(p3, 0, p3.length, (t4, p4) => {
                if (t4 === "mdhd") {
                  const v = readVersioned(p4);
                  if (v.version === 1) {
                    if (v.payload.length >= 8 + 4 + 4 + 4) {
                      const timescale = readU32(p4, 20);
                      const d1 = readU64(p4, 24);
                      if (timescale > 0 && d1) dur = d1 / timescale;
                    }
                  } else {
                    if (v.payload.length >= 4 + 4 + 4 + 4) {
                      const timescale = readU32(p4, 12);
                      const d = readU32(p4, 16);
                      if (timescale > 0) dur = d / timescale;
                    }
                  }
                } else if (t4 === "minf") {
                  walkBoxes(p4, 0, p4.length, (t5, p5) => {
                    if (t5 === "stbl") {
                      walkBoxes(p5, 0, p5.length, (t6, p6) => {
                        if (t6 === "stsd") {
                          // первый sample entry — ищем avc1/hvc1/mp4a
                          if (p6.length >= 8) {
                            const sample = ascii(p6, 8, 4);
                            codec = sample;
                          }
                        }
                      });
                    }
                  });
                }
              });
            }
          });
          if (trackW && trackH) {
            if (!info.width || trackW > info.width) info.width = trackW;
            if (!info.height || trackH > info.height) info.height = trackH;
          }
          if (codec) {
            if (/^(avc1|hvc1|hev1|vp09|av01)/.test(codec) && !info.codecVideo) info.codecVideo = codec;
            else if (/^(mp4a|opus|ac-3|ec-3)/.test(codec) && !info.codecAudio) info.codecAudio = codec;
          }
        }
      });
    }
  });
  if (!info.width || !info.height) return null;
  if (info.durationSec && !info.durationSec) info.durationSec = 0;
  return info;
}

function walkBoxes(buf: Uint8Array, start: number, end: number, fn: (type: string, payload: Uint8Array, end: number) => void): void {
  let off = start;
  while (off + 8 <= end) {
    const size32 = be32(buf, off);
    const type = ascii(buf, off + 4, 4);
    if (!type) break;
    let size: number;
    let headerLen = 8;
    if (size32 === 1) {
      // 64-bit
      const hi = be32(buf, off + 8);
      const lo = be32(buf, off + 12);
      size = hi * 2 ** 32 + lo;
      headerLen = 16;
    } else if (size32 === 0) {
      size = end - off;
    } else {
      size = size32;
    }
    if (size < headerLen) break;
    const payloadStart = off + headerLen;
    const payloadEnd = off + size;
    if (payloadEnd > end) break;
    const payload = new Uint8Array(buf.buffer, buf.byteOffset + payloadStart, payloadEnd - payloadStart);
    fn(type, payload, payloadEnd);
    off = payloadEnd;
  }
}

function readVersioned(p: Uint8Array): { version: number; payload: Uint8Array } {
  return { version: p[0] ?? 0, payload: p.subarray(4) };
}
function readU32(p: Uint8Array, off: number): number { return be32(p, off) ?? 0; }
function readU64(p: Uint8Array, off: number): number {
  const hi = be32(p, off) ?? 0;
  const lo = be32(p, off + 4) ?? 0;
  return hi * 2 ** 32 + lo;
}
function readEbmlUint(b: Uint8Array, off: number): number {
  const b0 = b[off] ?? 0;
  if (!(b0 & 0x80)) return b0 & 0x7F;
  const len = 8 - Math.clz32(b0 & 0xFF) - 1;
  let v = b0 & (0xFF >> len);
  for (let i = 1; i < len; i++) v = (v << 8) | (b[off + i] ?? 0);
  return v >>> 0;
}

// ─── EBML basic parser ────────────────────────────────────────────────────

function parseEbmlBasic(bytes: Uint8Array): Mp4Info | null {
  const info: Mp4Info = {};
  try {
    const segIdx = findAscii(bytes, "Segment", 0);
    if (segIdx < 0) return null;
    walkEbml(bytes, segIdx + 7, bytes.length, (id, payload) => {
      if (id === "Tracks") {
        walkEbml(payload, 0, payload.length, (tId, tPayload) => {
          if (tId === "TrackEntry") {
            let width = 0, height = 0, dur: number | undefined;
            let codecId: string | undefined;
            walkEbml(tPayload, 0, tPayload.length, (eId, ePayload) => {
              if (eId === "Video") {
                walkEbml(ePayload, 0, ePayload.length, (vId, vPayload) => {
                  if (vId === "PixelWidth" && vPayload.length >= 2) width = readEbmlUint(vPayload, 0);
                  else if (vId === "PixelHeight" && vPayload.length >= 2) height = readEbmlUint(vPayload, 0);
                });
              } else if (eId === "CodecID" && ePayload.length > 0) {
                codecId = ascii(ePayload, 0, ePayload.length);
              } else if (eId === "DefaultDuration" && ePayload.length >= 1) {
                const ns = readEbmlUint(ePayload, 0);
                if (ns > 0) dur = (dur ?? 0) + ns / 1_000_000;
              }
            });
            if (width && !info.width) info.width = width;
            if (height && !info.height) info.height = height;
            if (dur && !info.durationSec) info.durationSec = dur;
            if (codecId && !info.codecVideo) info.codecVideo = codecId;
          }
        });
      }
    });
  } catch { /* ignore */ }
  if (!info.width) return null;
  return info;
}

function findAscii(b: Uint8Array, s: string, from: number): number {
  const target = new TextEncoder().encode(s);
  outer: for (let i = from; i < b.length - target.length; i++) {
    for (let j = 0; j < target.length; j++) if (b[i + j] !== target[j]) continue outer;
    return i;
  }
  return -1;
}

function walkEbml(buf: Uint8Array, start: number, end: number, fn: (id: string, payload: Uint8Array) => void): void {
  let off = start;
  while (off + 4 < end) {
    const { id, len, headerLen } = readEbmlId(buf, off);
    if (len === undefined) break;
    const payloadStart = off + headerLen;
    const payloadEnd = payloadStart + len;
    if (payloadEnd > end) break;
    fn(id, new Uint8Array(buf.buffer, buf.byteOffset + payloadStart, len));
    off = payloadEnd;
  }
}

function readEbmlId(buf: Uint8Array, off: number): { id: string; len: number | undefined; headerLen: number } {
  const b0 = buf[off] ?? 0;
  let idBytes: number;
  if (b0 & 0x80) idBytes = 1;
  else if (b0 & 0x40) idBytes = 2;
  else if (b0 & 0x20) idBytes = 3;
  else if (b0 & 0x10) idBytes = 4;
  else return { id: "", len: undefined, headerLen: 0 };
  const id = ascii(buf, off, idBytes);
  const sizeStart = off + idBytes;
  const sizeByte0 = buf[sizeStart] ?? 0;
  let sizeLen: number;
  if (sizeByte0 & 0x80) sizeLen = 1;
  else if (sizeByte0 & 0x40) sizeLen = 2;
  else if (sizeByte0 & 0x20) sizeLen = 3;
  else if (sizeByte0 & 0x10) sizeLen = 4;
  else if (sizeByte0 & 0x08) sizeLen = 5;
  else if (sizeByte0 & 0x04) sizeLen = 6;
  else if (sizeByte0 & 0x02) sizeLen = 7;
  else if (sizeByte0 & 0x01) sizeLen = 8;
  else return { id, len: undefined, headerLen: idBytes + 1 };
  let len = sizeByte0 & 0x7F;
  for (let i = 1; i < sizeLen; i++) {
    len = (len << 8) | (buf[sizeStart + i] ?? 0);
  }
  return { id, len, headerLen: idBytes + sizeLen };
}

export { parseContentDisposition };
