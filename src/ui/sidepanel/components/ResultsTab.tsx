import { useEffect, useMemo, useRef, useState } from "react";
import { buildCsv, buildJson, downloadTextFile } from "../../../shared/export";
import type { ImageCandidate, SortKey } from "../../../shared/types";
import { formatCount } from "../../../shared/utils";
import { usePanel } from "../store";
import { FiltersPanel } from "./FiltersPanel";
import { ImageCard } from "./ImageCard";

interface Props {
  visible: ImageCandidate[];
  found: number;
  matched: number;
  selected: number;
  onPreview: (c: ImageCandidate) => void;
  onDownloadSelected: () => void;
}

const SORT_OPTIONS: Array<[SortKey, string]> = [
  ["fileSize", "По размеру файла"],
  ["width", "По ширине"],
  ["height", "По высоте"],
  ["resolution", "По разрешению"],
  ["name", "По имени"],
  ["url", "По URL"],
  ["depth", "По глубине"],
  ["page", "По странице"],
  ["selected", "Сначала выбранные"],
];

export function ResultsTab({ visible, found, matched, selected, onPreview, onDownloadSelected }: Props) {
  const panel = usePanel();
  const { settings, candidates } = panel.state;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerW, setContainerW] = useState(600);
  const [containerH, setContainerH] = useState(600);
  const [view, setView] = useState(settings.viewMode);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      setContainerW(el.clientWidth);
      setContainerH(el.clientHeight);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const patchSettings = (p: Partial<typeof settings>) =>
    panel.send({ type: "IDE_UPDATE_SETTINGS", settings: p });

  const setViewMode = (v: typeof view) => {
    setView(v);
    patchSettings({ viewMode: v });
  };

  const domains = useMemo(() => [...new Set(candidates.map((c) => c.sourceDomain))].slice(0, 100), [candidates]);
  const exts = useMemo(() => [...new Set(candidates.map((c) => c.extension).filter(Boolean) as string[])], [candidates]);
  const depths = useMemo(() => [...new Set(candidates.map((c) => c.depth))].sort(), [candidates]);

  // Виртуализация (ТЗ §23, §57)
  const CARD_W = view === "list" ? 0 : view === "compact" ? 140 : 220;
  const ROW_H = view === "list" ? 112 : view === "compact" ? 150 : 230;
  const cols = Math.max(1, Math.floor((containerW - 4) / (CARD_W + 10)));
  const rowCount = view === "list" ? visible.length : Math.ceil(visible.length / cols);
  const overscan = 3;
  const firstRow = Math.max(0, Math.floor(scrollTop / (ROW_H + 6)) - overscan);
  const lastRow = Math.min(rowCount - 1, Math.ceil((scrollTop + Math.max(containerH, 400)) / (ROW_H + 6)) + overscan);

  const slice = useMemo(() => {
    if (view === "list") return visible.slice(Math.max(0, firstRow), lastRow + 1);
    return visible.slice(firstRow * cols, (lastRow + 1) * cols);
  }, [visible, firstRow, lastRow, cols, view]);

  const exportCsv = () => downloadTextFile("images.csv", buildCsv(candidates), "text/csv;charset=utf-8");
  const exportJson = () => downloadTextFile("images.json", buildJson(candidates), "application/json");
  const copyUrls = async () => {
    const urls = candidates.filter((c) => c.selected).map((c) => c.imageUrl).join("\n");
    if (urls) await navigator.clipboard.writeText(urls);
  };

  const idsOf = (list: ImageCandidate[]) => list.map((c) => c.id);
  const selectFiltered = () => panel.setSelection(idsOf(visible), true);
  const unselectFiltered = () => panel.setSelection(idsOf(visible), false);
  const invert = () => {
    panel.setSelection(idsOf(visible.filter((c) => !c.selected)), true);
    panel.setSelection(idsOf(visible.filter((c) => c.selected)), false);
  };

  const selectByDepth = (d: number) => panel.selectBy((c) => c.depth === d, true);
  const selectByDomain = (d: string) => panel.selectBy((c) => c.sourceDomain === d, true);
  const selectByFormat = (f: string) => panel.selectBy((c) => c.extension === f, true);
  const selectByMinSize = (kb: number) => panel.selectBy((c) => (c.fileSize ?? 0) >= kb * 1024, true);

  if (found === 0) {
    const scanning = panel.state.status === "running";
    return (
      <div className="tab-body">
        <div className="empty-state">
          <p>{scanning ? "Сканирование…" : "На странице не найдено изображений."}</p>
          <p className="hint">
            {scanning
              ? "Кандидаты появятся здесь по мере обнаружения."
              : "Включите прокрутку и мониторинг динамики на вкладке «Найти», затем повторите поиск."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-body">
      <FiltersPanel settings={settings} onChange={patchSettings} />

      {found > 0 && matched === 0 && (
        <div className="empty-state small">
          Изображения найдены, но ни одно не соответствует текущим фильтрам.
        </div>
      )}

      <div className="results-toolbar">
        <div className="btn-group">
          <button className="btn" onClick={panel.selectAll} title="Ctrl+A">Выбрать всё</button>
          <button className="btn" onClick={panel.selectNone} title="Ctrl+D">Снять всё</button>
          <button className="btn" onClick={selectFiltered}>Выбрать отфильтрованные</button>
          <button className="btn" onClick={unselectFiltered}>Снять отфильтрованные</button>
          <button className="btn" onClick={invert}>Инвертировать</button>
        </div>
        <div className="btn-group">
          <span className="muted">По…</span>
          <select value="" onChange={(e) => {
            const [kind, val] = e.target.value.split(":");
            if (kind === "depth") selectByDepth(Number(val));
            else if (kind === "domain") selectByDomain(val);
            else if (kind === "format") selectByFormat(val);
            else if (kind === "size") selectByMinSize(Number(val));
            e.target.value = "";
          }}>
            <option value="" disabled>выбрать по…</option>
            {depths.map((d) => <option key={d} value={`depth:${d}`}>глубине {d}</option>)}
            {domains.map((d) => <option key={d} value={`domain:${d}`}>домену {d}</option>)}
            {exts.map((e2) => <option key={e2} value={`format:${e2}`}>формату {e2}</option>)}
            {[100, 300, 500, 1000].map((kb) => <option key={kb} value={`size:${kb}`}>от {kb} KB</option>)}
          </select>
        </div>
      </div>

      <div className="results-toolbar second">
        <div className="btn-group" role="group" aria-label="Режим отображения">
          {(["grid", "compact", "list"] as const).map((v) => (
            <button key={v} className={`btn ${view === v ? "active" : ""}`} onClick={() => setViewMode(v)}>
              {v === "grid" ? "Grid" : v === "compact" ? "Compact" : "List"}
            </button>
          ))}
        </div>
        <div className="btn-group">
          <select value={settings.sortKey} onChange={(e) => patchSettings({ sortKey: e.target.value as SortKey })} aria-label="Сортировка">
            {SORT_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="btn" onClick={() => patchSettings({ sortDir: settings.sortDir === "asc" ? "desc" : "asc" })} aria-label="Направление сортировки">
            {settings.sortDir === "asc" ? "↑ Возрастание" : "↓ Убывание"}
          </button>
          <button className="btn" onClick={() => void copyUrls()}>Копировать URL выбранных</button>
          <button className="btn" onClick={exportCsv}>CSV</button>
          <button className="btn" onClick={exportJson}>JSON</button>
        </div>
      </div>

      <div className="results-scroll" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div
          className={`cards ${view}`}
          style={{ height: rowCount * (ROW_H + 6), paddingTop: firstRow * (ROW_H + 6) }}
        >
          {slice.map((c) => (
            <ImageCard
              key={c.id}
              candidate={c}
              compact={view === "compact"}
              list={view === "list"}
              onPreview={() => onPreview(c)}
              onToggle={() => panel.setSelection([c.id], !c.selected)}
            />
          ))}
        </div>
      </div>

      <button className="btn primary big download-fab" onClick={onDownloadSelected} disabled={selected === 0}>
        Скачать выбранные ({formatCount(selected)})
      </button>
    </div>
  );
}