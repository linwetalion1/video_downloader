// Карточка видео с наглядной идентификацией трансляций, эфиров и видео (без скрытых имен).
import { useState } from "react";
import type { VideoCandidate } from "../../../shared/types";
import { formatBytes, formatDuration, formatDurationHuman, formatResolution, isObscureTitle } from "../../../shared/utils";

export function VideoCard({ candidate, onSelect, onAction }: {
  candidate: VideoCandidate;
  onSelect: (selected: boolean) => void;
  onAction: (kind: "download" | "open" | "retry" | "cancel" | "rescan" | "variant", payload?: string) => void;
}) {
  const c = candidate;
  const [showPreview, setShowPreview] = useState(false);
  const isWorking = c.status === "downloading" || c.status === "checking";
  const isDone = c.status === "downloaded";
  const isFailed = c.status === "failed";
  const isDRM = c.isDRM;

  const pct = Math.round((c.progress || 0) * 100);
  const qualityLabel = formatResolution(c.width, c.height) || (c.isManifest ? c.container.toUpperCase() : "");

  // Определение типа медиа для визуальных бейджей
  const isLive = !!c.isLive;
  const isLongBroadcast = !isLive && ((c.durationSec && c.durationSec >= 1800) || (c.segmentsCount && c.segmentsCount >= 400));
  const isSticker = !isLive && c.durationSec !== undefined && c.durationSec > 0 && c.durationSec <= 15 && (c.fileSize ? c.fileSize < 1.5 * 1024 * 1024 : true);

  // Человекочитаемое название
  let displayTitle = c.title;
  if (!displayTitle || isObscureTitle(displayTitle)) {
    const durStr = c.durationSec ? formatDurationHuman(c.durationSec) : "";
    const res = qualityLabel || c.container.toUpperCase();
    if (isLive) {
      displayTitle = `🔴 Прямой эфир (${res})`;
    } else if (isLongBroadcast) {
      displayTitle = `📼 Трансляция / Запись (${durStr}${res ? `, ${res}` : ""})`;
    } else if (c.durationSec && c.durationSec > 0) {
      displayTitle = `🎬 Видео (${durStr}${res ? `, ${res}` : ""})`;
    } else {
      displayTitle = basename(c.videoUrl);
    }
  }

  // Наглядная строка сведений: Домен · Формат · Длительность · Сегменты · Размер
  const subInfoParts: string[] = [];
  if (c.sourceDomain) subInfoParts.push(c.sourceDomain);
  if (c.container && c.container !== "unknown") subInfoParts.push(c.container.toUpperCase());
  if (c.durationSec && c.durationSec > 0) subInfoParts.push(formatDurationHuman(c.durationSec));
  if (c.segmentsCount && c.segmentsCount > 0) subInfoParts.push(`${c.segmentsCount.toLocaleString("ru-RU")} сегм.`);
  if (c.fileSize && c.fileSize > 0) subInfoParts.push(formatBytes(c.fileSize));
  const subInfo = subInfoParts.join(" · ");

  return (
    <div className={`card ${c.selected ? "selected" : ""} status-${c.status} ${isLive ? "card-live" : isLongBroadcast ? "card-broadcast" : ""}`}>
      {/* Превью / Инлайн-плеер */}
      <div className="card-thumb">
        {showPreview ? (
          <div className="card-preview-container">
            <video
              className="card-inline-video"
              src={c.videoUrl}
              controls
              autoPlay
              playsInline
              preload="metadata"
            />
            <button
              className="card-preview-close"
              onClick={(e) => { e.stopPropagation(); setShowPreview(false); }}
              title="Закрыть предпросмотр"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="card-thumb-click" onClick={() => onSelect(!c.selected)}>
            {c.thumbnailUrl ? (
              <img src={c.thumbnailUrl} alt="" loading="lazy" />
            ) : (
              <div className="thumb-placeholder">
                <span className="thumb-icon">{isLive ? "🔴" : isLongBroadcast ? "📼" : "▶"}</span>
              </div>
            )}
            <div className="card-overlay-top">
              {c.sourceType === "webrtc" ? (
                <span className="badge live">🔴 WEBRTC ЭФИР</span>
              ) : isLive ? (
                <span className="badge live">🔴 ПРЯМОЙ ЭФИР</span>
              ) : isLongBroadcast ? (
                <span className="badge stream">📼 ТРАНСЛЯЦИЯ</span>
              ) : isSticker ? (
                <span className="badge sticker">🖼️ СТИКЕР</span>
              ) : null}
              {qualityLabel && <span className={`quality-badge ${c.container}`}>{qualityLabel}</span>}
              {c.isDRM && <span className="badge drm">DRM</span>}
            </div>
            <div className="card-overlay-bottom">
              {isLive ? (
                <span className="duration-badge live">🔴 LIVE</span>
              ) : c.durationSec && c.durationSec > 0 ? (
                <span className="duration-badge">{formatDuration(c.durationSec)}</span>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="card-body">
        {/* Человекочитаемый заголовок */}
        <div className="card-title" title={c.title || c.videoUrl}>
          {displayTitle}
        </div>

        {/* Наглядная подпись: Домен · HLS · 9 ч 14 мин · 16 620 сегм. · 4.8 ГБ */}
        <div className="card-subinfo" title={subInfo}>
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
          <label className="card-select-label" title="Выбрать для скачивания">
            <input
              type="checkbox"
              checked={c.selected}
              onChange={(e) => onSelect(e.target.checked)}
            />
          </label>

          <div className="card-buttons">
            {/* Кнопка предпросмотра */}
            <button
              className={`btn-icon ${showPreview ? "active" : ""}`}
              onClick={(e) => { e.stopPropagation(); setShowPreview(!showPreview); }}
              title={showPreview ? "Скрыть предпросмотр" : "Предпросмотр видео прямо в карточке"}
            >
              {showPreview ? "⏹" : "👁️"}
            </button>

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
            ) : c.sourceType === "webrtc" ? (
              <span className="card-status-badge live" title="Прямой эфир WebRTC (воспроизводится в реальном времени, нажмите 👁️ для предпросмотра)">
                🔴 WebRTC
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

