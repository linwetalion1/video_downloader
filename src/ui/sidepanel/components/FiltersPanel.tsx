import { useState } from "react";
import { FORMAT_OPTIONS } from "../../../shared/constants";
import type { Filters } from "../../../shared/types";

interface Props {
  settings: Filters;
  onChange: (patch: Partial<Filters>) => void;
}

/** Панель фильтров: ползунки + числовые поля, логика AND/OR, форматы (ТЗ §4). */
export function FiltersPanel({ settings, onChange }: Props) {
  const [open, setOpen] = useState(true);

  const num = (v: string) => (v === "" ? 0 : Math.max(0, Number(v) || 0));

  const RangeField = ({ label, value, max, onChange: set }: {
    label: string; value: number; max: number; onChange: (n: number) => void;
  }) => (
    <div className="field">
      <div className="range-label">
        <span>{label}</span>
        <input
          type="number"
          min={0}
          value={value}
          onChange={(e) => set(num(e.target.value))}
          aria-label={label}
        />
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={max > 10000 ? 100 : max > 1000 ? 50 : 10}
        value={Math.min(value, max)}
        onChange={(e) => set(num(e.target.value))}
      />
    </div>
  );

  return (
    <div className="filters">
      <button className="btn ghost small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "▾ Скрыть фильтры" : "▸ Показать фильтры"} — применяются локально
      </button>

      {open && (
        <div className="filters-body">
          <RangeField label="Минимальная ширина (px)" value={settings.minWidth} max={8000}
            onChange={(n) => onChange({ minWidth: n })} />
          <RangeField label="Минимальная высота (px)" value={settings.minHeight} max={8000}
            onChange={(n) => onChange({ minHeight: n })} />
          <RangeField label="Минимальный размер файла (KB)" value={settings.minFileSizeKB} max={5000}
            onChange={(n) => onChange({ minFileSizeKB: n })} />

          <div className="row">
            <span>Логика: </span>
            <label className="radio">
              <input type="radio" name="filterMode" checked={settings.filterMode === "AND"}
                onChange={() => onChange({ filterMode: "AND" })} /> AND
            </label>
            <label className="radio">
              <input type="radio" name="filterMode" checked={settings.filterMode === "OR"}
                onChange={() => onChange({ filterMode: "OR" })} /> OR
            </label>
          </div>

          <div className="grid2">
            <label className="field inline">
              Мин. соотношение сторон
              <input type="number" min={0} step={0.1} value={settings.minAspect || ""}
                placeholder="напр. 1.0"
                onChange={(e) => onChange({ minAspect: num(e.target.value) })} />
            </label>
            <label className="field inline">
              Макс. соотношение сторон
              <input type="number" min={0} step={0.1} value={settings.maxAspect || ""}
                placeholder="напр. 2.0"
                onChange={(e) => onChange({ maxAspect: num(e.target.value) })} />
            </label>
          </div>

          <div className="row wrap">
            <label className="checkbox">
              <input type="checkbox" checked={settings.excludeTiny}
                onChange={(e) => onChange({ excludeTiny: e.target.checked })} />
              Исключить иконки (≤16×16)
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={settings.excludeTrackingPixels}
                onChange={(e) => onChange({ excludeTrackingPixels: e.target.checked })} />
              Исключить tracking-pixel (≤2×2)
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={settings.excludeSVG}
                onChange={(e) => onChange({ excludeSVG: e.target.checked })} />
              Исключить SVG
            </label>
          </div>

          <div className="field">
            <span>Только форматы:</span>
            <div className="chips">
              <button
                className={`chip ${settings.includeFormats === null ? "on" : ""}`}
                onClick={() => onChange({ includeFormats: null })}
                title="Любые форматы"
              >
                Любые
              </button>
              {FORMAT_OPTIONS.map((f) => (
                <button
                  key={f}
                  className={`chip ${settings.includeFormats?.includes(f) ? "on" : ""}`}
                  onClick={() => {
                    const cur = settings.includeFormats ?? [];
                    onChange({
                      includeFormats: cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f],
                    });
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="row wrap">
            <span className="muted">Исключить форматы:</span>
            {FORMAT_OPTIONS.map((f) => (
              <label key={f} className="checkbox">
                <input type="checkbox" checked={settings.excludeFormats.includes(f)}
                  onChange={(e) => {
                    const cur = settings.excludeFormats;
                    onChange({
                      excludeFormats: e.target.checked ? [...cur, f] : cur.filter((x) => x !== f),
                    });
                  }} />
                {f}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}