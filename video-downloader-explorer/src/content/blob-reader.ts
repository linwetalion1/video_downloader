// Чтение blob: / data: URL через fetch в content script.
// Возвращаем ArrayBuffer (в SW переедет как transferable).
//
// ВАЖНО: blob: URL, созданные MediaSource (MSE) — например YouTube, Twitch,
// Instagram — НЕ читаются через fetch: они не хранят байты, а строятся
// из сегментов. Для них возвращаем подробную ошибку с подсказкой.
export interface BlobReadResult {
  ok: boolean;
  bytes?: ArrayBuffer;
  mime?: string;
  error?: string;
  /** true если похоже на MediaSource (MSE) — фатально для прямого чтения. */
  mseLikely?: boolean;
}

export async function readBlobAsArrayBuffer(url: string): Promise<BlobReadResult> {
  if (!url.startsWith("blob:") && !url.startsWith("data:")) {
    return { ok: false, error: "Not a blob/data URL" };
  }

  // Проверяем, не привязан ли blob к MediaSource видео-элемента.
  let mseLikely = false;
  try {
    for (const v of Array.from(document.querySelectorAll("video"))) {
      const currentSrc = v.currentSrc?.split("#")[0];
      if (currentSrc === url.split("#")[0]) {
        // Если у элемента нет srcObject и готовность выше EMPTY — это почти
        // наверняка MSE (сегментированный поток). AttachmentBlob читается через fetch.
        const hasSrcObject = (v as any).srcObject != null;
        const ready = v.readyState;
        if (!hasSrcObject && ready >= 1) mseLikely = true;
        break;
      }
    }
  } catch { /* ignore */ }

  try {
    const resp = await fetch(url, { credentials: "include" as RequestCredentials });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, mseLikely };
    }
    const buf = await resp.arrayBuffer();
    return { ok: true, bytes: buf, mime: resp.headers.get("content-type") || undefined, mseLikely };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    // MediaSource blob: fetch всегда бросает Failed to fetch.
    if (/failed to fetch|networkerror?/i.test(msg) || mseLikely) {
      return {
        ok: false,
        error: "Сегментированный поток (MediaSource/MSE) — blob не содержит исходных байт и не читается напрямую. Воспроизводится через сегменты; прямого файла нет.",
        mseLikely: true,
      };
    }
    return { ok: false, error: `Не удалось прочитать blob: ${msg}`, mseLikely };
  }
}
