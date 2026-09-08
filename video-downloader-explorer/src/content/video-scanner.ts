// Поиск <video>, <source>, <track> с глубоким обходом shadow DOM.
// Возвращает кандидатов с sourceType, метаданными из DOM.
import { isHttpUrl, isBlobUrl, isDataUrl, normalizeUrl } from "../shared/utils";
import type { Container, RawVideoCandidate } from "../shared/types";

const MIMES_VIDEO = /^video\//i;

export interface FindResult {
  candidates: RawVideoCandidate[];
  videoElements: number;
  sourceElements: number;
  shadowRootsOpened: number;
}

export interface FindOptions {
  baseUrl: string;
  deepShadow: boolean;
  autoScroll: boolean;
}

export function findVideoElements(doc: Document, opts: FindOptions): FindResult {
  const candidates: RawVideoCandidate[] = [];
  let videoElements = 0, sourceElements = 0, shadowRootsOpened = 0;

  const allEls: Element[] = [];
  collectAll(doc.documentElement, allEls, () => { shadowRootsOpened++; }, opts.deepShadow);
  for (const el of allEls) {
    if (el.tagName === "VIDEO") {
      videoElements++;
      const cands = collectFromElement(el, opts.baseUrl, []);
      for (const c of cands) candidates.push(c);
    } else if (el.tagName === "SOURCE") {
      const parent = el.parentElement;
      if (parent?.tagName === "VIDEO") {
        sourceElements++;
        const cands = collectFromElement(parent, opts.baseUrl, []);
        for (const c of cands) candidates.push(c);
      }
    } else {
      // Background-video на <div>: проверяем background-image / data-src
      const bg = getComputedStyle(el as HTMLElement).backgroundImage;
      if (bg && /url\((['"]?)(https?:|\/\/)/.test(bg)) {
        const m = /url\((['"]?)([^'")]+)\1\)/.exec(bg);
        if (m) {
          const u = normalizeUrl(m[2], opts.baseUrl);
          if (u && isHttpUrl(u) && MIMES_VIDEO.test(getMimeForUrl(u))) {
            candidates.push({
              videoUrl: u, sourceType: "video",
              container: getContainerForUrl(u),
              mimeType: getMimeForUrl(u),
            });
          }
        }
      }
    }
  }

  return { candidates, videoElements, sourceElements, shadowRootsOpened };
}

function collectAll(root: Element, out: Element[], onShadow: () => void, deepShadow: boolean): void {
  out.push(root);
  // Shadow root
  if ((root as any).shadowRoot && deepShadow) {
    onShadow();
    collectAll((root as any).shadowRoot, out, onShadow, deepShadow);
  }
  for (const child of Array.from(root.children)) {
    collectAll(child, out, onShadow, deepShadow);
  }
}

/** Плавная прокрутка страницы для ленивой загрузки (Instagram/TikTok-ленты).
 *  Возвращает количество сделанных шагов. Останавливается на дне документа
 *  или по лимиту шагов; в конце возвращается наверх. */
export async function autoScrollPage(maxSteps = 12, stepDelayMs = 600): Promise<number> {
  let steps = 0;
  try {
    const docEl = document.documentElement;
    const prevY = window.scrollY;
    for (; steps < maxSteps; steps++) {
      if (document.hidden) break;
      window.scrollBy({ top: Math.round(window.innerHeight * 0.9), behavior: "instant" as ScrollBehavior });
      await new Promise((r) => setTimeout(r, stepDelayMs));
      const y = window.scrollY;
      const bottomReached = y + window.innerHeight >= docEl.scrollHeight - 4;
      if (y === prevY && bottomReached) break;
      if (bottomReached) break;
    }
    window.scrollTo({ top: prevY, behavior: "instant" as ScrollBehavior });
  } catch { /* ignore */ }
  return steps;
}

export function collectFromElement(el: Element, baseUrl: string, seen: string[]): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  if (el.tagName !== "VIDEO") return out;
  const v = el as HTMLVideoElement;
  const sources: { url: string; type?: string; isManifest: boolean }[] = [];

  // <source> children
  for (const src of Array.from(v.querySelectorAll("source"))) {
    const u = src.getAttribute("src");
    if (u) {
      const abs = normalizeUrl(u, baseUrl);
      if (abs) {
        const t = src.getAttribute("type") || "";
        sources.push({ url: abs, type: t, isManifest: /mpegurl|dash\+xml/i.test(t) || /\.m3u8(\?|$)/i.test(abs) || /\.mpd(\?|$)/i.test(abs) });
      }
    }
  }
  // <video src=…>
  const directSrc = v.getAttribute("src");
  if (directSrc) {
    const abs = normalizeUrl(directSrc, baseUrl);
    if (abs) {
      sources.push({
        url: abs,
        type: v.getAttribute("type") || "",
        isManifest: /\.m3u8(\?|$)/i.test(abs) || /\.mpd(\?|$)/i.test(abs),
      });
    }
  }
  // currentSrc после загрузки
  if (v.currentSrc && v.currentSrc !== directSrc) {
    const abs = normalizeUrl(v.currentSrc, baseUrl);
    if (abs && !sources.some((s) => s.url === abs)) {
      sources.push({ url: abs, type: "", isManifest: /\.m3u8(\?|$)/i.test(abs) || /\.mpd(\?|$)/i.test(abs) });
    }
  }
  // <track>
  // (опционально — отдельный кандидат для субтитров)

  for (const s of sources) {
    if (seen.includes(s.url)) continue;
    seen.push(s.url);
    const isBlob = isBlobUrl(s.url) || isDataUrl(s.url);
    const container = s.isManifest
      ? (s.url.includes(".mpd") ? "dash" : "hls")
      : getContainerForUrl(s.url);
    const c: RawVideoCandidate = {
      videoUrl: s.url,
      sourceType: s.isManifest ? "hls-js" : (s.url === v.currentSrc ? "currentSrc" : (s.url === directSrc ? "video" : "source")),
      container,
      mimeType: s.type || getMimeForUrl(s.url),
      isManifest: s.isManifest,
      width: v.videoWidth || undefined,
      height: v.videoHeight || undefined,
      durationSec: (v.duration && isFinite(v.duration) && v.duration !== 1) ? v.duration : undefined,
      thumbnailUrl: v.poster || undefined,
      title: v.title || v.getAttribute("aria-label") || undefined,
    };
    if (c.sourceType === "currentSrc" && container !== "unknown") c.sourceType = "source";
    if (isBlob) c.sourceType = "blob";
    if (isDataUrl(s.url)) c.sourceType = "data";
    out.push(c);
  }
  return out;
}

function getMimeForUrl(u: string): string | undefined {
  const ext = extOf(u);
  if (!ext) return undefined;
  return MIME_BY_EXT[ext];
}

function getContainerForUrl(u: string): Container {
  const ext = extOf(u);
  if (!ext) return "unknown";
  if (ext === "m3u8") return "hls";
  if (ext === "mpd") return "dash";
  if (["mp4", "m4v", "mov", "3gp"].includes(ext)) return "mp4";
  if (["webm"].includes(ext)) return "webm";
  if (["mkv"].includes(ext)) return "mkv";
  if (["ts", "m2ts", "mts"].includes(ext)) return "ts";
  if (ext === "flv") return "flv";
  if (ext === "avi") return "avi";
  if (ext === "ogv") return "ogg";
  return "unknown";
}

function extOf(u: string): string | undefined {
  try {
    const p = new URL(u, "http://_").pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(p);
    return m ? m[1].toLowerCase() : undefined;
  } catch { return undefined; }
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
  webm: "video/webm", ogv: "video/ogg", mkv: "video/x-matroska",
  ts: "video/mp2t", flv: "video/x-flv", avi: "video/x-msvideo",
  m3u8: "application/x-mpegurl", mpd: "application/dash+xml",
};
