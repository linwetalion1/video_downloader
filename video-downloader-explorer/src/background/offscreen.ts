import { downloadHlsSegments, type HlsSegmentInfo } from "../media/hls";

const jobs = new Map<string, { parts: (Uint8Array | null)[]; updatedAt: number }>();

try {
  setInterval(() => {
    const now = Date.now();
    for (const [k, job] of jobs) {
      if (now - job.updatedAt > 15 * 60_000) jobs.delete(k);
    }
  }, 60_000);
} catch { /* ignore */ }

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "OFFSCREEN_DOWNLOAD_HLS") {
    const { segments, baseUrl, audioSegments, audioBaseUrl } = msg as {
      segments: HlsSegmentInfo[];
      audioSegments?: HlsSegmentInfo[];
      baseUrl: string;
      audioBaseUrl?: string;
      filename: string;
      mime: string;
    };

    downloadHlsSegments(
      segments,
      baseUrl,
      undefined,
      (received, total) => {
        chrome.runtime.sendMessage({ type: "OFFSCREEN_HLS_PROGRESS", received, total }).catch(() => {});
      },
      undefined,
      5,
      audioSegments,
      audioBaseUrl
    )
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        sendResponse({ ok: true, objectUrl, bytes: blob.size });
      })
      .catch((e) => {
        sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      });

    return true; // async sendResponse
  }

  if (msg.type === "OFFSCREEN_SAVE_CHUNK") {
    try {
      let job = jobs.get(msg.jobId);
      if (!job) {
        job = { parts: [], updatedAt: Date.now() };
        jobs.set(msg.jobId, job);
      }
      job.parts[msg.index as number] = new Uint8Array(msg.bytes as ArrayBuffer);
      job.updatedAt = Date.now();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String((e as Error)?.message || e) });
    }
    return true;
  }

  if (msg.type === "OFFSCREEN_SAVE_COMMIT") {
    try {
      const job = jobs.get(msg.jobId);
      if (!job || job.parts.length === 0) {
        sendResponse({ ok: false, error: "нет принятых чанков" });
        return true;
      }
      jobs.delete(msg.jobId);
      // СТРОГАЯ проверка полноты: битый файл лучше не создавать вовсе.
      if (job.parts.some((p) => !p)) {
        sendResponse({ ok: false, error: "неполные данные (потерян чанк)" });
        return true;
      }
      let total = 0;
      for (const p of job.parts) total += (p as Uint8Array).byteLength;

      // Создаём Blob напрямую из массива частей без аллокации монолитного 10+ ГБ буфера
      const blob = new Blob(job.parts as BlobPart[], { type: msg.mime || "application/octet-stream" });
      const objectUrl = URL.createObjectURL(blob);

      sendResponse({ ok: true, objectUrl, bytes: blob.size });
    } catch (e) {
      sendResponse({ ok: false, error: String((e as Error)?.message || e) });
    }
    return true;
  }

  if (msg.type === "OFFSCREEN_REVOKE_URL") {
    if (msg.url) {
      try { URL.revokeObjectURL(msg.url); } catch { /* ignore */ }
    }
    sendResponse({ ok: true });
    return true;
  }
});
