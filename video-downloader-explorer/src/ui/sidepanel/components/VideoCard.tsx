// Карточка одного видео с прогрессом скачивания.
import type { VideoCandidate } from "../../../shared/types";
import { formatBitrate, formatBytes, formatDuration, formatResolution, formatTimeAgo } from "../../../shared/utils";

export function VideoCard({ candidate, onSelect, onAction }: {
  candidate: VideoCandidate;
  onSelect: (selected: boolean) => void;
  onAction: (kind: "download" | "open" | "retry" | "cancel" | "rescan" | "variant", payload?: string) => void;
}) {
  const c = candidate;
  const isWorking = c.status === "downloading" || c.status === "checking";
  const isDone = c.status === "downloaded";
  const isFailed = c.status === "failed";
  const isSkipped = c.status === "skipped";
  const isDRM = c.isDRM;

  const phaseLabel = phaseText(c.phase, c.message);
  const pct = Math.round((c.progress || 0) * 100);

  return (
    <div className={`card ${c.selected ? "selected" : ""} status-${c.status}`}>
      <div className="card-thumb">
        {c.thumbnailUrl ? (
          <img src={c.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <div className="thumb-placeholder">
            <span className="thumb-icon">▶</span>
            <span className="thumb-quality">{formatResolution(c.width, c.height)}</span>
          </div>
        )}
        <div className="card-overlay-top">
          <span className={`container-badge ${c.container}`}>{c.container.toUpperCase()}</span>
          {c.isDRM && <span className="badge drm">DRM</span>}
          {c.isManifest && <span className="badge manifest">Manifest</span>}
        </div>
        <div className="card-overlay-bottom">
          {c.durationSec && <span className="duration">{formatDuration(c.durationSec)}</span>}
        </div>
      </div>

      <div className="card-body">
        <div className="card-title" title={c.title || c.videoUrl}>
          {c.title || basename(c.videoUrl)}
        </div>
        <div className="card-source">
          <span className={`source-type type-${c.sourceType}`}>{c.sourceType}</span>
          <span className="source-domain">{c.sourceDomain}</span>
        </div>

        <div className="card-meta">
          <Meta label="W×H" value={formatResolution(c.width, c.height)} />
          <Meta label="Длит." value={formatDuration(c.durationSec)} />
          <Meta label="Размер" value={c.fileSize ? formatBytes(c.fileSize) : "—"} />
          <Meta label="Битрейт" value={formatBitrate(c.bitrateKbps)} />
        </div>

        {c.hlsVariants && c.hlsVariants.length > 1 && (
          <div className="card-variants">
            <label>Качество HLS:</label>
            <select value={c.selectedVariantId || ""} onChange={(e) => onAction("variant", e.target.value)}>
              {c.hlsVariants.map((v) => (
                <option key={v.id} value={v.id}>{v.resolutionLabel} · {Math.round(v.bandwidth / 1000)}kbps</option>
              ))}
            </select>
          </div>
        )}

        <div className="card-status">
          <StatusLine status={c.status} phase={c.phase} message={c.message} />
          {isWorking && (
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
              <div className="bar-text">{pct}%</div>
            </div>
          )}
        </div>

        <div className="card-actions">
          <label className="checkbox">
            <input type="checkbox" checked={c.selected} onChange={(e) => onSelect(e.target.checked)} />
            <span>Выбрать</span>
          </label>
          <div className="card-buttons">
            {isDRM ? (
              <button className="btn sm" disabled title="DRM — скачивание недоступно">🔒 DRM</button>
            ) : isFailed ? (
              <button className="btn sm primary" onClick={() => onAction("retry")}>↻ Повторить</button>
            ) : isWorking ? (
              <button className="btn sm" onClick={() => onAction("cancel")}>⏹ Отмена</button>
            ) : isDone ? (
              <span className="done-mark">✅ {c.receivedBytes ? formatBytes(c.receivedBytes) : "OK"}</span>
            ) : isSkipped ? (
              <span className="skip-mark">⏭ {c.message || "пропущено"}</span>
            ) : c.isBlob ? (
              // blob на YouTube/стриминге — это MediaSource (MSE), файла в нём нет.
              // Правильное действие — найти реальные ссылки через детекторы.
              <button
                className="btn sm"
                onClick={() => onAction("rescan")}
                title="blob обычно сегментированный поток (MSE) — файла в нём нет. Пересканируем страницу с детекторами плееров/соцсетей, чтобы найти реальную ссылку."
              >🔍 Найти источники</button>
            ) : (
              <button className="btn sm primary" onClick={() => onAction("download")}>⬇ Скачать</button>
            )}
            <button className="btn sm" onClick={() => onAction("open")} title="Открыть оригинал">↗</button>
          </div>
        </div>

        <div className="card-foot">
          <span className="muted">{formatTimeAgo(c.updatedAt)}</span>
          {c.retryCount > 0 && <span className="warn">попыток: {c.retryCount}</span>}
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta">
      <div className="meta-label">{label}</div>
      <div className="meta-value">{value}</div>
    </div>
  );
}

function StatusLine({ status, phase, message }: { status: VideoCandidate["status"]; phase: VideoCandidate["phase"]; message?: string }) {
  return (
    <div className="status-line" data-status={status}>
      <span className="status-dot" />
      <span className="status-text">{message || statusLabel(status, phase)}</span>
    </div>
  );
}

function statusLabel(status: VideoCandidate["status"], phase: VideoCandidate["phase"]): string {
  const map: Record<string, string> = {
    discovered: "Найдено",
    checking: "Проверяем…",
    ready: "Готово",
    queued: "В очереди",
    downloading: "Скачиваем…",
    paused: "Пауза",
    downloaded: "Скачано",
    failed: "Ошибка",
    skipped: "Пропущено",
    cancelled: "Отменено",
  };
  return map[status] || phase;
}

function phaseText(phase: VideoCandidate["phase"], message?: string): string {
  if (message) return message;
  const map: Record<string, string> = {
    init: "Подготовка",
    scanning: "Сканирование",
    "fetching-meta": "Получаем метаданные",
    downloading: "Скачиваем",
    merging: "Склеиваем",
    done: "Готово",
    paused: "Пауза",
    cancelled: "Отменено",
    failed: "Ошибка",
  };
  return map[phase] || phase;
}

function basename(url: string): string {
  try {
    const p = new URL(url).pathname;
    const parts = p.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || p) || url;
  } catch { return url; }
}

