// HLS-парсер (RFC 8216). Поддерживает master playlist + media playlist.
// Возвращает варианты качества (для UI), или, для media playlist, — список сегментов.
import { be32, bytesToText, normalizeUrl, uid } from "../shared/utils";
import type { HlsVariant } from "../shared/types";
import { manifestLog } from "../shared/logger";

export interface HlsParseResult {
  ok: boolean;
  isMaster: boolean;
  variants: HlsVariant[];
  /** Для media playlist: абсолютные URL сегментов + init map (для fMP4). */
  segments?: HlsSegmentInfo[];
  /** Абсолютный URL ключа AES-128 (если есть). null — нет шифрования, "DRM" — SAMPLE-AES. */
  keyUri?: string | null;
  /** true — есть SAMPLE-AES или другой CENC DRM. */
  isDRM: boolean;
  /** true — есть AES-128 (расшифровка возможна, если keyUri доступен). */
  isEncrypted: boolean;
  /** Endlist / VOD? */
  isVOD: boolean;
  /** Ошибка парсинга. */
  error?: string;
}

export interface HlsSegmentInfo {
  /** Абсолютный URL сегмента (.ts или .m4s). */
  url: string;
  /** Длительность в секундах. */
  duration: number;
  /** Sequence number. */
  seq: number;
  /** Byte-range (если указана в playlist). */
  byteRange?: { start: number; length: number };
  /** true — сегмент инициализации fMP4 (EXT-X-MAP). */
  isInit?: boolean;
}

export function parseHls(text: string, baseUrl: string): HlsParseResult {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0 || !/^#EXTM3U/i.test(lines[0])) {
    return { ok: false, isMaster: false, variants: [], isDRM: false, isEncrypted: false, isVOD: false, error: "Not a valid m3u8 (no #EXTM3U header)" };
  }
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  if (isMaster) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseMaster(lines: string[], baseUrl: string): HlsParseResult {
  const variants: HlsVariant[] = [];
  let isDRM = false;
  let isEncrypted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const attrs: Record<string, string> = {};
    const attrText = line.slice("#EXT-X-STREAM-INF:".length);
    // Атрибуты могут быть в кавычках.
    const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrText)) !== null) {
      const key = m[1].toUpperCase();
      const val = m[3] !== undefined ? m[3] : (m[4] ?? "").trim();
      attrs[key] = val;
    }
    // Следующая не-тег строка — URL.
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l || l.startsWith("#")) continue;
      url = l; i = j; break;
    }
    const abs = normalizeUrl(url, baseUrl);
    if (!abs) continue;
    if (attrs["SAMPLE-AES"]) isDRM = true;
    if (attrs["AES-128"]) isEncrypted = true;
    const bw = parseInt(attrs["BANDWIDTH"] || "0", 10) || 0;
    const w = parseInt(attrs["RESOLUTION"]?.split("x")[0] || "0", 10) || undefined;
    const h = parseInt(attrs["RESOLUTION"]?.split("x")[1] || "0", 10) || undefined;
    const fr = parseFloat(attrs["FRAME-RATE"] || "") || undefined;
    variants.push({
      id: uid("v"),
      url: abs,
      bandwidth: bw,
      width: w,
      height: h,
      codecs: attrs["CODECS"] || undefined,
      frameRate: fr,
      isAudioOnly: false,
      resolutionLabel: w && h ? `${w}x${h}` : (bw ? `${Math.round(bw / 1000)}kbps` : "audio"),
    });
  }

  // Аудио-only варианты (некоторые playlist'ы делают так: media playlist без видео).
  if (variants.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(lines[i])) {
        const uri = /URI="([^"]+)"/.exec(lines[i])?.[1];
        if (uri) {
          const abs = normalizeUrl(uri, baseUrl);
          if (abs) variants.push({
            id: uid("v"), url: abs, bandwidth: 128_000, isAudioOnly: true,
            resolutionLabel: "Audio only",
          });
        }
      }
    }
  }

  if (variants.length === 0) {
    // Может быть, single media playlist.
    return parseMedia(lines, baseUrl);
  }

  return {
    ok: true, isMaster: true, variants, isDRM, isEncrypted, isVOD: true,
  };
}

function parseMedia(lines: string[], baseUrl: string): HlsParseResult {
  const segments: HlsSegmentInfo[] = [];
  let targetDur = 0;
  let mediaSeq = 0;
  let endlist = false;
  let isDRM = false;
  let isEncrypted = false;
  let keyUri: string | null = null;
  let initSegmentUrl: string | null = null;
  let initByteRange: { start: number; length: number } | null = null;

  let pendingDuration: number | null = null;
  let pendingByteRange: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-VERSION")) {
      // игнор
    } else if (line.startsWith("#EXT-X-TARGETDURATION")) {
      targetDur = parseInt(line.split(":")[1] || "0", 10) || 0;
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      mediaSeq = parseInt(line.split(":")[1] || "0", 10) || 0;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      endlist = true;
    } else if (line.startsWith("#EXT-X-KEY")) {
      const method = /METHOD=([^,]+)/.exec(line)?.[1]?.toUpperCase() || "";
      if (method === "AES-128") {
        isEncrypted = true;
        keyUri = /URI="([^"]+)"/.exec(line)?.[1] ?? null;
        if (keyUri) keyUri = normalizeUrl(keyUri, baseUrl) ?? keyUri;
      } else if (method === "SAMPLE-AES") {
        isDRM = true;
      }
    } else if (line.startsWith("#EXT-X-MAP")) {
      // URI="init.mp4" или BYTERANGE="N@O"
      const u = /URI="([^"]+)"/.exec(line)?.[1];
      if (u) {
        initSegmentUrl = normalizeUrl(u, baseUrl) ?? u;
        const br = /BYTERANGE="([^"]+)"/.exec(line)?.[1];
        if (br) initByteRange = parseByteRange(br);
      }
    } else if (line.startsWith("#EXTINF")) {
      const dur = parseFloat(line.split(":")[1]?.split(",")[0] || "0") || 0;
      pendingDuration = dur;
    } else if (line.startsWith("#EXT-X-BYTERANGE")) {
      pendingByteRange = line.split(":")[1]?.trim() ?? null;
    } else if (line.startsWith("#")) {
      // прочие теги
    } else {
      const abs = normalizeUrl(line, baseUrl);
      if (!abs) { pendingDuration = null; pendingByteRange = null; continue; }

      if (initSegmentUrl) {
        segments.push({
          url: initSegmentUrl,
          duration: 0, seq: -1,
          isInit: true,
          byteRange: initByteRange ?? undefined,
        });
        initSegmentUrl = null;
        initByteRange = null;
      }

      segments.push({
        url: abs,
        duration: pendingDuration ?? targetDur,
        seq: mediaSeq,
        byteRange: pendingByteRange ? parseByteRange(pendingByteRange) : undefined,
      });
      mediaSeq++;
      pendingDuration = null;
      pendingByteRange = null;
    }
  }

  return {
    ok: true, isMaster: false, variants: [], segments,
    isDRM, isEncrypted, isVOD: endlist, keyUri,
  };
}

function parseByteRange(s: string): { start: number; length: number } | undefined {
  // "N@" — length N от текущей позиции; "N@O" — от O.
  const at = s.indexOf("@");
  if (at < 0) return undefined;
  const length = parseInt(s.slice(0, at), 10) || 0;
  const start = parseInt(s.slice(at + 1), 10) || 0;
  if (!length) return undefined;
  return { start, length };
}

/** Загружает m3u8 и парсит. */
export async function fetchAndParseHls(
  url: string,
  fetcher: typeof fetch = fetch
): Promise<HlsParseResult> {
  manifestLog.info(`HLS: GET ${url}`);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30_000);
  try {
    const resp = await fetcher(url, { signal: controller.signal });
    if (!resp.ok) {
      manifestLog.error(`HLS: ${url} → HTTP ${resp.status}`);
      return { ok: false, isMaster: false, variants: [], isDRM: false, isEncrypted: false, isVOD: false, error: `HTTP ${resp.status}` };
    }
    const buf = await resp.arrayBuffer();
    const text = bytesToText(new Uint8Array(buf));
    const result = parseHls(text, url);
    if (result.isMaster) {
      manifestLog.info(`HLS master: ${url} → ${result.variants.length} вариантов качества`);
    } else {
      manifestLog.info(`HLS media: ${url} → ${result.segments?.length ?? 0} сегментов, VOD=${result.isVOD}, encrypted=${result.isEncrypted}, DRM=${result.isDRM}`);
    }
    return result;
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    manifestLog.error(`HLS: ${url} → ошибка: ${msg}`);
    return { ok: false, isMaster: false, variants: [], isDRM: false, isEncrypted: false, isVOD: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

/** Скачивает все сегменты в один mp4/ts файл. */
export async function downloadHlsSegments(
  segments: HlsSegmentInfo[],
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  onProgress?: (received: number, total: number) => void
): Promise<Blob> {
  manifestLog.info(`HLS download: ${segments.length} сегментов`);
  const parts: Uint8Array[] = [];
  let received = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.isInit) continue;
    const url = normalizeUrl(seg.url, baseUrl) ?? seg.url;
    manifestLog.debug(`HLS seg[${i + 1}/${segments.length}]: ${url} (${seg.duration}s)`);
    const resp = await fetcher(url);
    if (!resp.ok) {
      manifestLog.error(`HLS seg[${i + 1}]: HTTP ${resp.status} — пропускаем`);
      continue;
    }
    const buf = await resp.arrayBuffer();
    parts.push(new Uint8Array(buf));
    received += buf.byteLength;
    onProgress?.(received, -1);
  }
  return new Blob(parts as BlobPart[], { type: "video/mp2t" });
}
