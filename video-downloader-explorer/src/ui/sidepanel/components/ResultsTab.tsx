import { useMemo, useState } from "react";
import type { PanelApi } from "../store";
import { VideoCard } from "./VideoCard";
import { FiltersBar } from "./FiltersBar";
import { formatCount } from "../../../shared/utils";
import type { VideoCandidate } from "../../../shared/types";

export function ResultsTab({ state, panel, visible, matched, selected }: {
  state: PanelApi["state"]; panel: PanelApi;
  visible: VideoCandidate[]; matched: number; selected: number;
}) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return visible;
    return visible.filter((c) =>
      (c.title || "").toLowerCase().includes(q) ||
      c.videoUrl.toLowerCase().includes(q) ||
      c.sourceDomain.toLowerCase().includes(q) ||
      c.sourceType.toLowerCase().includes(q) ||
      c.container.toLowerCase().includes(q)
    );
  }, [visible, filter]);

  return (
    <div className="results-tab">
      <div className="results-toolbar">
        <input
          className="search"
          type="search"
          placeholder="Поиск по названию / URL / домену…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="results-actions">
          <button className="btn sm" onClick={panel.selectAll}>Выбрать все</button>
          <button className="btn sm" onClick={panel.selectNone}>Снять</button>
        </div>
      </div>

      <FiltersBar state={state} send={panel.send} />

      <div className="results-meta">
        <span>Показано: <b>{formatCount(filtered.length)}</b>{filtered.length !== state.view.candidates.length ? ` из ${formatCount(state.view.candidates.length)}` : ""}</span>
        {selected > 0 && <span className="selected-count">Выбрано: <b>{formatCount(selected)}</b></span>}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📭</div>
          <p>{state.view.candidates.length === 0 ? "Нет видео. Запустите скан." : "Ничего не найдено по фильтрам."}</p>
        </div>
      ) : (
        <div className="grid">
          {filtered.map((c) => (
            <VideoCard
              key={c.id}
              candidate={c}
              onSelect={(sel) => panel.setSelected([c.id], sel)}
              onAction={(kind, payload) => {
                if (kind === "download") panel.send({ type: "VDE_DOWNLOAD", ids: [c.id] });
                else if (kind === "retry") panel.send({ type: "VDE_RETRY", ids: [c.id] });
                else if (kind === "cancel") panel.send({ type: "VDE_CANCEL_DOWNLOAD", ids: [c.id] });
                else if (kind === "rescan") panel.send({ type: "VDE_SCAN_PAGE" });
                else if (kind === "variant") panel.send({ type: "VDE_SELECT_VARIANT", id: c.id, variantId: payload || "" });
                else if (kind === "open") chrome.tabs.create({ url: c.videoUrl });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
