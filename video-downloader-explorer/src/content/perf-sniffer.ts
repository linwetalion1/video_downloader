// Сниффинг performance.getEntriesByType('resource') на предмет видео-URL.
import { isHttpUrl, normalizePlaybackUrl } from "../shared/utils";
import type { RawVideoCandidate } from "../shared/types";

const VIDEO_EXTS = ["mp4", "webm", "ogv", "mov", "m4v", "mkv", "ts", "m3u8", "mpd", "flv", "avi"];
const MANIFEST_EXTS = new Set(["m3u8", "mpd"]);

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
      // googlevideo отдаёт видео без расширения в path (/videoplayback?...).
      const isVideoplayback = /googlevideo\.com\/(videoplayback|api\/manifest)/i.test(u);
      if (!ext || (!VIDEO_EXTS.includes(ext) && !isVideoplayback)) continue;
      const isManifestPath = /\/api\/manifest\/(hls_playlist|dash)\//i.test(u);
      // Манифесты маленькие — фильтр размера их резал; применяем только к медиа.
      if (!MANIFEST_EXTS.has(ext || "")) {
        const size = e.transferSize || e.encodedBodySize;
        if (size && size < 50_000 && !isVideoplayback && !isManifestPath) continue;
      }
      if (seen.has(u)) continue;
      seen.add(u);
      // Сегментные запросы плеера → полный файл (без range/rn/rbuf).
      const full = normalizePlaybackUrl(u);
      if (full !== u && seen.has(full)) continue;
      seen.add(full);
      const container: RawVideoCandidate["container"] =
        ext === "m3u8" || /hls_playlist/i.test(u) ? "hls"
          : ext === "mpd" || /api\/manifest\/dash/i.test(u) ? "dash"
            : ext === "webm" ? "webm"
              : ext === "ts" ? "ts"
                : ext === "mkv" ? "mkv"
                  : ext === "flv" ? "flv" : "mp4";
      out.push({
        videoUrl: full, sourceType: "perf-resource",
        container,
        mimeType: mimeByExt(ext || (/hls_playlist/i.test(u) ? "m3u8" : /dash/i.test(u) ? "mpd" : "mp4")),
        isManifest: ext === "m3u8" || ext === "mpd" || isManifestPath,
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
