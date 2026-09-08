// DASH-парсер (ISO/IEC 23009-1). Извлекает Period/AdaptationSet/Representation
// и ПОЛНЫЙ список сегментов каждого представления:
//   - SegmentTemplate с $Number$ (startNumber/duration) и $Time$;
//   - SegmentTimeline (<S t= d= r=>);
//   - SegmentBase/BaseURL (единый файл — прямая ссылка);
//   - самозакрывающиеся <Representation/> и <AdaptationSet/>.
// Regex-парсер: в service worker нет DOMParser.
import { bytesToText, normalizeUrl, uid } from "../shared/utils";
import type { HlsVariant, ManifestSegment } from "../shared/types";
import { manifestLog } from "../shared/logger";

export interface DashParseResult {
  ok: boolean;
  variants: HlsVariant[];
  isDRM: boolean;
  isLive: boolean;
  durationSec?: number;
  baseUrls: string[];
  error?: string;
}

const MAX_SEGMENTS_PER_REP = 20_000;

export async function fetchAndParseDash(
  url: string,
  fetcher: typeof fetch = fetch
): Promise<DashParseResult> {
  manifestLog.info(`DASH: GET ${url}`);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetcher(url, { signal: controller.signal });
    if (!resp.ok) {
      manifestLog.error(`DASH: ${url} → HTTP ${resp.status}`);
      return { ok: false, variants: [], isDRM: false, isLive: false, baseUrls: [], error: `HTTP ${resp.status}` };
    }
    const buf = await resp.arrayBuffer();
    const text = bytesToText(new Uint8Array(buf));
    return parseDash(text, url);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    manifestLog.error(`DASH: ${url} → ошибка: ${msg}`);
    return { ok: false, variants: [], isDRM: false, isLive: false, baseUrls: [], error: msg };
  } finally {
    clearTimeout(t);
  }
}

/** Атрибут вида name="value" или name='value'. */
function attrOf(s: string, name: string): string {
  const m = new RegExp(name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i").exec(s);
  return m ? m[1] : "";
}

/**
 * Regex-парсер MPD. Структура предсказуема: Period → AdaptationSet →
 * Representation → BaseURL/SegmentTemplate(+SegmentTimeline).
 */
export function parseDash(xml: string, baseUrl: string): DashParseResult {
  if (!xml || !/<MPD[\s>]/i.test(xml)) {
    return { ok: false, variants: [], isDRM: false, isLive: false, baseUrls: [], error: "No <MPD> root" };
  }

  const mpdTag = /<MPD([^>]*)>/i.exec(xml)?.[1] ?? "";
  const isLive = /type\s*=\s*["']dynamic["']/i.test(mpdTag);
  const durAttr = attrOf(mpdTag, "mediaPresentationDuration");
  const mpdDurSec = durAttr ? parseDuration(durAttr) : 0;

  // DRM detection (ContentProtection с известными schemeIdUri).
  const cpTags = xml.match(/<ContentProtection[^>]*>/gi) ?? [];
  const isDRM = cpTags.some((t) =>
    /edef8ba9|9a04f079|94ce86fb|widevine|playready|fairplay|clearkey/i.test(t)
  );

  // BaseURL уровня MPD (fallback).
  const mpdScope = /<MPD[^>]*>([\s\S]*?)<Period/i.exec(xml)?.[1] ?? "";
  const mpdBase = /<BaseURL>([^<]+)<\/BaseURL>/i.exec(mpdScope)?.[1]?.trim();
  const baseUrls: string[] = mpdBase ? [normalizeUrl(mpdBase, baseUrl) ?? mpdBase] : [baseUrl];

  const variants: HlsVariant[] = [];

  const asRe = /<AdaptationSet\b([^>]*?)(?:\/>|>([\s\S]*?)<\/AdaptationSet>)/gi;
  let asM: RegExpExecArray | null;
  while ((asM = asRe.exec(xml)) !== null) {
    const asAttrs = asM[1];
    const asBody = asM[2] ?? "";
    const asMime = attrOf(asAttrs, "mimeType");
    const contentType = attrOf(asAttrs, "contentType")
      || (asMime.startsWith("video") ? "video" : asMime.startsWith("audio") ? "audio" : "");
    const asCodecs = attrOf(asAttrs, "codecs");
    const asTplOpenM = /<SegmentTemplate([^>]*)>/i.exec(asBody);
    const asTplAttrs = asTplOpenM?.[1] ?? "";
    const asTplBody = /<SegmentTemplate[^>]*>([\s\S]*?)<\/SegmentTemplate>/i.exec(asBody)?.[1] ?? "";

    const repRe = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/gi;
    let repM: RegExpExecArray | null;
    while ((repM = repRe.exec(asBody)) !== null) {
      const ra = repM[1];
      const rb = repM[2] ?? "";
      const id = attrOf(ra, "id") || uid("r");
      const bandwidth = parseInt(attrOf(ra, "bandwidth") || "0", 10) || 0;
      const w = parseInt(attrOf(ra, "width") || "0", 10) || undefined;
      const h = parseInt(attrOf(ra, "height") || "0", 10) || undefined;
      const fr = parseFloat(attrOf(ra, "frameRate") || "") || undefined;
      const codecs = attrOf(ra, "codecs") || asCodecs || undefined;
      const repIsAudioOnly = contentType === "audio" || (asMime.startsWith("audio") && !contentType);

      // BaseURL репрезентации.
      let repBase = "";
      const repBaseM = /<BaseURL(?:\s[^>]*)?>([^<]+)<\/BaseURL>/i.exec(rb);
      if (repBaseM?.[1]) repBase = repBaseM[1].trim();

      // SegmentTemplate: репрезентация переопределяет уровень AdaptationSet.
      const repTplFullM = /<SegmentTemplate([^>]*)>([\s\S]*?)<\/SegmentTemplate>/i.exec(rb);
      const repTplOpenM = /<SegmentTemplate([^>]*)>/i.exec(rb);
      const tplAttrs = repTplOpenM?.[1] ?? asTplAttrs;
      const tplBody = repTplFullM?.[2] ?? asTplBody;
      const init = attrOf(tplAttrs, "initialization");
      const media = attrOf(tplAttrs, "media");
      const timescale = parseFloat(attrOf(tplAttrs, "timescale") || "") || 1;
      const segDur = parseFloat(attrOf(tplAttrs, "duration") || "") || 0;
      const startNumber = parseInt(attrOf(tplAttrs, "startNumber") || "", 10);

      // Период: duration для расчёта количества сегментов.
      const periodStartIdx = xml.lastIndexOf("<Period", asM.index);
      const periodTag = periodStartIdx >= 0 ? /<Period([^>]*)>/i.exec(xml.slice(periodStartIdx))?.[1] ?? "" : "";
      const periodDurSec = attrOf(periodTag, "duration") ? parseDuration(attrOf(periodTag, "duration")) : mpdDurSec;

      const resolve = (raw: string): string | undefined => {
        const withBase = repBase ? joinUrl(raw, repBase) : raw;
        return normalizeUrl(withBase, baseUrls[0]) ?? withBase;
      };

      let segments: ManifestSegment[] = [];

      if (init && media && (segDur > 0 || /<SegmentTimeline/i.test(tplBody))) {
        segments.push({ url: resolve(substituteTemplate(init, tplVars(id, bandwidth)))!, isInit: true });
        const timeline = /<SegmentTimeline([\s\S]*?)<\/SegmentTimeline>/i.exec(tplBody)?.[1];
        if (timeline !== undefined) {
          segments.push(...enumerateTimeline(timeline, media, timescale, id, bandwidth, resolve));
        } else if (segDur > 0) {
          const num = isNaN(startNumber) ? 1 : startNumber;
          const total = periodDurSec > 0 ? Math.ceil(periodDurSec / (segDur / timescale)) : 1;
          for (let n = 0; n < Math.min(total, MAX_SEGMENTS_PER_REP); n++) {
            segments.push({
              url: resolve(substituteTemplate(media, tplVars(id, bandwidth, num + n, (num + n - 1) * (segDur / timescale))))!,
              isInit: false,
            });
          }
        }
      }

      let url: string | undefined;
      if (repBase) {
        url = resolve("$")!;
      } else if (init) {
        url = resolve(substituteTemplate(init, tplVars(id, bandwidth)))!;
      } else if (media) {
        url = resolve(substituteTemplate(media, { ...tplVars(id, bandwidth), Number: "1", Time: "0" }))!;
      }
      if (!url) url = baseUrls[0];

      variants.push({
        id: uid("v"),
        url,
        bandwidth,
        width: w,
        height: h,
        codecs,
        frameRate: fr,
        isAudioOnly: repIsAudioOnly,
        resolutionLabel: (w && h) ? `${w}x${h}` : (repIsAudioOnly ? "Audio only" : `${Math.round(bandwidth / 1000)}kbps`),
        segments: segments.length ? segments : undefined,
      });
    }
  }

  manifestLog.info(`DASH: ${baseUrl} → ${variants.length} Representation'ов, DRM=${isDRM}, VOD=${!isLive}, ${mpdDurSec ? Math.round(mpdDurSec) + 's' : '?'}`);

  return { ok: true, variants, isDRM, isLive, durationSec: mpdDurSec || undefined, baseUrls };
}

function tplVars(repId: string, bandwidth: number, number?: number, time?: number): Record<string, string> {
  const v: Record<string, string> = { RepresentationID: repId, Bandwidth: String(bandwidth) };
  if (number !== undefined) v.Number = String(number);
  if (time !== undefined) v.Time = String(Math.round(time));
  return v;
}

function joinUrl(raw: string, basePart: string): string {
  if (/^https?:/i.test(raw)) return raw;
  try { return new URL(raw, basePart.endsWith("/") ? basePart : basePart.replace(/[^/]*$/, "/")).href; } catch { return raw; }
}

function substituteTemplate(s: string, vars: Record<string, string>): string {
  return s.replace(/\$([A-Za-z]+)(?:%0(\d+)d)?\$/g, (_, key: string, pad?: string) => {
    const v = vars[key];
    if (v === undefined) return key === "Number" || key === "Time" ? "" : "$" + key + "$";
    if (pad) return v.padStart(parseInt(pad, 10), "0");
    return v;
  });
}

/** Перечисление <SegmentTimeline>: S@t (старт), d (длительность), r (повторы). */
function enumerateTimeline(
  timelineXml: string,
  mediaTpl: string,
  timescale: number,
  repId: string,
  bandwidth: number,
  resolve: (raw: string) => string | undefined
): ManifestSegment[] {
  const out: ManifestSegment[] = [];
  const sRe = /<S\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  let t = 0;
  while ((m = sRe.exec(timelineXml)) !== null && out.length < MAX_SEGMENTS_PER_REP) {
    const attrs = m[1];
    if (/t\s*=/.test(attrs)) t = parseFloat(attrOf(attrs, "t")) || 0;
    const d = parseFloat(attrOf(attrs, "d")) || 0;
    if (!d) continue;
    let r = parseInt(attrOf(attrs, "r") || "", 10);
    if (isNaN(r) || r < 0) r = 0;
    for (let k = 0; k <= r && out.length < MAX_SEGMENTS_PER_REP; k++) {
      const url = resolve(substituteTemplate(mediaTpl, tplVars(repId, bandwidth, out.length + 1, t)));
      if (url) out.push({ url, isInit: false });
      t += d;
    }
  }
  return out;
}

/** ISO 8601 duration (PT1H2M3.5S) → секунды. */
function parseDuration(s: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(s);
  if (!m) return 0;
  const h = parseFloat(m[1] || "0");
  const min = parseFloat(m[2] || "0");
  const sec = parseFloat(m[3] || "0");
  return h * 3600 + min * 60 + sec;
}
