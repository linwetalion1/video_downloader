// DASH-парсер (ISO/IEC 23009-1). Извлекает Period/AdaptationSet/Representation.
// Поддерживает SegmentTemplate (Number$, Time$, Bandwidth$, RepresentationID$).
import { bytesToText, normalizeUrl, uid } from "../shared/utils";
import type { HlsVariant } from "../shared/types";
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
 * Regex-парсер MPD. ВАЖНО: в service worker НЕТ DOMParser, поэтому
 * используем регулярки (структура MPD предсказуема: Period → AdaptationSet
 * → Representation → BaseURL/SegmentTemplate).
 */
export function parseDash(xml: string, baseUrl: string): DashParseResult {
  if (!xml || !/<MPD[\s>]/i.test(xml)) {
    return { ok: false, variants: [], isDRM: false, isLive: false, baseUrls: [], error: "No <MPD> root" };
  }

  const mpdTag = /<MPD([^>]*)>/i.exec(xml)?.[1] ?? "";
  const isLive = /type\s*=\s*["']dynamic["']/i.test(mpdTag);
  const durAttr = attrOf(mpdTag, "mediaPresentationDuration");
  const durSec = durAttr ? parseDuration(durAttr) : undefined;

  // DRM detection (ContentProtection с известными schemeIdUri).
  const cpTags = xml.match(/<ContentProtection[^>]*>/gi) ?? [];
  const isDRM = cpTags.some((t) =>
    /edef8ba9|9a04f079|94ce86fb|widevine|playready|fairplay|clearkey/i.test(t)
  );

  // BaseURL уровня MPD (fallback).
  const mpdBase = /<MPD[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/i.exec(xml)?.[1]?.trim();
  const baseUrls: string[] = mpdBase ? [normalizeUrl(mpdBase, baseUrl) ?? mpdBase] : [baseUrl];

  const variants: HlsVariant[] = [];

  // Period → AdaptationSet → Representation.
  const asRe = /<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi;
  let asM: RegExpExecArray | null;
  while ((asM = asRe.exec(xml)) !== null) {
    const asAttrs = asM[1];
    const asBody = asM[2];
    const asMime = attrOf(asAttrs, "mimeType");
    const contentType = attrOf(asAttrs, "contentType")
      || (asMime.startsWith("video") ? "video" : asMime.startsWith("audio") ? "audio" : "");
    const asCodecs = attrOf(asAttrs, "codecs");
    const asTplM = /<SegmentTemplate([^>]*)>/i.exec(asBody);
    const asTplAttrs = asTplM?.[1] ?? "";

    const repRe = /<Representation([^>]*)>([\s\S]*?)<\/Representation>/gi;
    let repM: RegExpExecArray | null;
    while ((repM = repRe.exec(asBody)) !== null) {
      const ra = repM[1];
      const rb = repM[2];
      const id = attrOf(ra, "id") || uid("r");
      const bandwidth = parseInt(attrOf(ra, "bandwidth") || "0", 10) || 0;
      const w = parseInt(attrOf(ra, "width") || "0", 10) || undefined;
      const h = parseInt(attrOf(ra, "height") || "0", 10) || undefined;
      const fr = parseFloat(attrOf(ra, "frameRate") || "") || undefined;
      const codecs = attrOf(ra, "codecs") || asCodecs || undefined;

      let url: string | undefined;
      const repBaseM = /<BaseURL>([^<]+)<\/BaseURL>/i.exec(rb);
      if (repBaseM?.[1]) {
        const raw = repBaseM[1].trim();
        url = normalizeUrl(raw, baseUrl) ?? raw;
      } else {
        const repTplM = /<SegmentTemplate([^>]*)>/i.exec(rb);
        const tplAttrs = repTplM?.[1] ?? asTplAttrs;
        const init = attrOf(tplAttrs, "initialization");
        const media = attrOf(tplAttrs, "media");
        if (init) {
          const initUrl = substituteTemplate(init, { RepresentationID: id, Bandwidth: String(bandwidth) });
          url = normalizeUrl(initUrl, baseUrl) ?? initUrl;
        } else if (media) {
          const mediaUrl = substituteTemplate(media, {
            RepresentationID: id, Bandwidth: String(bandwidth), Number: "1", Time: "0",
          });
          url = normalizeUrl(mediaUrl, baseUrl) ?? mediaUrl;
        }
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
        isAudioOnly: contentType === "audio",
        resolutionLabel: (w && h) ? `${w}x${h}` : (contentType === "audio" ? "Audio only" : `${Math.round(bandwidth / 1000)}kbps`),
      });
    }
  }

  manifestLog.info(`DASH: ${baseUrl} → ${variants.length} Representation'ов, DRM=${isDRM}, VOD=${!isLive}, ${durSec ? Math.round(durSec) + 's' : '?'}`);

  return { ok: true, variants, isDRM, isLive, durationSec: durSec, baseUrls };
}

function substituteTemplate(s: string, vars: Record<string, string>): string {
  return s.replace(/\$([A-Za-z]+)(?:%0(\d+)d)?\$/g, (_, key: string, pad?: string) => {
    const v = vars[key];
    if (v === undefined) return "";
    if (pad) return v.padStart(parseInt(pad, 10), "0");
    return v;
  });
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
