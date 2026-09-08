// StatusBanner — главный элемент визуализации текущего состояния.
// Показывает: что сейчас делает расширение, какая фаза, сколько ждать,
// и какие ошибки последние.
import type { State } from "../store";
import { formatBytes, formatCount, formatTimeAgo } from "../../../shared/utils";

export function StatusBanner({ state }: { state: State }) {
  const { view } = state;
  const status = view.status;
  const stats = view.stats;
  const counts = view.taskCounts;

  const phaseInfo = describePhase(status, stats.activeTask, view.activeMessage);

  const isError = status === "failed";
  const isSuccess = status === "completed";
  const isWorking = status === "running" || status === "paused";

  return (
    <div className={`status-banner ${isError ? "err" : isSuccess ? "ok" : isWorking ? "work" : "idle"}`}>
      <div className="status-row">
        <div className="status-pill" data-status={status}>
          {phaseInfo.icon} <span>{phaseInfo.label}</span>
        </div>
        <div className="status-active" title={state.activeBanner || view.activeMessage}>
          {state.activeBanner || view.activeMessage}
        </div>
        {stats.backoffFactor > 1 && (
          <div className="status-backoff" title="Сервер ограничивает скорость — задержки увеличены">
            backoff ×{stats.backoffFactor.toFixed(2)}
          </div>
        )}
      </div>

      <div className="status-progress-row">
        <Stat label="Найдено" value={formatCount(stats.totalFound)} />
        <Stat label="Проверено" value={`${stats.totalChecked}/${formatCount(stats.totalFound)}`} />
        <Stat label="В работе" value={formatCount(counts.running)} />
        <Stat label="В очереди" value={formatCount(counts.queued)} />
        <Stat label="Скачано" value={formatCount(stats.totalDownloaded)} ok={stats.totalDownloaded > 0} />
        <Stat label="Ошибки" value={formatCount(stats.totalFailed)} err={stats.totalFailed > 0} />
        <Stat label="Объём" value={formatBytes(stats.totalBytes)} />
        {stats.activeCandidateId && (
          <Stat label="Активно" value={stats.activeTask || "…"} highlight />
        )}
      </div>

      {stats.activeTask && stats.activeCandidateId && (
        <ProgressBar
          progress={view.candidates.find((c) => c.id === stats.activeCandidateId)?.progress ?? 0}
          message={view.candidates.find((c) => c.id === stats.activeCandidateId)?.message || "…"}
        />
      )}

      {view.errors.length > 0 && (
        <details className="status-errors" open>
          <summary>Последние ошибки ({view.errors.length})</summary>
          <ul>
            {view.errors.slice(-3).map((e, i) => (
              <li key={i}>
                <span className="err-time">{formatTimeAgo(e.time)}</span>
                <span className="err-msg">{e.message}</span>
                {e.url && <code className="err-url">{e.url.slice(0, 80)}</code>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {!state.connected && (
        <div className="status-warning">
          ⚠️ Service worker не отвечает. Панель автоматически перезагрузится при восстановлении.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, ok, err, highlight }: { label: string; value: string; ok?: boolean; err?: boolean; highlight?: boolean }) {
  return (
    <div className={`stat ${ok ? "ok" : err ? "err" : ""} ${highlight ? "hl" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function ProgressBar({ progress, message }: { progress: number; message: string }) {
  const pct = Math.max(0, Math.min(1, progress || 0));
  return (
    <div className="progress-row">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct * 100}%` }} />
        <div className="progress-label">{Math.round(pct * 100)}%</div>
      </div>
      <div className="progress-msg">{message}</div>
    </div>
  );
}

function describePhase(status: string, active: string | null, message: string): { icon: string; label: string } {
  if (status === "idle") return { icon: "💤", label: "Готов" };
  if (status === "completed") return { icon: "✅", label: "Готово" };
  if (status === "cancelled") return { icon: "⛔", label: "Отменено" };
  if (status === "failed") return { icon: "❌", label: "Ошибка" };
  if (status === "paused") return { icon: "⏸", label: "Пауза" };
  if (status === "running") {
    if (active === "VIDEO_METADATA") return { icon: "🔍", label: "Метаданные" };
    if (active === "VIDEO_DOWNLOAD") return { icon: "⬇", label: "Скачивание" };
    if (active === "HLS_PARSE" || active === "HLS_DOWNLOAD") return { icon: "📜", label: "HLS" };
    if (active === "DASH_PARSE" || active === "DASH_DOWNLOAD") return { icon: "📜", label: "DASH" };
    if (active === "BLOB_DOWNLOAD") return { icon: "🫧", label: "Blob" };
    if (active === "VIDEO_SCAN") return { icon: "🔎", label: "Скан" };
    return { icon: "⚙", label: "Работает" };
  }
  return { icon: "…", label: status };
}
