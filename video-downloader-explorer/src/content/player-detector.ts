// Детекторы плеерных фреймворков (HLS.js, dash.js, Video.js, JWPlayer, Plyr, Clappr, Shaka,
// Brightcove, Vidyard, Kaltura, Wistia, MediaElement).
// БЕЗОПАСНО: только чтение window.* / глобалов. Никакого eval, никакого исполнения кода страниц.
import { isHttpUrl, normalizeUrl } from "../shared/utils";
import type { RawVideoCandidate } from "../shared/types";

declare const window: any;

export function detectPlayers(_baseUrl: string): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const w = window;
  if (!w) return out;

  // HLS.js: window.Hls.isSupported(); инстанс на window.hls или на элементе.
  try {
    if (w.Hls && w.Hls.isSupported && w.Hls.isSupported()) {
      // Найти все инстансы — обычно один на странице.
      const players: any[] = [];
      if (w.hls) players.push(w.hls);
      // Попробуем найти инстансы по медиа-элементам.
      document.querySelectorAll("video").forEach((v) => {
        const hls = (v as any)._hls || (v as any).hls;
        if (hls) players.push(hls);
      });
      const seen = new Set<string>();
      for (const p of players) {
        const url: string | undefined = p?.url || p?.manifest?.url || p?._url;
        if (url && !seen.has(url)) {
          seen.add(url);
          out.push({
            videoUrl: url, sourceType: "hls-js",
            container: "hls", mimeType: "application/x-mpegurl",
            isManifest: true,
            title: document.title,
          });
        }
        // Levels
        const levels: any[] = p?.levels || [];
        for (const lvl of levels) {
          if (lvl?.url && !seen.has(lvl.url)) {
            seen.add(lvl.url);
            out.push({
              videoUrl: lvl.url, sourceType: "hls-js",
              container: "hls", mimeType: "application/x-mpegurl",
              isManifest: true, width: lvl.width, height: lvl.height,
              bitrateKbps: Math.round((lvl.bitrate || 0) / 1000),
            });
          }
        }
      }
    }
  } catch { /* ignore */ }

  // dash.js
  try {
    if (w.dashjs) {
      const seen = new Set<string>();
      document.querySelectorAll("video").forEach((v) => {
        const player = w.dashjs?.MediaPlayer?.isReady?.() ? null : null;
        // dashjs обычно хранит инстанс на элементе: video.dashPlayer или player.dash
        const dp = (v as any).dashPlayer || (v as any).player || (v as any)._dash;
        if (dp?.getSource) {
          const url = dp.getSource();
          if (url && !seen.has(url)) {
            seen.add(url);
            out.push({ videoUrl: url, sourceType: "dash-js", container: "dash", mimeType: "application/dash+xml", isManifest: true });
          }
        }
      });
      // Через глобал
      if (w.dashjs?.players) {
        for (const p of Object.values(w.dashjs.players) as any[]) {
          const url = p?.getSource?.();
          if (url && !seen.has(url)) {
            seen.add(url);
            out.push({ videoUrl: url, sourceType: "dash-js", container: "dash", mimeType: "application/dash+xml", isManifest: true });
          }
        }
      }
    }
  } catch { /* ignore */ }

  // Video.js
  try {
    if (w.videojs) {
      const players = (typeof w.videojs.getAllPlayers === "function") ? w.videojs.getAllPlayers() : [];
      const seen = new Set<string>();
      for (const p of players as any[]) {
        try {
          const src = p.currentSrc?.() || p.src?.();
          if (src && isHttpUrl(src) && !seen.has(src)) {
            seen.add(src);
            out.push({
              videoUrl: src, sourceType: "video-js",
              container: /\.m3u8/i.test(src) ? "hls" : /\.mpd/i.test(src) ? "dash" : "mp4",
              mimeType: p.mimeType?.() || undefined,
              isManifest: /\.m3u8|\.mpd/i.test(src),
              width: p.videoWidth?.() || undefined,
              height: p.videoHeight?.() || undefined,
            });
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // JWPlayer
  try {
    if (w.jwplayer) {
      const seen = new Set<string>();
      try {
        const inst = w.jwplayer();
        const cfg = inst?.getConfig?.();
        const playlist = cfg?.playlist || [];
        for (const item of playlist) {
          const sources: any[] = item.sources || [];
          for (const s of sources) {
            if (s.file && !seen.has(s.file)) {
              seen.add(s.file);
              out.push({
                videoUrl: s.file, sourceType: "jwplayer",
                container: /\.m3u8/i.test(s.file) ? "hls" : /\.mpd/i.test(s.file) ? "dash" : (s.type?.includes("mp4") ? "mp4" : "mp4"),
                mimeType: s.type || undefined,
                isManifest: /\.m3u8|\.mpd/i.test(s.file),
                title: item.title,
                thumbnailUrl: item.image,
              });
            }
          }
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  // Plyr
  try {
    if (w.Plyr && typeof w.Plyr.getInstances === "function") {
      const seen = new Set<string>();
      for (const p of w.Plyr.getInstances() as any[]) {
        const src = p?.source;
        const sources: any[] = Array.isArray(src) ? src : [src].filter(Boolean);
        for (const s of sources) {
          const u: string | undefined = typeof s === "string" ? s : s?.src;
          if (u && !seen.has(u)) {
            seen.add(u);
            out.push({
              videoUrl: u, sourceType: "plyr",
              container: /\.m3u8/i.test(u) ? "hls" : /\.mpd/i.test(u) ? "dash" : "mp4",
              isManifest: /\.m3u8|\.mpd/i.test(u),
            });
          }
        }
      }
    }
  } catch { /* ignore */ }

  // Clappr
  try {
    if (w.Clappr?.Player?.getInstances) {
      const seen = new Set<string>();
      for (const p of w.Clappr.Player.getInstances() as any[]) {
        const u = p?.options?.source;
        if (u && !seen.has(u)) {
          seen.add(u);
          out.push({
            videoUrl: u, sourceType: "clappr",
            container: /\.m3u8/i.test(u) ? "hls" : /\.mpd/i.test(u) ? "dash" : "mp4",
            isManifest: /\.m3u8|\.mpd/i.test(u),
          });
        }
      }
    }
  } catch { /* ignore */ }

  // Shaka Player
  try {
    if (w.shaka?.Player) {
      const seen = new Set<string>();
      document.querySelectorAll("video").forEach((v) => {
        const inst = (v as any).player || (v as any)._shaka;
        const u = inst?.config?.streaming?.manifestUri;
        if (u && !seen.has(u)) {
          seen.add(u);
          out.push({ videoUrl: u, sourceType: "shaka", container: "dash", mimeType: "application/dash+xml", isManifest: true });
        }
      });
    }
  } catch { /* ignore */ }

  // Vidyard
  try {
    if (w.VYODA || w.vidyardEmbed) {
      const v = w.VYODA || w.vidyardEmbed;
      const seen = new Set<string>();
      if (v?.videoData?.sources) {
        for (const s of v.videoData.sources) {
          const u = s.url || s.src;
          if (u && !seen.has(u)) {
            seen.add(u);
            out.push({ videoUrl: u, sourceType: "vidyard", container: "mp4", mimeType: "video/mp4" });
          }
        }
      }
    }
  } catch { /* ignore */ }

  // Brightcove
  try {
    if (w.videojs && w.bc) {
      // Brightcove использует videojs; ищем через атрибут data-video-id или window.bc()
      const seen = new Set<string>();
      document.querySelectorAll("video[data-video-id]").forEach((v) => {
        const vid = (v as any).getAttribute("data-video-id");
        if (vid && w.bc?.videos?.[vid]?.sources) {
          for (const s of w.bc.videos[vid].sources) {
            const u = s.src || s.url;
            if (u && !seen.has(u)) {
              seen.add(u);
              out.push({ videoUrl: u, sourceType: "brightcove", container: "mp4", mimeType: "video/mp4" });
            }
          }
        }
      });
    }
  } catch { /* ignore */ }

  // Kaltura
  try {
    if (w.kWidget || w.KWidget) {
      const seen = new Set<string>();
      document.querySelectorAll("[data-kaltura-player], .kaltura-player").forEach((el) => {
        const player = (el as any).kPlayer || (el as any).kWidget;
        const src = player?.config?.source || player?.evaluate?.("{mediaProxy.entryMrss}");
        if (typeof src === "string" && !seen.has(src)) {
          seen.add(src);
          out.push({ videoUrl: src, sourceType: "kaltura", container: "mp4", mimeType: "video/mp4" });
        }
      });
    }
  } catch { /* ignore */ }

  // Wistia
  try {
    if (w.Wistia?.api) {
      const seen = new Set<string>();
      for (const m of Object.values(w.Wistia.api.all?.() || w.Wistia.api._medias || {}) as any[]) {
        const assets: any[] = m?.assets || [];
        for (const a of assets) {
          const u = a.url || a.display_url;
          if (u && !seen.has(u)) {
            seen.add(u);
            out.push({ videoUrl: u, sourceType: "wistia", container: "mp4", mimeType: a.mime_type || "video/mp4" });
          }
        }
      }
    }
  } catch { /* ignore */ }

  // MediaElement.js
  try {
    if (w.mejs?.players) {
      const seen = new Set<string>();
      for (const p of Object.values(w.mejs.players) as any[]) {
        const u = p?.media?.currentSrc || p?.options?.source;
        if (u && !seen.has(u)) {
          seen.add(u);
          out.push({ videoUrl: u, sourceType: "mediael", container: "mp4" });
        }
      }
    }
  } catch { /* ignore */ }

  // Flowplayer
  try {
    if (w.flowplayer) {
      const seen = new Set<string>();
      for (const p of Object.values(w.flowplayer.instances || {}) as any[]) {
        const src = p?.conf?.clip?.sources?.[0]?.src || p?.video?.src;
        if (src && !seen.has(src)) {
          seen.add(src);
          out.push({ videoUrl: src, sourceType: "flowplayer", container: /\.m3u8/i.test(src) ? "hls" : "mp4" });
        }
      }
    }
  } catch { /* ignore */ }

  return out;
}
