// HLS-парсер (RFC 8216). Master + media playlist.
// Поддержка: EXT-X-KEY (AES-128 c IV и ротацией ключей), EXT-X-SESSION-KEY,
// EXT-X-MAP (fMP4 init), EXT-X-BYTERANGE (в т.ч. без явного offset),
// аудио-only варианты. Скачивание: init первым байтом, Range-запросы,
// расшифровка AES-CBC через crypto.subtle.
import { bytesToText, normalizeUrl, uid } from "../shared/utils";
import type { HlsVariant } from "../shared/types";
import { manifestLog } from "../shared/logger";

export interface HlsParseResult {
  ok: boolean;
  isMaster: boolean;
  variants: HlsVariant[];
  /** Для media playlist: абсолютные URL сегментов + init map (для fMP4). */
  segments?: HlsSegmentInfo[];
  /** Абсолютный URL ключа AES-128 (если есть). null — нет шифрования. */
  keyUri?: string | null;
  /** true — есть SAMPLE-AES или другой CENC DRM. */
  isDRM: boolean;
  /** true — есть AES-128 (расшифровка выполняется при скачивании). */
  isEncrypted: boolean;
  /** Endlist / VOD? */
  isVOD: boolean;
  /** Плейлист использует fMP4-сегменты (EXT-X-MAP) — выходной контейнер mp4. */
  isFmp4: boolean;
  /** Ошибка парсинга. */
  error?: string;
}

export interface HlsSegmentInfo {
  /** Абсолютный URL сегмента (.ts или .m4s). */
  url: string;
  /** Длительность в секундах. */
  duration: number;
  /** Sequence number (для вычисления IV по умолчанию). */
  seq: number;
  /** Byte-range (если указана в playlist). */
  byteRange?: { start: number; length: number };
  /** true — сегмент инициализации fMP4 (EXT-X-MAP). */
  isInit?: boolean;
  /** Активное на момент сегмента состояние шифрования. */
  key?: HlsKeyInfo | null;
}

export interface HlsKeyInfo {
  method: "AES-128" | "SAMPLE-AES";
  uri?: string;
  iv?: string;
}

const MAX_SEGMENTS = 20_000;

export function parseHls(text: string, baseUrl: string): HlsParseResult {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0 || !/^#EXTM3U/i.test(lines[0])) {
    return { ok: false, isMaster: false, variants: [], isDRM: false, isEncrypted: false, isVOD: false, isFmp4: false, error: "Not a valid m3u8 (no #EXTM3U header)" };
  }
  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));
  if (isMaster) return parseMaster(lines, baseUrl);
  return parseMedia(lines, baseUrl);
}

function parseAttrList(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1].toUpperCase();
    attrs[key] = m[3] !== undefined ? m[3] : (m[4] ?? "").trim();
  }
  return attrs;
}

function keyFromTag(line: string): { key: HlsKeyInfo; method: string } {
  const method = (/METHOD=([^,]+)/.exec(line)?.[1]?.toUpperCase() || "NONE") as string;
  if (method === "AES-128" || method === "SAMPLE-AES") {
    return {
      method: method as HlsKeyInfo["method"],
      key: {
        method: method as HlsKeyInfo["method"],
        uri: /URI="([^"]+)"/.exec(line)?.[1],
        iv: /IV=0x([0-9a-fA-F]+)/.exec(line)?.[1],
      },
    };
  }
  return { method: "NONE", key: null as unknown as HlsKeyInfo };
}

function parseMaster(lines: string[], baseUrl: string): HlsParseResult {
  const variants: HlsVariant[] = [];
  let isDRM = false;
  let isEncrypted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Шифрование уровня master — только через EXT-X-SESSION-KEY
    // (у STREAM-INF таких атрибутов не бывает).
    if (line.startsWith("#EXT-X-SESSION-KEY")) {
      const { method } = keyFromTag(line);
      if (method === "SAMPLE-AES") isDRM = true;
      else if (method === "AES-128") isEncrypted = true;
      continue;
    }
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;
    const attrs = parseAttrList(line.slice("#EXT-X-STREAM-INF:".length));
    // Следующая не-тег строка — URL.
    let url = "";
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j].trim();
      if (!l || l.startsWith("#")) continue;
      url = l; i = j; break;
    }
    const abs = normalizeUrl(url, baseUrl);
    if (!abs) continue;
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
    ok: true, isMaster: true, variants, isDRM, isEncrypted, isVOD: true, isFmp4: false,
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
  let currentKey: HlsKeyInfo | null = null;
  let initSegmentUrl: string | null = null;
  let initByteRange: { start: number; length: number } | null = null;
  let isFmp4 = false;

  let pendingDuration: number | null = null;
  let pendingByteRange: string | null = null;
  let lastRangeEnd = 0;

  for (let i = 0; i < lines.length && segments.length <= MAX_SEGMENTS; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-TARGETDURATION")) {
      targetDur = parseInt(line.split(":")[1] || "0", 10) || 0;
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      mediaSeq = parseInt(line.split(":")[1] || "0", 10) || 0;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      endlist = true;
    } else if (line.startsWith("#EXT-X-KEY")) {
      const { method, key } = keyFromTag(line);
      if (method === "AES-128") {
        isEncrypted = true;
        currentKey = key;
        keyUri = key.uri ? normalizeUrl(key.uri, baseUrl) ?? key.uri : null;
        if (keyUri) currentKey = { ...currentKey!, uri: keyUri };
      } else if (method === "SAMPLE-AES") {
        isDRM = true;
        currentKey = key;
      } else {
        // METHOD=NONE — шифрование закончилось (ротация ключей).
        currentKey = null;
      }
    } else if (line.startsWith("#EXT-X-MAP")) {
      const u = /URI="([^"]+)"/.exec(line)?.[1];
      if (u) {
        initSegmentUrl = normalizeUrl(u, baseUrl) ?? u;
        const br = /BYTERANGE="([^"]+)"/.exec(line)?.[1];
        const parsedBr = br ? parseByteRange(br) : undefined;
        initByteRange = (parsedBr && parsedBr.start >= 0) ? parsedBr : null;
        isFmp4 = true;
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
          key: null,
        });
        initSegmentUrl = null;
        initByteRange = null;
      }

      let range: { start: number; length: number } | undefined;
      if (pendingByteRange) {
        const parsed = parseByteRange(pendingByteRange);
        if (parsed) {
          // BYTERANGE="N" без @O — продолжение с конца предыдущего сегмента.
          range = parsed.start >= 0 ? parsed : { start: lastRangeEnd, length: parsed.length };
          lastRangeEnd = range.start + range.length;
        }
      } else {
        lastRangeEnd = 0;
      }
      pendingByteRange = null;

      segments.push({
        url: abs,
        duration: pendingDuration ?? targetDur,
        seq: mediaSeq,
        byteRange: range,
        key: currentKey ? { ...currentKey } : null,
      });
      mediaSeq++;
      pendingDuration = null;
    }
  }

  return {
    ok: true, isMaster: false, variants: [], segments,
    isDRM, isEncrypted, isVOD: endlist, keyUri, isFmp4,
  };
}

function parseByteRange(s: string): { start: number; length: number } | undefined {
  // "N@" — length N от текущей позиции; "N@O" — от O.
  const at = s.indexOf("@");
  const length = parseInt(at < 0 ? s : s.slice(0, at), 10) || 0;
  if (!length) return undefined;
  const start = at >= 0 ? (parseInt(s.slice(at + 1), 10) || 0) : -1;
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
      return { ok: false, isMaster: false, variants: [], isDRM: false, isEncrypted: false, isVOD: false, isFmp4: false, error: `HTTP ${resp.status}` };
    }
    const buf = await resp.arrayBuffer();
    const text = bytesToText(new Uint8Array(buf));
    const result = parseHls(text, url);
    if (result.isMaster) {
      manifestLog.info(`HLS master: ${url} → ${result.variants.length} вариантов качества`);
    } else {
      manifestLog.info(`HLS media: ${url} → ${result.segments?.length ?? 0} сегментов, VOD=${result.isVOD}, encrypted=${result.isEncrypted}, DRM=${result.isDRM}, fMP4=${result.isFmp4}`);
    }
    return result;
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    manifestLog.error(`HLS: ${url} → ошибка: ${msg}`);
    return { ok: false, isMaster: false, variants: [], isDRM: false, isEncrypted: false, isVOD: false, isFmp4: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

// ─── AES-128 CBC без PKCS#7 (WebCrypto всегда делает unpad) ──────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.padStart(32, "0").slice(-32);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

function seqToIv(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  const lo = Math.abs(Math.trunc(seq)) % 2 ** 32;
  new DataView(iv.buffer).setUint32(12, lo >>> 0);
  return iv;
}

/** Расшифровка AES-CBC без паддинга: трюк с дубликатом последнего блока —
 *  subtle.decrypt снимет «PKCS#7» с фиктивного блока, реальный plaintext
 *  остаётся нетронутым. */
async function aesCbcDecryptNoPad(rawKey: ArrayBuffer, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) throw new Error("crypto.subtle недоступен (нужен https)");
  const key = await cryptoObj.subtle.importKey("raw", rawKey, { name: "AES-CBC" }, false, ["decrypt"]);
  if (data.length === 0 || data.length % 16 !== 0) throw new Error(`сегмент не кратен 16 байтам (${data.length})`);
  const padded = new Uint8Array(data.length + 16);
  padded.set(data.subarray(0, data.length));
  padded.set(data.subarray(data.length - 16), data.length);
  const buf = await cryptoObj.subtle.decrypt({ name: "AES-CBC", iv: iv as unknown as BufferSource }, key, padded);
  return new Uint8Array(buf).subarray(0, data.length);
}

/** Скачивает все сегменты в один файл. Init-сегменты включаются первыми байтами,
 *  AES-128 расшифровывается, byteRange уходит в Range-заголовок. */
export async function downloadHlsSegments(
  segments: HlsSegmentInfo[],
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<Blob> {
  manifestLog.info(`HLS download: ${segments.length} сегментов`);
  const parts: Uint8Array[] = [];
  let received = 0;
  const keyCache = new Map<string, ArrayBuffer>();
  const emittedInits = new Set<string>();
  let sawFmp4 = false;

  const fetchSeg = async (seg: HlsSegmentInfo): Promise<Uint8Array> => {
    let attempt = 0;
    for (;;) {
      try {
        const headers: Record<string, string> = {};
        if (seg.byteRange && seg.byteRange.start >= 0) headers["Range"] = `bytes=${seg.byteRange.start}-${seg.byteRange.start + seg.byteRange.length - 1}`;
        const resp = await fetcher(seg.url, { headers, signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return new Uint8Array(await resp.arrayBuffer());
      } catch (e) {
        if (signal?.aborted) throw e;
        attempt++;
        if (attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  };

  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) throw new Error("Aborted");
    const seg = segments[i];
    const segUrl = normalizeUrl(seg.url, baseUrl) ?? seg.url;

    // Init-сегмент fMP4: обязателен первым байтом файла, повторяющиеся пропускаем.
    if (seg.isInit) {
      sawFmp4 = true;
      if (emittedInits.has(segUrl)) continue;
      emittedInits.add(segUrl);
    }

    manifestLog.debug(`HLS seg[${i + 1}/${segments.length}]: ${segUrl} (${seg.duration}s${seg.key?.method ? ", " + seg.key.method : ""})`);

    let bytes: Uint8Array;
    try {
      bytes = await fetchSeg({ ...seg, url: segUrl });
    } catch (e) {
      if (signal?.aborted) throw new Error("Aborted");
      // Инициализацию пропустить нельзя — файл будет невалиден.
      if (seg.isInit) throw new Error(`init-сегмент недоступен: ${(e as Error).message}`);
      manifestLog.error(`HLS seg[${i + 1}]: ${(e as Error).message} — сегмент пропущен`);
      continue;
    }

    if (seg.key?.method === "AES-128") {
      try {
        if (!seg.key.uri) throw new Error("нет URI ключа");
        let raw = keyCache.get(seg.key.uri);
        if (!raw) {
          const kResp = await fetcher(seg.key.uri, { signal });
          if (!kResp.ok) throw new Error(`ключ → HTTP ${kResp.status}`);
          raw = await kResp.arrayBuffer();
          keyCache.set(seg.key.uri, raw);
        }
        const ivHex = seg.key.iv ? seg.key.iv.replace(/^0[xX]/, "") : undefined;
        const iv = ivHex ? hexToBytes(ivHex) : seqToIv(seg.seq);
        bytes = await aesCbcDecryptNoPad(raw, iv, bytes);
      } catch (e) {
        throw new Error(`AES-128: ${(e as Error).message} (сегмент ${i + 1})`);
      }
    }

    parts.push(bytes);
    received += bytes.byteLength;
    onProgress?.(received, -1);
  }

  if (parts.length === 0) throw new Error("ни одного сегмента не скачано");
  const mime = sawFmp4 ? "video/mp4" : "video/mp2t";
  return new Blob(parts as BlobPart[], { type: mime });
}
