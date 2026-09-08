import { useState } from "react";
import { buildDebugLog, downloadTextFile } from "../../../shared/export";
import { formatBytes, formatCount } from "../../../shared/utils";
import { usePanel } from "../store";
import { ProgressBar } from "./ProgressBar";

/** Вкладка «Загрузка»: очередь, ошибки, история задач, debug-лог (ТЗ §31, §53, §59). */
export function DownloadsTab() {
  const panel = usePanel();
  const { state } = panel;
  const [histFilter, setHistFilter] = useState<string>("");
  const busy = state.status === "running" || state.status === "paused";

  const exportLog = () => {
    downloadTextFile("ide-debug.log", buildDebugLog(state.logs), "text/plain;charset=utf-8");
  };

  const retryFailed = () => panel.send({ type: "IDE_RETRY_FAILED" });

  const clearJob = () => {
    if (confirm("Очистить текущие результаты и остановить задачу?")) {
      panel.send({ type: "IDE_CLEAR_JOB" });
      panel.clearLocal();
    }
  };

  const history = state.history.filter((h) => !histFilter || h.rootUrl.includes(histFilter));

  return (
    <div className="tab-body">
      <section className="card">
        <h2>Прогресс задачи</h2>
        <ProgressBar state={state} />
        <div className="btn-group">
          {busy && <button className="btn" onClick={() => panel.send({ type: "IDE_PAUSE" })}>Пауза</button>}
          {state.status === "paused" && <button className="btn" onClick={() => panel.send({ type: "IDE_RESUME" })}>Продолжить</button>}
          {(busy || state.status === "paused") && <button className="btn danger" onClick={() => panel.send({ type: "IDE_CANCEL" })}>Остановить</button>}
          <button className="btn" onClick={clearJob}>Очистить</button>
          <button className="btn" onClick={exportLog}>Экспорт debug log</button>
        </div>
      </section>

      <section className="card">
        <h2>Статистика</h2>
        <div className="stats-grid">
          <div><b>{state.stats.pagesVisited}</b><span>страниц</span></div>
          <div><b>{formatCount(state.stats.imagesFound)}</b><span>изображений</span></div>
          <div><b>{state.stats.downloadsCompleted}</b><span>скачано</span></div>
          <div><b>{formatBytes(state.stats.downloadBytes)}</b><span>объём</span></div>
          <div><b>{state.stats.errors}</b><span>ошибок</span></div>
          <div><b>{state.taskCounts.completed + state.taskCounts.failed + state.taskCounts.skipped}</b><span>задач выполнено</span></div>
        </div>
        {state.stats.limitImagesReached && <div className="warn-banner">Поиск остановлен: достигнут установленный лимит изображений.</div>}
        {state.stats.limitPagesReached && <div className="warn-banner">Поиск остановлен: достигнут лимит страниц (discovery прекращён).</div>}
      </section>

      {state.errors.length > 0 && (
        <section className="card">
          <h2>Ошибки <button className="btn small" onClick={retryFailed}>Повторить неудачные</button></h2>
          <ul className="error-list">
            {state.errors.slice(0, 100).map((e) => (
              <li key={e.id} title={e.url}>
                <span className={`err-tag ${e.retryable ? "retryable" : ""}`}>{e.taskType}</span>
                <span className="err-text">{e.message}</span>
                <span className="muted">{new Date(e.time).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>История задач</h2>
        <input
          className="search-input"
          type="search"
          placeholder="Поиск по URL…"
          value={histFilter}
          onChange={(e) => setHistFilter(e.target.value)}
        />
        {history.length === 0 && <p className="hint">История пуста — запустите поиск.</p>}
        <ul className="history-list">
          {history.map((h) => (
            <li key={h.id}>
              <div>
                <span className="muted">{new Date(h.startedAt).toLocaleString()}</span>
                {" — "}
                <b>{h.rootUrl}</b>
                <span className="muted"> ({h.imagesFound} изобр., скачано {h.downloadsCompleted}, {h.mode === "crawl" ? "обход" : "страница"})</span>
              </div>
              <div className="btn-group">
                <button
                  className="btn small"
                  onClick={() => panel.send({ type: "IDE_START_JOB", settings: state.settings, rootUrl: h.rootUrl })}
                >
                  Повторить
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Debug-лог</h2>
        <div className="log-box">
          {state.logs.slice(-50).map((l, i) => (
            <div key={i} className={`log-line ${l.level.toLowerCase()}`}>
              <span className="muted">{new Date(l.time).toLocaleTimeString()}</span> [{l.level}] {l.message}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}