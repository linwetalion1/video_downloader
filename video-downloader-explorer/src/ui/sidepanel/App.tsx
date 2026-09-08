// Главный компонент side panel. Включает детальный status-баннер с активной
// фазой работы, табы, и все экраны.
import { useEffect, useMemo, useState } from "react";
import { usePanel } from "./store";
import { FindTab } from "./components/FindTab";
import { ResultsTab } from "./components/ResultsTab";
import { DownloadsTab } from "./components/DownloadsTab";
import { SettingsTab } from "./components/SettingsTab";
import { LogsTab } from "./components/LogsTab";
import { StatusBanner } from "./components/StatusBanner";
import { formatBytes, formatCount } from "../../shared/utils";
import { countMatched, matchesFilters, sortCandidates } from "../../media/filters";
import type { TabKey } from "./types";

export function App() {
  const panel = usePanel();
  const { state, send } = panel;
  const [tab, setTab] = useState<TabKey>("find");

  const visible = useMemo(() => {
    const filtered = state.view.candidates.filter((c) => matchesFilters(c, state.settings));
    const sorted = sortCandidates(filtered, state.settings.sortKey, state.settings.sortDir);
    // blob (MSE) — в самый конец: они не скачиваются напрямую.
    return [...sorted].sort((a, b) => (a.isBlob ? 1 : 0) - (b.isBlob ? 1 : 0));
  }, [state.view.candidates, state.settings]);

  const matched = useMemo(() => countMatched(state.view.candidates, state.settings), [state.view.candidates, state.settings]);
  const selected = useMemo(() => state.view.candidates.filter((c) => c.selected).length, [state.view.candidates]);

  // Авто-переключение на "Результаты" после скана.
  useEffect(() => {
    if (state.view.candidates.length > 0 && tab === "find" && (state.view.status === "running" || state.view.status === "completed")) {
      setTab("results");
    }
  }, [state.view.candidates.length, state.view.status]);

  // Горячие клавиши.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); panel.selectAll(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); panel.selectNone(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); setTab("find"); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); setTab("logs"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel]);

  const downloadSelected = () => {
    const selected = state.view.candidates.filter((c) => c.selected);
    const blobOnly = selected.filter((c) => c.isBlob).length;
    const ids = selected.filter((c) => !c.isBlob && c.status !== "downloaded").map((c) => c.id);
    if (ids.length === 0) {
      if (blobOnly > 0) {
        panel.setBanner(`blob-кандидаты — это поток MSE без файла (${blobOnly} шт.). Выберите прямые mp4/HLS-ссылки из списка (у них бейдж MP4/HLS) или нажмите «🔍 Найти источники» на карточке.`);
      } else {
        panel.setBanner("Нечего скачивать — выберите видео галочками");
      }
      setTab("results");
      return;
    }
    send({ type: "VDE_DOWNLOAD", ids });
    setTab("downloads");
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="logo">▶</span>
          <span>Video Downloader Explorer</span>
        </div>
        <div className={`conn ${state.connected ? "ok" : "no"}`} title={state.connected ? "Service worker подключен" : "Нет соединения с SW"}>
          <span className="dot" /> {state.connected ? "online" : "offline"}
        </div>
      </header>

      <StatusBanner state={state} />

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "find"} className={`tab ${tab === "find" ? "active" : ""}`} onClick={() => setTab("find")}>
          Найти
        </button>
        <button role="tab" aria-selected={tab === "results"} className={`tab ${tab === "results" ? "active" : ""}`} onClick={() => setTab("results")}>
          Результаты ({formatCount(state.view.candidates.length)})
        </button>
        <button role="tab" aria-selected={tab === "downloads"} className={`tab ${tab === "downloads" ? "active" : ""}`} onClick={() => setTab("downloads")}>
          Загрузки {state.view.taskCounts.running > 0 ? `(${state.view.taskCounts.running})` : ""}
        </button>
        <button role="tab" aria-selected={tab === "logs"} className={`tab ${tab === "logs" ? "active" : ""}`} onClick={() => setTab("logs")}>
          Лог {state.logs.length > 0 ? `(${state.logs.length})` : ""}
        </button>
        <button role="tab" aria-selected={tab === "settings"} className={`tab ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}>
          Настройки
        </button>
      </nav>

      <main className="app-main">
        {tab === "find" && <FindTab state={state} send={send} />}
        {tab === "results" && <ResultsTab state={state} panel={panel} visible={visible} matched={matched} selected={selected} />}
        {tab === "downloads" && <DownloadsTab state={state} send={send} />}
        {tab === "logs" && <LogsTab state={state} />}
        {tab === "settings" && <SettingsTab state={state} send={send} />}
      </main>

      <footer className="app-footer">
        <div className="footer-counts">
          {selected > 0 ? (
            <span className="footer-selected">Выбрано: <b>{formatCount(selected)}</b></span>
          ) : (
            <span className="footer-total">Всего: <b>{formatCount(state.view.candidates.length)}</b></span>
          )}
          {state.view.stats.totalDownloaded > 0 && (
            <span className="footer-stats-tag ok">✅ {formatBytes(state.view.stats.totalBytes)}</span>
          )}
          {state.view.stats.totalFailed > 0 && (
            <span className="footer-stats-tag err">❌ {state.view.stats.totalFailed}</span>
          )}
        </div>
        <div className="footer-buttons">
          {(state.busy || state.view.status === "paused") && (
            state.view.status === "paused" ? (
              <button className="btn sm" onClick={() => send({ type: "VDE_RESUME" })}>▶ Продолжить</button>
            ) : (
              <button className="btn sm" onClick={() => send({ type: "VDE_PAUSE" })}>⏸ Пауза</button>
            )
          )}
          <button
            className="btn primary"
            disabled={selected === 0}
            onClick={downloadSelected}
            title="Скачать выбранные (Ctrl+Enter)"
          >
            ⬇ Скачать {selected > 0 ? `(${formatCount(selected)})` : ""}
          </button>
        </div>
      </footer>
    </div>
  );
}
