// Вкладка "Лог" — экстенсивный лог всех событий с фильтрами.
import { useMemo, useState } from "react";
import type { State } from "../store";
import { formatTimeAgo } from "../../../shared/utils";
import type { LogCategory, LogLevel } from "../../../shared/types";

const ALL_LEVELS: LogLevel[] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
const ALL_CATS: LogCategory[] = ["scan", "manifest", "metadata", "download", "queue", "perm", "http", "blob", "ui", "sw", "general"];

export function LogsTab({ state }: { state: State }) {
  const [minLevel, setMinLevel] = useState<LogLevel>("INFO");
  const [cats, setCats] = useState<Set<LogCategory>>(new Set(ALL_CATS));
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const min = ALL_LEVELS.indexOf(minLevel);
    const q = filter.toLowerCase();
    return (state.logs || []).filter((e) => {
      if (!e || !e.level) return false;
      if (ALL_LEVELS.indexOf(e.level) < min) return false;
      if (!e.category || !cats.has(e.category)) return false;
      if (q && (!e.message || !e.message.toLowerCase().includes(q)) && !(e.ref?.id || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [state.logs, minLevel, cats, filter]);

  const downloadLog = () => {
    const text = filtered.map((e) => `[${new Date(e.time).toISOString()}] [${e.level}] [${e.category}] ${e.message}`).join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `vde-log-${Date.now()}.txt`, conflictAction: "uniquify", saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const clearLog = () => {
    chrome.storage.local.remove("vde:logs");
    location.reload();
  };

  return (
    <div className="logs-tab">
      <div className="logs-toolbar">
        <select value={minLevel} onChange={(e) => setMinLevel(e.target.value as LogLevel)}>
          {ALL_LEVELS.map((l) => <option key={l} value={l}>{l}+</option>)}
        </select>
        <input className="search" type="search" placeholder="Поиск по сообщению / ref…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn sm" onClick={downloadLog}>💾 Скачать лог</button>
        <button className="btn sm danger" onClick={clearLog}>🗑 Очистить</button>
      </div>

      <div className="logs-cats">
        {ALL_CATS.map((c) => (
          <button key={c} className={`chip ${cats.has(c) ? "active" : ""}`} onClick={() => {
            const next = new Set(cats);
            if (next.has(c)) next.delete(c); else next.add(c);
            setCats(next);
          }}>{c}</button>
        ))}
      </div>

      <div className="logs-list">
        {filtered.length === 0 ? (
          <div className="empty">Лог пуст. Сделайте скан.</div>
        ) : (
          filtered.slice(-300).reverse().map((e, i) => (
            <div key={i} className={`log-line level-${e.level.toLowerCase()}`}>
              <span className="log-time">{formatTimeAgo(e.time)}</span>
              <span className="log-level">{e.level}</span>
              <span className="log-cat">{e.category}</span>
              <span className="log-msg">{e.message}</span>
              {e.ref && <span className="log-ref">{e.ref.kind}:{e.ref.id.slice(-6)}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
