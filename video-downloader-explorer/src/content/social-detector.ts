// Детекторы видео в популярных соцсетях. БЕЗОПАСНО: только чтение public JSON-блобов
// (которые сами сайты кладут в window или в <script>).
import { isHttpUrl, isObscureTitle, normalizeUrl } from "../shared/utils";
import type { RawVideoCandidate, SourceType } from "../shared/types";

declare const window: any;

export function detectSocialVideos(pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const w = (doc as any).defaultView || window;
  const h = pageUrl.toLowerCase();

  // YouTube
  if (/youtube\.com|youtu\.be/.test(h)) {
    out.push(...detectYouTube(w, pageUrl, doc));
  }
  // Vimeo
  if (/vimeo\.com/.test(h)) {
    out.push(...detectVimeo(w, pageUrl, doc));
  }
  // RuTube
  if (/rutube\.ru/.test(h)) {
    out.push(...detectRutube(w, pageUrl, doc));
  }
  // VK / VK Видео
  if (/vk\.com|vkvideo\.ru|vk\.ru/.test(h)) {
    out.push(...detectVK(w, pageUrl, doc));
  }
  // OK
  if (/ok\.ru/.test(h)) {
    out.push(...detectOK(w, pageUrl, doc));
  }
  // Coub
  if (/coub\.com/.test(h)) {
    out.push(...detectCoub(w, pageUrl, doc));
  }
  // Dailymotion
  if (/dailymotion\.com|dai\.ly/.test(h)) {
    out.push(...detectDailymotion(w, pageUrl, doc));
  }
  // Twitch
  if (/twitch\.tv/.test(h)) {
    out.push(...detectTwitch(w, pageUrl, doc));
  }
  // Reddit
  if (/reddit\.com|redd\.it/.test(h)) {
    out.push(...detectReddit(w, pageUrl, doc));
  }
  // Instagram
  if (/instagram\.com/.test(h)) {
    out.push(...detectInstagram(w, pageUrl, doc));
  }
  // TikTok
  if (/tiktok\.com/.test(h)) {
    out.push(...detectTikTok(w, pageUrl, doc));
  }
  // Twitter / X
  if (/twitter\.com|x\.com/.test(h)) {
    out.push(...detectTwitter(w, pageUrl, doc));
  }
  // Facebook
  if (/facebook\.com|fb\.watch/.test(h)) {
    out.push(...detectFacebook(w, pageUrl, doc));
  }
  // Pinterest
  if (/pinterest\.com|pin\.it/.test(h)) {
    out.push(...detectPinterest(w, pageUrl, doc));
  }
  // 9GAG
  if (/9gag\.com/.test(h)) {
    out.push(...detect9Gag(w, pageUrl, doc));
  }
  // Bilibili
  if (/bilibili\.com/.test(h)) {
    out.push(...detectBilibili(w, pageUrl, doc));
  }
  // Rumble
  if (/rumble\.com/.test(h)) {
    out.push(...detectRumble(w, pageUrl, doc));
  }

  return out;
}

function detectYouTube(w: any, pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();

  // Надёжно извлекает объект JSON из строки вида: var X = { … };
  // через баланс фигурных скобок, без хрупких regex с предположениями о суффиксе.
  const extractJson = (src: string, marker: string): any | null => {
    const idx = src.indexOf(marker);
    if (idx < 0) return null;
    let i = src.indexOf("{", idx);
    if (i < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(src.slice(src.indexOf("{", idx), i + 1)); } catch { return null; } } }
    }
    return null;
  };

  // 1) Разбираем playerResponse → progressive/adaptive URL.
  const tryExtractFromScript = (json: any) => {
    try {
      const pr = json?.playerResponse || json?.response || json;
      const sd = pr?.streamingData;
      const title = pr?.videoDetails?.title;
      const thumb = pr?.videoDetails?.thumbnail?.thumbnails?.[0]?.url;
      const durSec = parseInt(pr?.videoDetails?.lengthSeconds || "0", 10) || undefined;
      const isPremiumDRM = !!(sd?.drmParams || sd?.serverAbrStreamingUrl?.includes("drm"));

      if (sd) {
        // signatureCipher/cipher — ссылки, требующие подписи (YouTube часто прячет url).
        const formats = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
        for (const f of formats) {
          const url = f?.url || (f?.signatureCipher && /url=([^&]+)/.exec(f.signatureCipher)?.[1]) || (f?.cipher && /url=([^&]+)/.exec(f.cipher)?.[1]);
          if (url && !seen.has(url)) {
            const decoded = (() => { try { return decodeURIComponent(url as string); } catch { return url as string; } })();
            seen.add(decoded);
            // Если URL пришёл из signatureCipher/cipher (а не готовым в f.url) — нужна подпись.
            const needsSig = !f?.url;
            const itag = parseInt(f.itag || "0", 10);
            let quality = "";
            if (itag >= 137 || itag === 308) quality = "1080p";
            else if (itag === 136 || itag === 303) quality = "720p";
            else if (itag === 135 || itag === 302) quality = "480p";
            else if (itag === 134) quality = "360p";
            else if (itag === 133) quality = "240p";
            else if (itag >= 251 || itag === 171) quality = "audio";
            out.push({
              videoUrl: decoded as string, sourceType: "youtube",
              container: f.mimeType?.includes("webm") ? "webm" : "mp4",
              mimeType: f.mimeType?.split(";")[0] || "video/mp4",
              width: f.width, height: f.height,
              bitrateKbps: f.bitrate ? Math.round(f.bitrate / 1000) : undefined,
              // Качество не примешиваем к title (его видно в метаданных и шаблоне имени).
              title: title || undefined,
              thumbnailUrl: thumb, durationSec: durSec,
              context: { needsSignature: needsSig, itag, quality },
            });
          }
        }
        if (isPremiumDRM) {
          out.push({
            videoUrl: pageUrl, sourceType: "youtube",
            container: "unknown", isDRM: true, isManifest: false,
            title: (title ? title + " " : "") + "(DRM/Премиум)",
          });
        }
        // Если есть HLS-манифест — добавить его.
        if (sd.hlsManifestUrl && !seen.has(sd.hlsManifestUrl)) {
          seen.add(sd.hlsManifestUrl);
          out.push({
            videoUrl: sd.hlsManifestUrl, sourceType: "youtube",
            container: "hls", mimeType: "application/x-mpegurl", isManifest: true,
            title: title ? title + " · HLS" : undefined, thumbnailUrl: thumb, durationSec: durSec,
          });
        }
        if (sd.dashManifestUrl && !seen.has(sd.dashManifestUrl)) {
          seen.add(sd.dashManifestUrl);
          out.push({
            videoUrl: sd.dashManifestUrl, sourceType: "youtube",
            container: "dash", mimeType: "application/dash+xml", isManifest: true,
            title: title ? title + " · DASH" : undefined, thumbnailUrl: thumb, durationSec: durSec,
          });
        }
      }
    } catch { /* */ }
  };

  // 2) window.ytplayer.config.args.player_response
  if (w.ytplayer?.config?.args?.player_response) {
    try { tryExtractFromScript({ playerResponse: JSON.parse(w.ytplayer.config.args.player_response) }); } catch { /* */ }
  }
  if (w.ytInitialPlayerResponse) {
    tryExtractFromScript({ playerResponse: w.ytInitialPlayerResponse });
  }
  if (w["ytInitialPlayerResponse"]) {
    tryExtractFromScript({ playerResponse: w["ytInitialPlayerResponse"] });
  }

  // 3) <script> с ytInitialPlayerResponse (hook через баланс скобок)
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    const json = extractJson(t, "ytInitialPlayerResponse");
    if (json) tryExtractFromScript({ playerResponse: json });
  });

  return out;
}

function detectVimeo(w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string, mime?: string, w2?: number, h2?: number) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "vimeo", container: /\.m3u8/i.test(url) ? "hls" : /\.mpd/i.test(url) ? "dash" : "mp4", mimeType: mime || (/\.m3u8/i.test(url) ? "application/x-mpegurl" : "video/mp4"), width: w2, height: h2, isManifest: /\.m3u8|\.mpd/i.test(url) });
  };
  // window.vimeo.clips или config
  const cfg = w.vimeo?.config || w.vimeoConfig;
  if (cfg?.request?.files) {
    for (const f of Object.values(cfg.request.files) as any[]) {
      if (f?.url) tryAdd(f.url, undefined, f.width, f.height);
    }
    if (cfg.request.files.hls) tryAdd(cfg.request.files.hls.url, "application/x-mpegurl");
    if (cfg.request.files.dash) tryAdd(cfg.request.files.dash.url, "application/dash+xml");
  }
  // <script> с vimeo.config
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    const m = /window\.vimeo\s*=\s*window\.vimeo\s*\|\|\s*({.+?});/.exec(t) || /vimeo\.config\s*=\s*({.+?});/.exec(t);
    if (m) { try { const j = JSON.parse(m[1]); if (j?.config) detectVimeo({ vimeo: j }, _pageUrl, doc); } catch { /* */ } }
  });
  return out;
}

function detectRutube(w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string, mime?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "rutube", container: /\.m3u8/i.test(url) ? "hls" : /\.mpd/i.test(url) ? "dash" : "mp4", mimeType: mime, isManifest: /\.m3u8|\.mpd/i.test(url) });
  };
  // __NEXT_DATA__ или __INITIAL_STATE__
  if (w.__NEXT_DATA__?.props?.initialState) {
    const state = w.__NEXT_DATA__.props.initialState;
    const video = state?.video?.video;
    if (video) {
      tryAdd(video.video_url, "video/mp4");
      tryAdd(video.hls_url, "application/x-mpegurl");
      tryAdd(video.dash_url, "application/dash+xml");
    }
  }
  // <script>
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    const m = /"video_url"\s*:\s*"([^"]+)"/.exec(t);
    if (m) tryAdd(normalizeUrl(m[1]) || m[1], "video/mp4");
    const m2 = /"hls_url"\s*:\s*"([^"]+)"/.exec(t);
    if (m2) tryAdd(normalizeUrl(m2[1]) || m2[1], "application/x-mpegurl");
  });
  return out;
}

function detectVK(w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();

  // Общие метаданные страницы
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content")
    || doc.querySelector('meta[name="twitter:title"]')?.getAttribute("content")
    || doc.title?.replace(/\s*\|\s*(ВКонтакте|VK|VK Видео).*$/i, "").trim()
    || undefined;

  const ogThumb = doc.querySelector('meta[property="og:image"]')?.getAttribute("content")
    || doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content")
    || undefined;

  const domTitle = doc.querySelector('.VideoPageInfo__title, .VideoPage__title, h1.VideoHeader__title, .video_item_title, .post_video_title')?.textContent?.trim()
    || doc.querySelector('.wall_post_text, .post_text, [data-post-id] .wall_text')?.textContent?.trim()?.slice(0, 100);

  let pageTitle = ogTitle;
  if (!pageTitle || isObscureTitle(pageTitle)) {
    if (domTitle) pageTitle = domTitle;
  }
  let pageThumb = ogThumb;
  let pageDurationSec: number | undefined;

  const cleanUrl = (u: string) => {
    let s = u.replace(/\\\//g, "/").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (s.startsWith("//")) s = "https:" + s;
    return s;
  };

  const tryAdd = (
    rawUrl: string,
    opts: {
      mime?: string;
      container?: "mp4" | "hls" | "dash" | "webm";
      width?: number;
      height?: number;
      title?: string;
      thumb?: string;
      duration?: number;
      isLive?: boolean;
    } = {}
  ) => {
    if (!rawUrl) return;
    const url = cleanUrl(rawUrl);
    if (!isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);

    const isHls = /\.m3u8(\?|$)/i.test(url) || /\/hls\//i.test(url) || opts.container === "hls";
    const isDash = /\.mpd(\?|$)/i.test(url) || opts.container === "dash";
    const container = isHls ? "hls" : isDash ? "dash" : (opts.container || "mp4");
    const mime = opts.mime || (isHls ? "application/x-mpegurl" : isDash ? "application/dash+xml" : "video/mp4");

    out.push({
      videoUrl: url,
      sourceType: "vk",
      container,
      mimeType: mime,
      isManifest: isHls || isDash,
      width: opts.width,
      height: opts.height,
      title: opts.title || pageTitle,
      thumbnailUrl: opts.thumb || pageThumb,
      durationSec: opts.duration ?? pageDurationSec,
      isLive: !!opts.isLive,
      context: { isLive: !!opts.isLive },
    });
  };

  // 1) Анализ глобальных объектов (w.__NEXT_DATA__, w.__INITIAL_STATE__, w.cur)
  try {
    let nextData = w.__NEXT_DATA__?.props?.pageProps || w.__NEXT_DATA__?.props?.initialState;
    if (!nextData) {
      const el = doc.getElementById("__NEXT_DATA__");
      if (el?.textContent) {
        try {
          const j = JSON.parse(el.textContent);
          nextData = j?.props?.pageProps || j?.props?.initialState;
        } catch { /* ignore */ }
      }
    }
    const vObj = nextData?.video || nextData?.videoItem || nextData?.initialVideo;
    if (vObj) {
      if (vObj.title) pageTitle = vObj.title;
      if (vObj.thumb) pageThumb = vObj.thumb;
      if (vObj.duration) pageDurationSec = Number(vObj.duration);

      const isLiveObj = vObj.is_live === 1 || vObj.is_live === true || vObj.live === 1 || vObj.status === "live";

      // files: { mp4_720: "...", hls: "...", dash: "..." }
      if (vObj.files && typeof vObj.files === "object") {
        for (const [k, u] of Object.entries(vObj.files)) {
          if (typeof u !== "string" || !u) continue;
          if (k === "hls") tryAdd(u, { container: "hls", isLive: isLiveObj });
          else if (k === "dash") tryAdd(u, { container: "dash", isLive: isLiveObj });
          else {
            const m = /(\d{3,4})/.exec(k);
            const h = m ? parseInt(m[1], 10) : undefined;
            tryAdd(u, { height: h, container: "mp4", isLive: isLiveObj });
          }
        }
      }
      if (vObj.hls) tryAdd(vObj.hls, { container: "hls", isLive: isLiveObj });
      if (vObj.dash) tryAdd(vObj.dash, { container: "dash", isLive: isLiveObj });
      if (vObj.video_url) tryAdd(vObj.video_url, { isLive: isLiveObj });
    }
  } catch { /* ignore */ }

  // 2) Сканирование всех <script>
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    if (!t) return;

    // Извлечение названия и превью из скрипта, если ещё нет
    if (!pageTitle || isObscureTitle(pageTitle)) {
      const tm = /"md_title"\s*:\s*"([^"]+)"/.exec(t) || /"title"\s*:\s*"([^"]+)"/.exec(t);
      if (tm && tm[1].length > 1) {
        try { pageTitle = decodeURIComponent(JSON.parse(`"${tm[1]}"`)); } catch { pageTitle = tm[1]; }
      }
    }
    if (!pageThumb) {
      const pm = /"thumb"\s*:\s*"([^"]+)"/.exec(t) || /"jpg"\s*:\s*"([^"]+)"/.exec(t);
      if (pm) pageThumb = cleanUrl(pm[1]);
    }
    if (!pageDurationSec) {
      const dm = /"duration"\s*:\s*(\d+)/.exec(t);
      if (dm) pageDurationSec = parseInt(dm[1], 10);
    }

    const isLiveInScript = /"is_live"\s*:\s*(?:1|true)|"live"\s*:\s*1|"status"\s*:\s*"live"/i.test(t);

    // HLS-потоки для трансляций и VOD (hls, hls_live, hls_live_playback, live_playback, hls_ondemand, hls_vod, live, manifestUrl)
    for (const hKey of ["hls_live_playback", "live_playback", "hls_live", "hls_ondemand", "hls_vod", "hls", "manifestUrl", "live"]) {
      const re = new RegExp(`"${hKey}"\\s*:\\s*"([^"]+)"`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(t)) !== null) {
        tryAdd(m[1], { container: "hls", isLive: /live/i.test(hKey) || isLiveInScript });
      }
    }

    // DASH-потоки
    for (const dKey of ["dash_live_playback", "dash_live", "dash_ondemand", "dash_uni", "dash"]) {
      const re = new RegExp(`"${dKey}"\\s*:\\s*"([^"]+)"`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(t)) !== null) {
        tryAdd(m[1], { container: "dash" });
      }
    }

    // Прогрессивные MP4 (url240, url360, url480, url720, url1080, url1440, url2160)
    for (const q of ["url240", "url360", "url480", "url720", "url1080", "url1440", "url2160"]) {
      const re = new RegExp(`"${q}"\\s*:\\s*"([^"]+)"`, "g");
      const h = parseInt(q.replace("url", ""), 10) || undefined;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t)) !== null) {
        tryAdd(m[1], { height: h, container: "mp4" });
      }
    }

    // Прямой поиск CDN m3u8/mpd/mp4 ссылок ВКонтакте в тексте скрипта
    const cdnRe = /https?:\/\/[^\s"'<>\\)]+?(?:vkvideo\.ru|vkuservideo\.net|mycdn\.me|vk\.me|userapi\.com)[^\s"'<>\\)]*?\.(?:m3u8|mpd|mp4)(?:\?[^\s"'<>\\)]*)?/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cdnRe.exec(t)) !== null) {
      tryAdd(cm[0]);
    }
  });

  // 3) <video> теги на странице (когда воспроизведение запущено)
  doc.querySelectorAll("video").forEach((v) => {
    const src = v.getAttribute("src") || v.currentSrc;
    if (src && !src.startsWith("blob:") && isHttpUrl(src)) {
      tryAdd(src);
    }
    v.querySelectorAll("source").forEach((s) => {
      const u = s.getAttribute("src");
      if (u && isHttpUrl(u)) tryAdd(u);
    });
  });

  return out;
}

function detectOK(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string, mime?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "ok", container: /\.m3u8/i.test(url) ? "hls" : "mp4", mimeType: mime, isManifest: /\.m3u8/i.test(url) });
  };
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    const m = /"videos?":\s*\[([^\]]+)\]/.exec(t);
    if (m) {
      for (const u of (m[1].match(/"https?:[^"]+\.(?:mp4|m3u8)[^"]*"/gi) || [])) {
        tryAdd(u.slice(1, -1).replace(/\\\//g, "/"));
      }
    }
    const m2 = /"hlsManifestUrl"\s*:\s*"([^"]+)"/.exec(t);
    if (m2) tryAdd(m2[1], "application/x-mpegurl");
  });
  return out;
}

function detectCoub(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string, mime?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "coub", container: "mp4", mimeType: mime });
  };
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    for (const q of ["hd", "med", "high", "low"]) {
      const m = new RegExp(`"${q}_url"\\s*:\\s*"([^"]+)"`).exec(t);
      if (m) tryAdd(m[1].replace(/\\\//g, "/"));
    }
  });
  return out;
}

function detectDailymotion(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    const m = /"stream_url"\s*:\s*"(https?:\/\/[^"]+)"/.exec(t);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ videoUrl: m[1], sourceType: "dailymotion", container: /\.m3u8/i.test(m[1]) ? "hls" : "mp4", isManifest: /\.m3u8/i.test(m[1]) });
    }
  });
  return out;
}

function detectTwitch(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    const m = /"url"\s*:\s*"(https?:\/\/usher\.ttvnw\.net\/[^"]+\.m3u8[^"]*)"/.exec(t);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ videoUrl: m[1], sourceType: "twitch", container: "hls", mimeType: "application/x-mpegurl", isManifest: true });
    }
  });
  return out;
}

function detectReddit(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "reddit", container: /\.m3u8/i.test(url) ? "hls" : /\.mpd/i.test(url) ? "dash" : "mp4", isManifest: /\.m3u8|\.mpd/i.test(url) });
  };
  doc.querySelectorAll("script[type='application/ld+json']").forEach((s) => {
    try {
      const j = JSON.parse(s.textContent || "{}");
      if (j["@type"] === "VideoObject" && j.contentUrl) tryAdd(j.contentUrl);
    } catch { /* */ }
  });
  // <video>
  doc.querySelectorAll("video[src]").forEach((v) => {
    const u = v.getAttribute("src");
    if (u) tryAdd(u);
  });
  return out;
}

function detectInstagram(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "instagram", container: /\.m3u8/i.test(url) ? "hls" : "mp4", isManifest: /\.m3u8/i.test(url) });
  };
  // <video src=…>, <source src=…>
  doc.querySelectorAll("video").forEach((v) => {
    const src = v.getAttribute("src") || v.currentSrc;
    if (src) tryAdd(src);
    v.querySelectorAll("source").forEach((s) => {
      const u = s.getAttribute("src");
      if (u) tryAdd(u);
    });
  });
  // window.__additionalData / sharedData (старые схемы)
  const data = _w?.__additionalData?.["edge"]?.["xdt_api__v1__media__shortcode__web"]["shortcode_media"]
    || _w?._sharedData?.["entry_data"]?.["PostPage"]?.[0]?.["graphql"]?.["shortcode_media"];
  if (data) {
    const v = data?.video_url || data?.dash_info?.["video_dash_manifest"] || data?.video_dash_manifest;
    if (v) tryAdd(v);
  }
  // Современный IG кладёт медиа в GraphQL JSON внутри <script> и XHR:
  // video_url, playable_url(_quality_low|_high), video_versions[{url}], dash_manifest.
  // Сканируем текст всех скриптов на эти паттерны.
  doc.querySelectorAll("script").forEach((s) => {
    let t = s.textContent || "";
    if (!t) return;
    t = t.replace(/\\\//g, "/");
    for (const m of t.matchAll(/"(?:video_url|playable_url(?:_quality_\w+)?)"\s*:\s*"(https?:\/\/[^"]+)"/g)) {
      if (/\.mp4|m3u8/i.test(m[1])) tryAdd(m[1]);
    }
    for (const m of t.matchAll(/"video_versions"\s*:\s*\[([^\]]{10,20000}?)\]/g)) {
      for (const u of m[1].match(/https?:\/\/[^"\\]+?\.(?:mp4|m3u8)[^"\\]*/gi) || []) tryAdd(u.replace(/\\\//g, "/"));
    }
    for (const m of t.matchAll(/"dash_manifest"\s*:\s*"([^"]+)"/g)) {
      tryAdd(decodeURIComponent(m[1]));
    }
  });
  return out;
}

function detectTikTok(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "tiktok", container: /\.m3u8/i.test(url) ? "hls" : "mp4", isManifest: /\.m3u8/i.test(url) });
  };
  // __UNIVERSAL_DATA_FOR_REHYDRATION__
  const ud = _w?.["__UNIVERSAL_DATA_FOR_REHYDRATION__"] || _w?.SIGI_STATE;
  if (ud) {
    try {
      const json = typeof ud === "string" ? JSON.parse(ud) : ud;
      const items = json?.["__DEFAULT_SCOPE__"]?.["webapp.video-detail"]?.itemInfo?.itemStruct?.video?.playAddr
        || json?.ItemModule?.[""]?.video?.playAddr;
      const urls = Array.isArray(items) ? items : items ? [items] : [];
      for (const u of urls) {
        if (typeof u === "string") tryAdd(u);
        else if (Array.isArray(u)) for (const x of u) if (x) tryAdd(typeof x === "string" ? x : (x as any)?.src);
        else if (u && typeof u === "object") tryAdd((u as any)?.src);
      }
    } catch { /* */ }
  }
  // <video src=…>
  doc.querySelectorAll("video").forEach((v) => {
    const src = v.getAttribute("src") || v.currentSrc;
    if (src) tryAdd(src);
  });
  return out;
}

function detectTwitter(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "twitter", container: /\.m3u8/i.test(url) ? "hls" : /\.mpd/i.test(url) ? "dash" : "mp4", isManifest: /\.m3u8|\.mpd/i.test(url) });
  };
  // <video>
  doc.querySelectorAll("video").forEach((v) => {
    const src = v.getAttribute("src") || v.currentSrc;
    if (src) tryAdd(src);
    v.querySelectorAll("source").forEach((s) => {
      const u = s.getAttribute("src");
      if (u) tryAdd(u);
    });
  });
  // __INITIAL_STATE__ / GraphQL
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    const m = /"video_info"\s*:\s*\{[^}]*"variants"\s*:\s*\[([^\]]+)\]/.exec(t);
    if (m) {
      for (const u of m[1].match(/"https?:\/\/[^"]+\.(?:mp4|m3u8|mpd)[^"]*"/gi) || []) {
        tryAdd(u.slice(1, -1).replace(/\\\//g, "/"));
      }
    }
  });
  return out;
}

function detectFacebook(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "facebook", container: /\.m3u8/i.test(url) ? "hls" : "mp4", isManifest: /\.m3u8/i.test(url) });
  };
  // sd_src, hd_src
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    for (const q of ["sd_src", "hd_src"]) {
      const m = new RegExp(`"${q}"\\s*:\\s*"(https?:[^"]+)"`).exec(t);
      if (m) tryAdd(m[1].replace(/\\\//g, "/"));
    }
  });
  // <video>
  doc.querySelectorAll("video").forEach((v) => {
    const src = v.getAttribute("src") || v.currentSrc;
    if (src) tryAdd(src);
  });
  return out;
}

function detectPinterest(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    for (const u of t.match(/"https?:\/\/v\d*\.pinimg\.com\/[^"]+\.(?:mp4|m3u8)[^"]*"/gi) || []) {
      const url = u.slice(1, -1).replace(/\\\//g, "/");
      if (!seen.has(url)) {
        seen.add(url);
        out.push({ videoUrl: url, sourceType: "pinterest", container: /\.m3u8/i.test(url) ? "hls" : "mp4", isManifest: /\.m3u8/i.test(url) });
      }
    }
  });
  return out;
}

function detect9Gag(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  doc.querySelectorAll("video[src]").forEach((v) => {
    const u = v.getAttribute("src");
    if (u) out.push({ videoUrl: u, sourceType: "9gag", container: "mp4" });
  });
  return out;
}

function detectBilibili(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  const tryAdd = (url: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ videoUrl: url, sourceType: "bilibili", container: /\.m3u8/i.test(url) ? "hls" : /\.mpd/i.test(url) ? "dash" : "mp4", isManifest: /\.m3u8|\.mpd/i.test(url) });
  };
  // __INITIAL_STATE__
  const init = _w?.__INITIAL_STATE__;
  if (init?.videoData?.dash?.video) {
    const dashUrl = init.videoData.dash.video[0]?.baseUrl || init.videoData.dash.video[0]?.base_url;
    if (dashUrl) tryAdd(dashUrl);
  }
  // <script>
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    const m = /"dash":\s*\{[^}]*"video":\s*\[[^\]]*"baseUrl"\s*:\s*"(https?:[^"]+\.mpd[^"]*)"/.exec(t);
    if (m) tryAdd(m[1].replace(/\\\//g, "/"));
  });
  return out;
}

function detectRumble(_w: any, _pageUrl: string, doc: Document): RawVideoCandidate[] {
  const out: RawVideoCandidate[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll("script").forEach((s) => {
    const t = s.textContent || "";
    for (const u of t.match(/"https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*"/gi) || []) {
      const url = u.slice(1, -1).replace(/\\\//g, "/");
      if (/\.rumble\.cloud|rumblelivecdn|spindoctorvideos/.test(url) && !seen.has(url)) {
        seen.add(url);
        out.push({ videoUrl: url, sourceType: "rumble", container: /\.m3u8/i.test(url) ? "hls" : "mp4", isManifest: /\.m3u8/i.test(url) });
      }
    }
  });
  return out;
}
