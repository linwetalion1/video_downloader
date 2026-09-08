// Компактный StatusBanner: активен только при операциях или предупреждениях,
// не загромождает экран в режиме ожидания.
import type { State } from "../store";

export function StatusBanner({ state }: { state: State }) {
  const { view } = state;
  const status = view.status;
  const stats = view.stats;
  const isWorking = status === "running" || status === "paused";
  const activeCand = stats.activeCandidateId ? view.candidates.find((c) => c.id === stats.activeCandidateId) : null;

  // Если всё спокойно и нет активной работы — не занимаем драгоценное место
  if (!isWorking && state.connected && view.errors.length === 0) {
    return null;
  }

  const phaseInfo = describePhase(status, stats.activeTask);
  const progressPct = Math.round(((activeCand?.progress ?? 0) * 100));

  return (
    <div className={`status-banner ${isWorking ? "work" : status === "failed" ? "err" : "idle"}`}>
      {!state.connected ? (
        <div className="status-warning">
          ⚠️ Фоновый процесс перезапускается…
        </div>
      ) : isWorking ? (
        <div className="status-work-row">
          <div className="status-work-left">
            <span className="status-work-icon">{phaseInfo.icon}</span>
            <div className="status-work-info">
              <span className="status-work-msg">
                {activeCand?.message || view.activeMessage || phaseInfo.label}
              </span>
              {progressPct > 0 && <span className="status-work-pct">{progressPct}%</span>}
            </div>
          </div>
          {stats.backoffFactor > 1 && (
            <span className="status-backoff-badge" title="Сервер снижает скорость запросов">
              slowdown ×{stats.backoffFactor.toFixed(1)}
            </span>
          )}
          {progressPct > 0 && (
            <div className="mini-progress-track">
              <div className="mini-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          )}
        </div>
      ) : view.errors.length > 0 ? (
        <div className="status-compact-error">
          <span className="err-icon">⚠️</span>
          <span className="err-text">{view.errors[view.errors.length - 1].message}</span>
        </div>
      ) : null}
    </div>
  );
}

function describePhase(status: string, active: string | null): { icon: string; label: string } {
  if (status === "paused") return { icon: "⏸", label: "Пауза" };
  if (active === "VIDEO_METADATA") return { icon: "🔍", label: "Проверка видео…" };
  if (active === "VIDEO_DOWNLOAD" || active === "HLS_DOWNLOAD") return { icon: "⬇", label: "Скачивание…" };
  if (active === "VIDEO_SCAN") return { icon: "🔎", label: "Поиск видео…" };
  return { icon: "⚙", label: "Обработка…" };
}
