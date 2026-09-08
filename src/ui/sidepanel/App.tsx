import { useCallback, useEffect, useMemo, useState } from "react";
import { countMatched, matchesFilters, sortCandidates } from "../../images/filters";
import { formatBytes, formatCount } from "../../shared/utils";
import { FindTab } from "./components/FindTab";
import { ResultsTab } from "./components/ResultsTab";
import { DownloadsTab } from "./components/DownloadsTab";
import { SettingsTab } from "./components/SettingsTab";
import { ImageModal } from "./components/ImageModal";
import { StatusChip } from "./components/StatusChip";
import type { ImageCandidate } from "../../shared/types";
import { PanelProvider, usePanel } from "./store";

export type TabKey = "find" | "results" | "downloads" | "settings";

function AppInner() {
  const panel = usePanel();
  const { state } = panel;
  const [tab, setTab] = useState<TabKey>("find");
  const [preview, setPreview] = useState<ImageCandidate | null>(null);

  const { found, matched, selected, visible } = useMemo(() => {
    const foundCount = state.candidates.length;
    const matchedCount = countMatched(state.candidates, state.settings);
    const selectedCount = state.candidates.filter((c) => c.selected).length;
    const filtered = state.candidates.filter((c) => matchesFilters(c, state.settings));
    const sorted = sortCandidates(filtered, state.settings.sortKey, state.settings.sortDir);
    return { found: foundCount, matched: matchedCount, selected: selectedCount, visible: sorted };
  }, [state.candidates, state.settings]);

  // Горячие клавиши (ТЗ §58)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        panel.selectAll();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        panel.selectNone();
      } else if (e.key === "Escape") {
        setPreview(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  const downloadSelected = useCallback(() => {
    const ids = state.candidates.filter((c) => c.selected && c.status !== "downloaded").map((c) => c.id);
    if (ids.length > 0) panel.send({ type: "IDE_DOWNLOAD_SELECTED", ids });
  }, [state.candidates, panel]);

  useEffect(() => {
    if (state.candidates.length > 0 || (state.scanSummary && state.scanSummary.ok)) {
      setTab((t) => (t === "find" && (state.status === "running" || state.status === "completed") ? "results" : t));
    }
  }, [state.candidates.length, state.scanSummary, state.status]);

  const tabCounts: Array<[TabKey, string]> = [
    ["find", "Найти"],
    ["results", `Результаты (${formatCount(found)})`],
    ["downloads", "Загрузка"],
    ["settings", "Настройки"],
  ];

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="logo">🖼️</span>
          <span>Image Downloader Explorer</span>
        </div>
        <StatusChip status={state.status} />
      </header>

      <nav className="tabs" role="tablist">
        {tabCounts.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {tab === "find" && (
          <FindTab busy={state.status === "running" || state.status === "paused"} />
        )}
        {tab === "results" && (
          <ResultsTab
            visible={visible}
            found={found}
            matched={matched}
            selected={selected}
            onPreview={setPreview}
            onDownloadSelected={downloadSelected}
          />
        )}
        {tab === "downloads" && <DownloadsTab />}
        {tab === "settings" && <SettingsTab />}
      </main>

      <footer className="app-footer">
        <div className="counts">
          <span>Найдено: <b>{formatCount(found)}</b></span>
          <span>Подходит фильтрам: <b>{formatCount(matched)}</b></span>
          <span>Выбрано: <b>{formatCount(selected)}</b></span>
          {state.stats.downloadBytes > 0 && (
            <span className="muted">Скачано: {state.stats.downloadsCompleted} / {formatBytes(state.stats.downloadBytes)}</span>
          )}
        </div>
        <button
          className="btn primary"
          disabled={selected === 0}
          onClick={downloadSelected}
          title="Скачать выбранные изображения"
        >
          Скачать выбранные ({formatCount(selected)})
        </button>
      </footer>

      {preview && <ImageModal candidate={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

export function App() {
  return (
    <PanelProvider>
      <AppInner />
    </PanelProvider>
  );
}