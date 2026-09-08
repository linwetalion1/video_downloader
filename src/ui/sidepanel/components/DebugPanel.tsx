import { useEffect, useRef, useState } from "react";
import { buildDebugLog, downloadTextFile } from "../../../shared/export";
import type { ScanSummary, UILogEntry } from "../../../shared/types";
import type { ConnState } from "../store";

interface Props {
  summary: ScanSummary | null;
  logs: UILogEntry[];
  conn: ConnState;
  swVersion: string | null;
  lastPong: number | null;
  sentCount: number;
  ping: () => void;
}

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "соединение…",
  open: "SW отвечает",
  closed: "SW НЕДОСТУПЕН",
};

/** Отладочная панель: состояние соединения + сводка скана + живой лог. */
export function DebugPanel({ summary, logs, conn, swVersion, lastPong, sentCount, ping }: Props) {
  const [open, setOpen] = useState(conn === "closed" || sentCount > 0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (boxRef.current && open) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs.length, open]);

  const exportLog = () => {
    downloadTextFile("ide-debug.log", buildDebugLog(logs), "text/plain;charset=utf-8");
  };
  const copyLog = async () => {
    await navigator.clipboard.writeText(buildDebugLog(logs));
  };

  return (
    <section className="card debug-panel">
      <h2>
        <button className="btn ghost small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "▾" : "▸"}
        </button>
        Отладка
        <span className={`conn-chip ${conn}`}>{CONN_LABEL[conn]}</span>
        {swVersion && <span className="muted"> v{swVersion}</span>}
      </h2>

      {!open && <p className="hint">Состояние соединения, сводка последнего скана и лог событий.</p>}

      {open && (
        <>
          {conn === "closed" && (
            <div className="error-banner">
              Service worker недоступен — панель не получает ответы. Нажмите «Проверить соединение»; если не поможет:
              edge://extensions → карточка расширения → «Перезагрузить» (или закройте и откройте панель заново).
            </div>
          )}

          <div className="btn-group" style={{ margin: "6px 0" }}>
            <button className="btn small" onClick={ping}>Проверить соединение (ping)</button>
            <button className="btn small" onClick={copyLog}>Копировать лог</button>
            <button className="btn small" onClick={exportLog}>Скачать лог файл</button>
            <span className="muted">
              отправлено: {sentCount} · получено: {logs.filter((l) => l.level === "INFO" || l.level === "ERROR" || l.level === "WARN").length}
              {lastPong ? ` · последний pong: ${new Date(lastPong).toLocaleTimeString()}` : ""}
            </span>
          </div>

          {summary && (
            <div className={`scan-summary ${summary.ok ? "ok" : "fail"}`}>
              <div className="summary-row">
                <b>{summary.ok ? "✓ Скан выполнен" : "✗ Скан не выполнен"}</b>
                {summary.timeMs > 0 && <span className="muted">за {summary.timeMs}ms</span>}
              </div>
              {summary.tabUrl && <div className="summary-row muted">URL: {summary.tabUrl}</div>}
              {summary.error && <div className="error-text">{summary.error}</div>}
              {summary.ok && summary.stats && (
                <>
                  <div className="summary-grid">
                    <div><b>{summary.hits}</b><span>кандидатов (уникальных)</span></div>
                    <div><b>{summary.stats.imgElements}</b><span>элементов &lt;img&gt;</span></div>
                    <div><b>{summary.links}</b><span>ссылок</span></div>
                    <div><b>{summary.candidates}</b><span>добавлено в задачу</span></div>
                    <div><b>{summary.stats.shadowRootsOpened}</b><span>shadow roots (открытых)</span></div>
                    <div><b>{summary.stats.canvasElements}</b><span>canvas (не читаются)</span></div>
                    <div><b>{summary.stats.autoScrollSteps}</b><span>шагов автоскролла</span></div>
                    <div><b>{summary.stats.mutationHits}</b><span>найдено мониторингом</span></div>
                  </div>
                  <div className="summary-row">
                    <span>По типам: </span>
                    <span className="mono">
                      {Object.entries(summary.stats.sourceTypeCounts)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(" · ") || "(пусто)"}
                    </span>
                  </div>
                  {summary.hits === 0 && (
                    <div className="hint warn-text">
                      Кандидатов 0. Проверьте: страница позволяет сканирование (не edge://), контент не в закрытых
                      shadow roots, изображения не рисуются на canvas. Попробуйте «Прокручивать страницу» и
                      «Следить за динамическим контентом» перед поиском.
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="log-box" ref={boxRef}>
            {logs.length === 0 && <div className="muted">Лог пуст. Выполните поиск, чтобы увидеть события (строки «[панель]» появляются сразу при нажатии кнопок).</div>}
            {logs.slice(-80).map((l, i) => (
              <div key={i} className={`log-line ${l.level.toLowerCase()}`}>
                <span className="muted">{new Date(l.time).toLocaleTimeString()}</span> [{l.level}] {l.message}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}