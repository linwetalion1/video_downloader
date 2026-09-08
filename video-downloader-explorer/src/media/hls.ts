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
  /** Суммарная длительность всех сегментов медиа-плейлиста в секундах. */
  totalDurationSec?: number;
  /** Количество сегментов. */
  segmentCount?: number;
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

const MAX_SEGMENTS = 120_000;

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

  // 1) Предварительный сбор всех аудио-дорожек: groupId -> audioUrl
  const audioTracksByGroup = new Map<string, string>();
  let defaultAudioUrl: string | undefined;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/i.test(line)) {
      const attrs = parseAttrList(line.slice("#EXT-X-MEDIA:".length));
      const uri = attrs["URI"];
      const groupId = attrs["GROUP-ID"] || "";
      if (uri) {
        const abs = normalizeUrl(uri, baseUrl);
        if (abs) {
          if (groupId && !audioTracksByGroup.has(groupId)) {
            audioTracksByGroup.set(groupId, abs);
          }
          if (attrs["DEFAULT"]?.toUpperCase() === "YES" || !defaultAudioUrl) {
            defaultAudioUrl = abs;
          }
        }
      }
    }
  }

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
    const audioGroup = attrs["AUDIO"];
    const audioUrl = (audioGroup ? audioTracksByGroup.get(audioGroup) : undefined) || defaultAudioUrl;
    variants.push({
      id: uid("v"),
      url: abs,
      audioUrl,
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

  let totalDurationSec = 0;
  for (const s of segments) {
    if (s.duration) totalDurationSec += s.duration;
  }
  totalDurationSec = Math.round(totalDurationSec);

  return {
    ok: true, isMaster: false, variants: [], segments,
    isDRM, isEncrypted, isVOD: endlist, keyUri, isFmp4,
    totalDurationSec, segmentCount: segments.length,
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
  return new Uint8Array(buf.slice(0, data.length) as ArrayBuffer);
}

// ─── Мультиплексирование fMP4 (объединение аудио и видео в один MP4) ───────

interface BoxHeader {
  start: number;
  end: number;
  size: number;
  type: string;
  headerLen: number;
  payloadStart: number;
  payloadEnd: number;
}

function parseBoxHeader(buf: Uint8Array, off: number, maxEnd: number): BoxHeader | null {
  if (off + 8 > maxEnd) return null;
  const size32 = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
  const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
  let size = size32;
  let headerLen = 8;
  if (size32 === 1 && off + 16 <= maxEnd) {
    const hi = ((buf[off + 8] << 24) | (buf[off + 9] << 16) | (buf[off + 10] << 8) | buf[off + 11]) >>> 0;
    const lo = ((buf[off + 12] << 24) | (buf[off + 13] << 16) | (buf[off + 14] << 8) | buf[off + 15]) >>> 0;
    size = hi * 2 ** 32 + lo;
    headerLen = 16;
  } else if (size32 === 0) {
    size = maxEnd - off;
  }
  if (size < headerLen || off + size > maxEnd) return null;
  return {
    start: off, end: off + size, size, type, headerLen,
    payloadStart: off + headerLen, payloadEnd: off + size,
  };
}

function findChildBox(buf: Uint8Array, start: number, end: number, fourcc: string): BoxHeader | null {
  let off = start;
  while (off < end) {
    const box = parseBoxHeader(buf, off, end);
    if (!box) break;
    if (box.type === fourcc) return box;
    off = box.end;
  }
  return null;
}

function collectChildBoxes(buf: Uint8Array, start: number, end: number): BoxHeader[] {
  const list: BoxHeader[] = [];
  let off = start;
  while (off < end) {
    const box = parseBoxHeader(buf, off, end);
    if (!box) break;
    list.push(box);
    off = box.end;
  }
  return list;
}

function writeU32(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >>> 24) & 0xff;
  buf[off + 1] = (val >>> 16) & 0xff;
  buf[off + 2] = (val >>> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function makeBoxHeader(type: string, payloadLen: number): Uint8Array {
  const h = new Uint8Array(8);
  writeU32(h, 0, payloadLen + 8);
  for (let i = 0; i < 4; i++) h[4 + i] = type.charCodeAt(i);
  return h;
}

/** Объединяет video init и audio init в единый двухдорожечный fMP4 заголовок (moov). */
export function mergeFmp4Init(videoInit: Uint8Array, audioInit: Uint8Array): Uint8Array {
  const vMoov = findChildBox(videoInit, 0, videoInit.length, "moov");
  const aMoov = findChildBox(audioInit, 0, audioInit.length, "moov");
  if (!vMoov || !aMoov) return videoInit;

  const vFtyp = findChildBox(videoInit, 0, videoInit.length, "ftyp");
  const ftypBytes = vFtyp ? videoInit.subarray(vFtyp.start, vFtyp.end) : new Uint8Array(0);

  // 1. В audioInit moov ищем trak
  const aTrak = findChildBox(audioInit, aMoov.payloadStart, aMoov.payloadEnd, "trak");
  if (!aTrak) return videoInit;

  // Клонируем audio trak и меняем track_ID на 2
  const audioTrakBytes = new Uint8Array(audioInit.subarray(aTrak.start, aTrak.end));
  const aTkhd = findChildBox(audioTrakBytes, 8, audioTrakBytes.length, "tkhd");
  if (aTkhd) {
    const version = audioTrakBytes[aTkhd.payloadStart] ?? 0;
    const trackIdOff = version === 1 ? aTkhd.payloadStart + 20 : aTkhd.payloadStart + 12;
    if (trackIdOff + 4 <= aTkhd.payloadEnd) {
      writeU32(audioTrakBytes, trackIdOff, 2);
    }
  }

  // 2. В audioInit moov -> mvex ищем trex
  let audioTrexBytes: Uint8Array | null = null;
  const aMvex = findChildBox(audioInit, aMoov.payloadStart, aMoov.payloadEnd, "mvex");
  if (aMvex) {
    const aTrex = findChildBox(audioInit, aMvex.payloadStart, aMvex.payloadEnd, "trex");
    if (aTrex) {
      audioTrexBytes = new Uint8Array(audioInit.subarray(aTrex.start, aTrex.end));
      writeU32(audioTrexBytes, aTrex.payloadStart - aTrex.start + 4, 2);
    }
  }

  // 3. Разбираем videoInit moov
  const vMoovChildren = collectChildBoxes(videoInit, vMoov.payloadStart, vMoov.payloadEnd);
  const newMoovParts: Uint8Array[] = [];

  for (const child of vMoovChildren) {
    if (child.type === "mvex") {
      newMoovParts.push(audioTrakBytes);
      const vMvexPayload = videoInit.subarray(child.payloadStart, child.payloadEnd);
      const extraLen = audioTrexBytes ? audioTrexBytes.length : 0;
      const newMvexHeader = makeBoxHeader("mvex", vMvexPayload.length + extraLen);
      newMoovParts.push(newMvexHeader);
      newMoovParts.push(vMvexPayload);
      if (audioTrexBytes) newMoovParts.push(audioTrexBytes);
    } else {
      newMoovParts.push(videoInit.subarray(child.start, child.end));
    }
  }

  if (!vMoovChildren.some((c) => c.type === "mvex")) {
    newMoovParts.push(audioTrakBytes);
  }

  let newMoovPayloadLen = 0;
  for (const p of newMoovParts) newMoovPayloadLen += p.length;
  const newMoovHeader = makeBoxHeader("moov", newMoovPayloadLen);

  const merged = new Uint8Array(ftypBytes.length + 8 + newMoovPayloadLen);
  merged.set(ftypBytes, 0);
  merged.set(newMoovHeader, ftypBytes.length);
  let cur = ftypBytes.length + 8;
  for (const p of newMoovParts) {
    merged.set(p, cur);
    cur += p.length;
  }
  return merged;
}

/** Перезаписывает track_ID на 2 в moof -> traf -> tfhd медиа-сегмента аудио. */
export function rewriteAudioFragmentTrackId(segBytes: Uint8Array): Uint8Array {
  const moof = findChildBox(segBytes, 0, segBytes.length, "moof");
  if (!moof) return segBytes;
  const traf = findChildBox(segBytes, moof.payloadStart, moof.payloadEnd, "traf");
  if (!traf) return segBytes;
  const tfhd = findChildBox(segBytes, traf.payloadStart, traf.payloadEnd, "tfhd");
  if (!tfhd) return segBytes;

  const trackIdOff = tfhd.payloadStart + 4;
  if (trackIdOff + 4 <= tfhd.payloadEnd) {
    writeU32(segBytes, trackIdOff, 2);
  }
  return segBytes;
}

/** Скачивает все сегменты в один файл. Поддерживает раздельные видео и аудио потоки (YouTube/demuxed HLS),
 *  расшифровку AES-128, параллельную загрузку и объединение в монолитный MP4 со звуком. */
export async function downloadHlsSegments(
  segments: HlsSegmentInfo[],
  baseUrl: string,
  fetcher: typeof fetch = fetch,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
  concurrency = 5,
  audioSegments?: HlsSegmentInfo[],
  audioBaseUrl?: string
): Promise<Blob> {
  const keyCache = new Map<string, ArrayBuffer>();
  const emittedInits = new Set<string>();
  let sawFmp4 = false;

  // 1. Подготовка видео-сегментов
  let videoInitSeg: HlsSegmentInfo | null = null;
  const cleanVideoSegments: HlsSegmentInfo[] = [];
  for (const seg of segments) {
    const segUrl = normalizeUrl(seg.url, baseUrl) ?? seg.url;
    if (seg.isInit) {
      sawFmp4 = true;
      if (!videoInitSeg) videoInitSeg = { ...seg, url: segUrl };
      if (emittedInits.has(segUrl)) continue;
      emittedInits.add(segUrl);
    }
    cleanVideoSegments.push({ ...seg, url: segUrl });
  }

  // 2. Подготовка аудио-сегментов (если есть отдельная аудио-дорожка)
  let audioInitSeg: HlsSegmentInfo | null = null;
  const cleanAudioSegments: HlsSegmentInfo[] = [];
  if (audioSegments && audioSegments.length > 0) {
    const audioBase = audioBaseUrl || baseUrl;
    for (const seg of audioSegments) {
      const segUrl = normalizeUrl(seg.url, audioBase) ?? seg.url;
      if (seg.isInit) {
        if (!audioInitSeg) audioInitSeg = { ...seg, url: segUrl };
      }
      cleanAudioSegments.push({ ...seg, url: segUrl });
    }
  }

  const hasAudioTrack = cleanAudioSegments.length > 0;
  const allTasks: Array<{ seg: HlsSegmentInfo; isAudio: boolean; orderIdx: number }> = [];

  for (let i = 0; i < cleanVideoSegments.length; i++) {
    allTasks.push({ seg: cleanVideoSegments[i], isAudio: false, orderIdx: i });
  }
  for (let i = 0; i < cleanAudioSegments.length; i++) {
    allTasks.push({ seg: cleanAudioSegments[i], isAudio: true, orderIdx: i });
  }

  const totalSegments = allTasks.length;
  if (totalSegments === 0) throw new Error("нет сегментов для скачивания");

  manifestLog.info(`HLS download: ${cleanVideoSegments.length} видео + ${cleanAudioSegments.length} аудио сегментов, concurrency=${concurrency}`);

  const videoResults: (Uint8Array | null)[] = new Array(cleanVideoSegments.length).fill(null);
  const audioResults: (Uint8Array | null)[] = new Array(cleanAudioSegments.length).fill(null);
  let receivedBytes = 0;
  let nextIdx = 0;
  let activeWorkers = 0;

  const fetchKey = async (uri: string): Promise<ArrayBuffer> => {
    let raw = keyCache.get(uri);
    if (!raw) {
      const resp = await fetcher(uri, { signal });
      if (!resp.ok) throw new Error(`ключ AES-128 → HTTP ${resp.status}`);
      raw = await resp.arrayBuffer();
      keyCache.set(uri, raw);
    }
    return raw;
  };

  const fetchSegWithRetry = async (seg: HlsSegmentInfo): Promise<Uint8Array> => {
    let attempt = 0;
    for (;;) {
      try {
        const headers: Record<string, string> = {};
        if (seg.byteRange && seg.byteRange.start >= 0) {
          headers["Range"] = `bytes=${seg.byteRange.start}-${seg.byteRange.start + seg.byteRange.length - 1}`;
        }
        const resp = await fetcher(seg.url, { headers, signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        let bytes: Uint8Array = new Uint8Array(await resp.arrayBuffer());

        if (seg.key?.method === "AES-128") {
          if (!seg.key.uri) throw new Error("нет URI ключа");
          const rawKey = await fetchKey(seg.key.uri);
          const ivHex = seg.key.iv ? seg.key.iv.replace(/^0[xX]/, "") : undefined;
          const iv = ivHex ? hexToBytes(ivHex) : seqToIv(seg.seq);
          bytes = (await aesCbcDecryptNoPad(rawKey, iv, bytes)) as Uint8Array;
        }

        return bytes;
      } catch (e) {
        if (signal?.aborted) throw e;
        attempt++;
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  };

  // Рабочий пул параллельных загрузок
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    let rejected = false;

    const spawnWorker = () => {
      if (rejected) return;
      if (nextIdx >= totalSegments) {
        if (activeWorkers === 0) resolve();
        return;
      }

      const task = allTasks[nextIdx++];
      activeWorkers++;

      fetchSegWithRetry(task.seg)
        .then((bytes) => {
          if (task.isAudio) {
            audioResults[task.orderIdx] = bytes;
          } else {
            videoResults[task.orderIdx] = bytes;
          }
          receivedBytes += bytes.byteLength;
          onProgress?.(receivedBytes, totalSegments);
        })
        .catch((err) => {
          if (signal?.aborted || (err as Error).message === "Aborted") {
            rejected = true;
            return reject(new Error("Aborted"));
          }
          if (task.seg.isInit) {
            rejected = true;
            return reject(new Error(`init-сегмент недоступен: ${(err as Error).message}`));
          }
          manifestLog.warn(`HLS seg (${task.isAudio ? "audio" : "video"}[${task.orderIdx + 1}]): ${(err as Error).message} — пропущен`);
        })
        .finally(() => {
          activeWorkers--;
          if (!rejected) spawnWorker();
        });
    };

    const count = Math.min(concurrency, totalSegments);
    for (let i = 0; i < count; i++) {
      spawnWorker();
    }
  });

  // 3. Объединение: если есть и видео fMP4 init, и аудио fMP4 init — мультиплексируем
  const vInitBytes = videoResults.find((_, i) => cleanVideoSegments[i]?.isInit);
  const aInitBytes = audioResults.find((_, i) => cleanAudioSegments[i]?.isInit);

  if (sawFmp4 && vInitBytes && aInitBytes && hasAudioTrack) {
    manifestLog.info("HLS: мультиплексирование fMP4 дорожек (видео + аудио)...");
    const mergedInit = mergeFmp4Init(vInitBytes, aInitBytes);

    const blobParts: any[] = [mergedInit];
    const vMedia = videoResults.filter((_, i) => !cleanVideoSegments[i]?.isInit);
    const aMedia = audioResults.filter((_, i) => !cleanAudioSegments[i]?.isInit);
    const maxLen = Math.max(vMedia.length, aMedia.length);

    for (let i = 0; i < maxLen; i++) {
      const v = vMedia[i];
      if (v) blobParts.push(v);
      const a = aMedia[i];
      if (a) blobParts.push(rewriteAudioFragmentTrackId(a));
    }

    manifestLog.info(`HLS: готово! Мультиплексировано ${vMedia.length} видео и ${aMedia.length} аудио фрагментов`);
    return new Blob(blobParts, { type: "video/mp4" });
  }

  // Обычное сохранение монолитного потока (если нет отдельной аудиодорожки или MPEG-TS)
  const blobParts: Blob[] = [];
  const BATCH_BYTES = 16 * 1024 * 1024;
  let curBatch: BlobPart[] = [];
  let curBytes = 0;
  const mime = sawFmp4 ? "video/mp4" : "video/mp2t";

  const allOrderedResults = [...videoResults, ...audioResults];
  for (let i = 0; i < allOrderedResults.length; i++) {
    const p = allOrderedResults[i];
    allOrderedResults[i] = null;
    if (!p) continue;
    curBatch.push(p as unknown as BlobPart);
    curBytes += p.byteLength;
    if (curBytes >= BATCH_BYTES) {
      blobParts.push(new Blob(curBatch, { type: mime }));
      curBatch = [];
      curBytes = 0;
    }
  }
  if (curBatch.length > 0) {
    blobParts.push(new Blob(curBatch, { type: mime }));
  }

  if (blobParts.length === 0) throw new Error("ни одного сегмента не скачано");
  return new Blob(blobParts, { type: mime });
}
