// MAIN-world сниффер сети. Инжектируется через
// chrome.scripting.executeScript({ world: "MAIN", func: VDE_MAIN_WORLD_SNIFFER })
// поэтому функция ПОЛНОСТЬЮ самодостаточна: никаких импортов и замыканий.
//
// Что делает:
//   - хукает window.fetch и XMLHttpRequest в контексте СТРАНИЦЫ;
//   - ловит HLS/DASH-манифесты (m3u8/mpd), видео-URL (mp4/webm/videoplayback)
//     и медиа-ссылки внутри JSON-ответов API (Instagram GraphQL, X, VK и т.д.);
//   - буферизует находки и шлёт их в content script (isolated world) через
//     window.postMessage({ type: "VDE_SNIFF_FINDING" | "VDE_SNIFF_FINDINGS" }).

export const VDE_MAIN_WORLD_SNIFFER = function vdeMainWorldSniffer(): void {
  const w = window as any;
  if (w.__VDE_SNIFFER__) return;
  w.__VDE_SNIFFER__ = true;

  const MAX_BUFFER = 500;
  const MAX_TEXT_SCAN = 4 * 1024 * 1024;
  const buffer: { url: string; mime?: string; at: number }[] = [];
  const seen = new Set<string>();

  const MEDIA_RE = /^https?:\/\/[^\s"'<>\\]+?\.(mp4|m3u8|mpd|webm|mov|m4v|mkv)(\?[^\s"'<>\\]*)?$/i;
  // Манифесты YouTube часто БЕЗ расширения: /api/manifest/hls_playlist/id/…
  const MANIFEST_PATH_RE = /\/api\/manifest\/(hls_playlist|dash)\//i;
  const VIDEOPLAYBACK_RE = /googlevideo\.com\/(videoplayback|api\/manifest)/i;
  const VK_MEDIA_RE = /(?:vkvideo\.ru|vkuservideo\.net|mycdn\.me|vk\.me)\/.*?(?:m3u8|mpd|mp4|\/hls\/|\/live\/)/i;
  const STREAM_HOST_RE = /(?:mmcdn\.com|chaturbate\.com|stripchat\.com|bongacams\.com|cam4\.com|livejasmin\.com|streamate\.com|uncams\.com)\/.*?(?:m3u8|mpd|mp4|\/hls|\/live|\/stream)/i;

  function report(url: string, mime?: string): void {
    try {
      let u = String(url || "");
      if (!u.startsWith("http")) return;
      // JSON часто содержит экранированные слэши.
      const probe = u.replace(/\\\//g, "/");
      if (!MEDIA_RE.test(probe) && !MANIFEST_PATH_RE.test(probe) && !VIDEOPLAYBACK_RE.test(probe) && !VK_MEDIA_RE.test(probe) && !STREAM_HOST_RE.test(probe)) return;
      u = probe.split("#")[0];
      if (seen.has(u) && buffer.length < MAX_BUFFER) return;
      seen.add(u);
      buffer.push({ url: u, mime, at: Date.now() });
      if (buffer.length > MAX_BUFFER) buffer.shift();
      try { w.postMessage({ type: "VDE_SNIFF_FINDING", finding: { url: u, mime } }, "*"); } catch { /* */ }
    } catch { /* ignore */ }
  }

  function scanText(text: string, mime?: string): void {
    try {
      if (!text || text.length > MAX_TEXT_SCAN) return;
      const t = text.replace(/\\\//g, "/");
      const re = /https?:\/\/[^\s"'<>\\)]+?\.(?:mp4|m3u8|mpd)(?:\?[^\s"'<>\\)]*)?/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t)) !== null) report(m[0], mime);
      let g: RegExpExecArray | null;
      const gre = /https?:\/\/[^\s"'<>\\)]*?videoplayback\?[^\s"'<>\\)]*/gi;
      while ((g = gre.exec(t)) !== null) report(g[0], mime);
      const mre = /https?:\/\/[^\s"'<>\\)]*?\/api\/manifest\/(?:hls_playlist|dash)\/[^\s"'<>\\)]*/gi;
      while ((m = mre.exec(t)) !== null) report(m[0], mime);
      const vkre = /https?:\/\/[^\s"'<>\\)]+?(?:vkvideo\.ru|vkuservideo\.net|mycdn\.me|vk\.me)[^\s"'<>\\)]*?(?:m3u8|mpd|\/hls\/|\/live\/)[^\s"'<>\\)]*/gi;
      while ((m = vkre.exec(t)) !== null) report(m[0], mime);
      const stre = /https?:\/\/[^\s"'<>\\)]+?(?:mmcdn\.com|chaturbate\.com|stripchat\.com|bongacams\.com|cam4\.com|livejasmin\.com|streamate\.com)[^\s"'<>\\)]*?(?:m3u8|mpd|mp4|\/hls|\/live|\/stream)[^\s"'<>\\)]*/gi;
      while ((m = stre.exec(t)) !== null) report(m[0], mime);
    } catch { /* ignore */ }
  }

  function looksManifestish(url: string): boolean {
    return /\.m3u8(\?|$)/i.test(url) || /\.mpd(\?|$)/i.test(url)
      || /format=m3u8/i.test(url) || /\/hls\//i.test(url) || MANIFEST_PATH_RE.test(url)
      || VK_MEDIA_RE.test(url) || STREAM_HOST_RE.test(url);
  }

  function classifyAndReport(url: string, mime?: string, bodyText?: string | null): void {
    report(url, mime);
    if (bodyText) {
      const isJson = !mime || /json|javascript|text\/plain/i.test(mime);
      if (isJson || looksManifestish(url)) scanText(bodyText, mime);
    }
  }

  // ── fetch hook ───────────────────────────────────────────────────────────
  const origFetch = w.fetch ? w.fetch.bind(w) : null;
  if (origFetch) {
    w.fetch = async function (...args: any[]): Promise<Response> {
      const resp: Response = await origFetch(...args);
      try {
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || resp.url || "";
        const mime = resp.headers ? (resp.headers.get("content-type") || undefined) : undefined;
        if (/video\/|mpegurl|dash\+xml|octet-stream|json/i.test(mime || "") || MEDIA_RE.test(url) || VIDEOPLAYBACK_RE.test(url)) {
          if (/json|mpegurl|dash\+xml|text\/plain/i.test(mime || "") && resp.body) {
            resp.clone().text().then((t: string) => classifyAndReport(url, mime, t)).catch(() => {});
          } else {
            classifyAndReport(url, mime, null);
          }
        }
      } catch { /* ignore */ }
      return resp;
    };
  }

  // ── XHR hook ─────────────────────────────────────────────────────────────
  const XO = w.XMLHttpRequest;
  if (XO && XO.prototype) {
    const origOpen = XO.prototype.open;
    const origSend = XO.prototype.send;
    XO.prototype.open = function (this: any, method: string, url: string, ...rest: any[]) {
      try { this.__vdeUrl = String(url || ""); } catch { /* */ }
      return origOpen.call(this, method, url, ...rest);
    };
    XO.prototype.send = function (this: any, ...sendArgs: any[]) {
      try {
        this.addEventListener("load", () => {
          try {
            const url = this.__vdeUrl || this.responseURL || "";
            let mime = "";
            try { mime = this.getResponseHeader("content-type") || ""; } catch { /* */ }
            const statusOk = (this.status === 0 || this.status >= 200) && this.status < 300;
            if (!statusOk) return;
            const rt = this.responseType;
            if (rt === "" || rt === "text") {
              classifyAndReport(url, mime, this.responseText);
            } else if (rt === "json" && this.response) {
              try { classifyAndReport(url, mime, JSON.stringify(this.response)); } catch { /* */ }
            } else {
              classifyAndReport(url, mime, null);
            }
          } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      return origSend.apply(this, sendArgs as any[]);
    };
  }

  // ── WebSocket hook ───────────────────────────────────────────────────────
  const OrigWS = w.WebSocket;
  if (OrigWS) {
    w.WebSocket = function (url: string | URL, protocols?: string | string[]) {
      try {
        const u = String(url || "");
        if (/wss?:\/\//i.test(u) && (/video|stream|live|flv|hls|media/i.test(u) || STREAM_HOST_RE.test(u))) {
          report(u.replace(/^ws/i, "http"), "application/x-mpegurl");
        }
      } catch { /* ignore */ }
      const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      try {
        ws.addEventListener("message", (ev: MessageEvent) => {
          if (typeof ev.data === "string" && ev.data.length < 50000) {
            scanText(ev.data);
          }
        });
      } catch { /* ignore */ }
      return ws;
    };
    w.WebSocket.prototype = OrigWS.prototype;
    w.WebSocket.CONNECTING = OrigWS.CONNECTING;
    w.WebSocket.OPEN = OrigWS.OPEN;
    w.WebSocket.CLOSING = OrigWS.CLOSING;
    w.WebSocket.CLOSED = OrigWS.CLOSED;
  }

  // ── Ответ на пинг content script'а ───────────────────────────────────────
  w.addEventListener("message", (ev: MessageEvent) => {
    try {
      if (ev.source !== w || !ev.data || ev.data.type !== "VDE_SNIFF_PING") return;
      w.postMessage({ type: "VDE_SNIFF_FINDINGS", findings: buffer.slice() }, "*");
    } catch { /* ignore */ }
  });
};
