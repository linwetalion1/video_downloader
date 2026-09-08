// Карточка видео в современном чистом дизайне без избыточного шума.
import type { VideoCandidate } from "../../../shared/types";
import { formatBytes, formatDuration, formatResolution } from "../../../shared/utils";

export function VideoCard({ candidate, onSelect, onAction }: {
  candidate: VideoCandidate;
  onSelect: (selected: boolean) => void;
  onAction: (kind: "download" | "open" | "retry" | "cancel" | "rescan" | "variant", payload?: string) => void;
}) {
  const c = candidate;
  const isWorking = c.status === "downloading" || c.status === "checking";
  const isDone = c.status === "downloaded";
  const isFailed = c.status === "failed";
  const isDRM = c.isDRM;

  const pct = Math.round((c.progress || 0) * 100);
  const qualityLabel = formatResolution(c.width, c.height) || (c.isManifest ? c.container.toUpperCase() : "");

  // Лаконичная строка сведений: Источник · Формат · Размер
  const subInfoParts: string[] = [];
  if (c.sourceDomain) subInfoParts.push(c.sourceDomain);
  if (c.container && c.container !== "unknown") subInfoParts.push(c.container.toUpperCase());
  if (c.fileSize && c.fileSize > 0) subInfoParts.push(formatBytes(c.fileSize));
  const subInfo = subInfoParts.join(" · ");

  return (
    <div className={`card ${c.selected ? "selected" : ""} status-${c.status}`}>
      {/* Превью 16:9 с бейджами качества и длительности */}
      <div className="card-thumb" onClick={() => onSelect(!c.selected)}>
        {c.thumbnailUrl ? (
          <img src={c.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <div className="thumb-placeholder">
            <span className="thumb-icon">▶</span>
          </div>
        )}
        <div className="card-overlay-top">
          {qualityLabel && <span className={`quality-badge ${c.container}`}>{qualityLabel}</span>}
          {c.isDRM && <span className="badge drm">DRM</span>}
        </div>
        <div className="card-overlay-bottom">
          {c.durationSec && c.durationSec > 0 && (
            <span className="duration-badge">{formatDuration(c.durationSec)}</span>
          )}
        </div>
      </div>

      <div className="card-body">
        {/* Заголовок */}
        <div className="card-title" title={c.title || c.videoUrl}>
          {c.title || basename(c.videoUrl)}
        </div>

        {/* Лаконичная подпись источника и размера */}
        <div className="card-subinfo">
          {subInfo || c.sourceType}
        </div>

        {/* Выбор качества для HLS (если вариантов несколько) */}
        {c.hlsVariants && c.hlsVariants.length > 1 && (
          <div className="card-variants">
            <select
              value={c.selectedVariantId || ""}
              onChange={(e) => onAction("variant", e.target.value)}
              title="Выбрать качество потока"
            >
              {c.hlsVariants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.resolutionLabel} · {Math.round(v.bandwidth / 1000)} kbps
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Статус и прогресс (только когда идет активная работа) */}
        {isWorking && (
          <div className="card-progress-area">
            <div className="card-progress-msg">{c.message || "Скачивание…"}</div>
            <div className="card-bar">
              <div className="card-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {/* Действия */}
        <div className="card-actions">
          <label className="card-select-label" title="Выбрать для массового скачивания">
            <input
              type="checkbox"
              checked={c.selected}
              onChange={(e) => onSelect(e.target.checked)}
            />
          </label>

          <div className="card-buttons">
            {isDRM ? (
              <span className="card-status-badge drm" title="Защищено DRM">🔒 DRM</span>
            ) : isFailed ? (
              <button className="btn sm danger" onClick={() => onAction("retry")} title={c.message || "Ошибка"}>
                ↻ Повторить
              </button>
            ) : isWorking ? (
              <button className="btn sm" onClick={() => onAction("cancel")}>
                ⏹ Отмена
              </button>
            ) : isDone ? (
              <span className="card-status-badge ok">
                ✅ {c.receivedBytes ? formatBytes(c.receivedBytes) : "Скачано"}
              </span>
            ) : c.isBlob ? (
              <button className="btn sm" onClick={() => onAction("rescan")} title="Поиск прямых источников">
                🔍 Источники
              </button>
            ) : (
              <button className="btn sm primary" onClick={() => onAction("download")}>
                ⬇ Скачать
              </button>
            )}

            <button
              className="btn-icon"
              onClick={() => onAction("open")}
              title="Открыть видео в новой вкладке"
            >
              ↗
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function basename(url: string): string {
  try {
    const p = new URL(url).pathname;
    const parts = p.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || p) || url;
  } catch { return url; }
}

