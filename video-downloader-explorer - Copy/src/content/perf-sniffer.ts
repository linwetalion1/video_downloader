// Сниффинг performance.getEntriesByType('resource') на предмет видео-URL.
import { isHttpUrl, normalizeUrl } from "../shared/utils";
import type { RawVideoCandidate } from "../shared/types";

const VIDEO_EXTS = ["mp4", "webm", "ogv", "mov", "m4v", "mkv", "ts", "m3u8", "mpd", "flv", "avi"];

export function sniffPerformanceResources(_pageUrl: string): { candidates: RawVideoCandidate[]; scanned: number } {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  try {
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const e of entries) {
      scanned++;
      const u = e.name;
      if (!isHttpUrl(u)) continue;
      const ext = extOf(u);
      if (!ext || !VIDEO_EXTS.includes(ext)) continue;
      // Skip очень маленькие (миниатюры, аватарки).
      const size = e.transferSize || e.encodedBodySize;
      if (size && size < 50_000) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      out.push({
        videoUrl: u, sourceType: "perf-resource",
        container: ext === "m3u8" ? "hls" : ext === "mpd" ? "dash" : (ext === "webm" ? "webm" : ext === "ts" ? "ts" : ext === "mkv" ? "mkv" : ext === "flv" ? "flv" : "mp4"),
        mimeType: mimeByExt(ext),
        isManifest: ext === "m3u8" || ext === "mpd",
      });
    }
  } catch { /* */ }
  return { candidates: out, scanned };
}

function extOf(u: string): string | undefined {
  try {
    const p = new URL(u, "http://_").pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(p);
    return m ? m[1].toLowerCase() : undefined;
  } catch { return undefined; }
}

function mimeByExt(ext: string): string {
  const map: Record<string, string> = {
    mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime",
    mkv: "video/x-matroska", ts: "video/mp2t", flv: "video/x-flv", avi: "video/x-msvideo",
    m3u8: "application/x-mpegurl", mpd: "application/dash+xml",
  };
  return map[ext] || "application/octet-stream";
}
