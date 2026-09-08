// Фильтры видео: быстрые кнопки в один клик + компактный свернутый спойлер для точной настройки.
import type { State } from "../store";
import type { PanelToWorkerMsg, Settings } from "../../../shared/types";
import { CONTAINER_OPTIONS } from "../../../shared/constants";

export function FiltersBar({ state, send }: { state: State; send: (m: PanelToWorkerMsg) => void }) {
  const s = state.settings;
  if (!s) return null;
  const update = (patch: Partial<Settings>) => send({ type: "VDE_UPDATE_SETTINGS", settings: patch });

  // Считаем количество активных фильтров для бейджа
  let activeCount = 0;
  if (s.minWidth > 0) activeCount++;
  if (s.minHeight > 0) activeCount++;
  if (s.minDurationSec > 0) activeCount++;
  if (s.maxDurationSec > 0) activeCount++;
  if (s.minFileSizeMB > 0) activeCount++;
  if (s.minBitrateKbps > 0) activeCount++;
  if (s.excludeDRM) activeCount++;
  if (s.excludeManifests) activeCount++;
  if (s.excludeBlobs) activeCount++;
  if (s.excludeContainers.length > 0) activeCount++;

  const isQuickAll = s.minHeight === 0 && s.minDurationSec === 0 && !s.excludeManifests && s.excludeContainers.length === 0;
  const isQuickLong = s.minDurationSec >= 600;
  const isQuickMp4 = s.excludeContainers.includes("hls") && !s.excludeContainers.includes("mp4");
  const isQuickHls = s.excludeContainers.includes("mp4") && !s.excludeContainers.includes("hls");
  const isQuickHD = s.minHeight === 720;
  const isQuickFHD = s.minHeight === 1080;

  return (
    <div className="filters-container">
      {/* Быстрые фильтры в один клик */}
      <div className="quick-chips">
        <button
          className={`quick-chip ${isQuickAll ? "active" : ""}`}
          onClick={() => update({ minHeight: 0, minDurationSec: 0, excludeContainers: [] })}
        >
          Все
        </button>
        <button
          className={`quick-chip ${isQuickLong ? "active" : ""}`}
          onClick={() => update({ minDurationSec: isQuickLong ? 0 : 600 })}
          title="Показать только длинные видео и трансляции (от 10 минут), скрывая мелкие стикеры и ролики"
        >
          📼 Длинные (&gt;10 мин)
        </button>
        <button
          className={`quick-chip ${isQuickHls ? "active" : ""}`}
          onClick={() => update({ excludeContainers: ["mp4", "webm"] })}
        >
          HLS / Потоки
        </button>
        <button
          className={`quick-chip ${isQuickMp4 ? "active" : ""}`}
          onClick={() => update({ excludeContainers: ["hls", "dash"] })}
        >
          MP4
        </button>
        <button
          className={`quick-chip ${isQuickHD ? "active" : ""}`}
          onClick={() => update({ minHeight: s.minHeight === 720 ? 0 : 720 })}
        >
          720p+
        </button>
        <button
          className={`quick-chip ${isQuickFHD ? "active" : ""}`}
          onClick={() => update({ minHeight: s.minHeight === 1080 ? 0 : 1080 })}
        >
          1080p+
        </button>
      </div>

      {/* Компактный свернутый спойлер для тонкой настройки */}
      <details className="filters-details">
        <summary className="filters-summary">
          <span>Параметры фильтрации</span>
          {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
        </summary>
        <div className="filters-body">
          <div className="filter-group">
            <label>Мин. высота (px)</label>
            <input type="number" min={0} step={120} value={s.minHeight} onChange={(e) => update({ minHeight: parseInt(e.target.value) || 0 })} />
          </div>
          <div className="filter-group">
            <label>Мин. длительность (с)</label>
            <input type="number" min={0} step={5} value={s.minDurationSec} onChange={(e) => update({ minDurationSec: parseInt(e.target.value) || 0 })} />
          </div>
          <div className="filter-group">
            <label>Мин. размер (МБ)</label>
            <input type="number" min={0} step={5} value={s.minFileSizeMB} onChange={(e) => update({ minFileSizeMB: parseInt(e.target.value) || 0 })} />
          </div>
          <div className="filter-group">
            <label>Мин. битрейт (кбит/с)</label>
            <input type="number" min={0} step={200} value={s.minBitrateKbps} onChange={(e) => update({ minBitrateKbps: parseInt(e.target.value) || 0 })} />
          </div>
          <div className="filter-group checkboxes">
            <label><input type="checkbox" checked={s.excludeDRM} onChange={(e) => update({ excludeDRM: e.target.checked })} /> Скрыть DRM</label>
            <label><input type="checkbox" checked={s.excludeBlobs} onChange={(e) => update({ excludeBlobs: e.target.checked })} /> Скрыть blob без файла (MSE)</label>
            <label><input type="checkbox" checked={s.excludeAds} onChange={(e) => update({ excludeAds: e.target.checked })} /> Скрыть рекламу</label>
          </div>
          <div className="filter-group containers">
            <label>Исключить формат</label>
            <div className="chip-set">
              {CONTAINER_OPTIONS.map((c) => (
                <button
                  key={c}
                  className={`chip ${s.excludeContainers.includes(c) ? "active" : ""}`}
                  onClick={() => {
                    const has = s.excludeContainers.includes(c);
                    update({ excludeContainers: has ? s.excludeContainers.filter((x) => x !== c) : [...s.excludeContainers, c] });
                  }}
                >
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
