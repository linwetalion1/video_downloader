// Фильтры.
import type { State } from "../store";
import type { PanelToWorkerMsg, Settings } from "../../../shared/types";
import { CONTAINER_OPTIONS } from "../../../shared/constants";

export function FiltersBar({ state, send }: { state: State; send: (m: PanelToWorkerMsg) => void }) {
  const s = state.settings;
  if (!s) return null;
  const update = (patch: Partial<Settings>) => send({ type: "VDE_UPDATE_SETTINGS", settings: patch });

  return (
    <details className="filters" open>
      <summary>Фильтры</summary>
      <div className="filters-body">
        <div className="filter-group">
          <label>Мин. ширина, px</label>
          <input type="number" min={0} step={10} value={s.minWidth} onChange={(e) => update({ minWidth: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="filter-group">
          <label>Мин. высота, px</label>
          <input type="number" min={0} step={10} value={s.minHeight} onChange={(e) => update({ minHeight: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="filter-group">
          <label>Мин. длительность, с</label>
          <input type="number" min={0} step={1} value={s.minDurationSec} onChange={(e) => update({ minDurationSec: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="filter-group">
          <label>Макс. длительность, с</label>
          <input type="number" min={0} step={1} value={s.maxDurationSec} onChange={(e) => update({ maxDurationSec: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="filter-group">
          <label>Мин. битрейт, Кбит/с</label>
          <input type="number" min={0} step={100} value={s.minBitrateKbps} onChange={(e) => update({ minBitrateKbps: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="filter-group">
          <label>Мин. размер, МБ</label>
          <input type="number" min={0} step={1} value={s.minFileSizeMB} onChange={(e) => update({ minFileSizeMB: parseInt(e.target.value) || 0 })} />
        </div>
        <div className="filter-group checkboxes">
          <label><input type="checkbox" checked={s.excludeDRM} onChange={(e) => update({ excludeDRM: e.target.checked })} /> Скрыть DRM</label>
          <label><input type="checkbox" checked={s.excludeManifests} onChange={(e) => update({ excludeManifests: e.target.checked })} /> Скрыть HLS/DASH</label>
          <label><input type="checkbox" checked={s.excludeBlobs} onChange={(e) => update({ excludeBlobs: e.target.checked })} /> Скрыть blob/data</label>
          <label><input type="checkbox" checked={s.excludeIframes} onChange={(e) => update({ excludeIframes: e.target.checked })} /> Скрыть iframe</label>
          <label><input type="checkbox" checked={s.excludeAds} onChange={(e) => update({ excludeAds: e.target.checked })} /> Скрыть рекламу (best-effort)</label>
        </div>
        <div className="filter-group containers">
          <label>Контейнеры (исключить)</label>
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
  );
}
