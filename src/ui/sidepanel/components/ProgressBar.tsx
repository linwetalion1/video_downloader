import { useEffect, useState } from "react";
import { formatBytes, formatCount } from "../../../shared/utils";
import type { PanelState } from "../store";

/** Прогресс с детализацией ожидания (бэк-офф, rate-limit, retry). */
export function ProgressBar({ state }: { state: PanelState }) {
  const pages = state.stats.pagesVisited;
  const maxPages = state.settings.maxPages;
  const busy = state.status === "running" || state.status === "paused";
  const pctPages = maxPages > 0 ? Math.min(100, (pages / maxPages) * 100) : 0;
  const totalTasks = state.taskCounts.total || 1;
  const doneTasks = state.taskCounts.completed + state.taskCounts.failed + state.taskCounts.skipped;
  const pctTasks = Math.min(100, (doneTasks / totalTasks) * 100);
  const pctDown = state.candidates.length > 0 ? Math.min(100, (state.stats.downloadsCompleted / Math.max(1, state.candidates.filter((c) => c.selected).length || state.candidates.length)) * 100) : 0;

  // Оценка оставшегося времени: queued * avgDelay / concurrency
  const avgPageDelay = (state.settings.pageDelayMin + state.settings.pageDelayMax) / 2;
  const avgImgDelay = (state.settings.imageDelayMin + state.settings.imageDelayMax) / 2;
  const avgDlDelay = (state.settings.downloadDelayMin + state.settings.downloadDelayMax) / 2;
  const avgDelay = (avgPageDelay + avgImgDelay + avgDlDelay) / 3 || 800;
  const estMs = busy && state.taskCounts.queued > 0 ? Math.round((state.taskCounts.queued * avgDelay) / Math.max(1, state.settings.concurrency)) : 0;
  const estText = estMs > 0 ? `~${Math.ceil(estMs / 1000)}с осталось` : "";
  const qbt = (state as unknown as { queueByType?: Record<string, number> }).queueByType;
  const limiter = (state as unknown as { limiterInfo?: { page: string; image: string; download: string } }).limiterInfo;
  const retryMs = (state as unknown as { msUntilNextRetry?: number }).msUntilNextRetry;

  // Живой индикатор ожидания из логов (последний DEBUG с ⏳)
  const lastWaitLog = [...state.logs].reverse().find((l) => l.message.includes("⏳ Ждём"));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  return (
    <div className="progress-wrap">
      <div className="progress-section">
        <div className="progress-label muted">Страницы <span>{pages}/{maxPages}</span> {estText && <span className="busy">· {estText}</span>}</div>
        <div className="progress-track" role="progressbar" aria-valuenow={Math.round(pctPages)} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-fill" style={{ width: `${pctPages}%` }} />
        </div>
      </div>
      <div className="progress-section">
        <div className="progress-label muted">Задачи <span>{doneTasks}/{totalTasks}</span> · очередь {state.taskCounts.queued} · {state.taskCounts.running} в работе {state.taskCounts.failed > 0 && `· ❌ ${state.taskCounts.failed}`} {state.taskCounts.skipped > 0 && `· ⏭ ${state.taskCounts.skipped}`}</div>
        <div className="progress-track small" role="progressbar" aria-valuenow={Math.round(pctTasks)} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-fill secondary" style={{ width: `${pctTasks}%` }} />
        </div>
      </div>
      {state.candidates.length > 0 && (
        <div className="progress-section">
          <div className="progress-label muted">Скачано <span>{state.stats.downloadsCompleted}/{formatCount(state.candidates.filter((c) => c.selected).length || state.candidates.length)}</span> · {formatBytes(state.stats.downloadBytes)}</div>
          <div className="progress-track small" role="progressbar" aria-valuenow={Math.round(pctDown)} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill success" style={{ width: `${pctDown}%` }} />
          </div>
        </div>
      )}
      <div className="progress-meta">
        <span>Изображений: {formatCount(state.candidates.length)}</span>
        <span>Ошибок: {state.stats.errors}</span>
        {busy && (
          <span className="busy">
            {state.status === "paused" ? "⏸ пауза" : "⏳ в работе"}
            {state.taskCounts.running > 0 && ` · ${state.taskCounts.running} задач`}
          </span>
        )}
      </div>
      {qbt && (
        <div className="progress-sub muted">
          По типам: DISCOVERY {qbt.PAGE_DISCOVERY ?? 0} · SCAN {qbt.PAGE_SCAN ?? 0} · META {qbt.IMAGE_METADATA ?? 0} · DL {qbt.IMAGE_DOWNLOAD ?? 0}
        </div>
      )}
      {limiter && busy && (
        <div className="progress-sub muted" title="Текущие задержки rate-limiter">
          Лимиты: page {limiter.page} · img {limiter.image} · dl {limiter.download} {retryMs != null && retryMs > 0 && `· retry через ${Math.round(retryMs)}ms`}
        </div>
      )}
      {lastWaitLog && busy && (
        <div className="progress-wait muted" title={new Date(lastWaitLog.time).toLocaleTimeString()}>
          {lastWaitLog.message} · {Math.round((now - lastWaitLog.time) / 1000)}с назад
        </div>
      )}
      <div className="progress-sub muted">
        Очередь: ожидают {state.taskCounts.queued}, успешно {state.taskCounts.completed}, ошибки {state.taskCounts.failed}, пропущено {state.taskCounts.skipped}
        {state.taskCounts.cancelled > 0 && `, отменено ${state.taskCounts.cancelled}`}
        {estText && ` · ${estText}`}
      </div>
    </div>
  );
}