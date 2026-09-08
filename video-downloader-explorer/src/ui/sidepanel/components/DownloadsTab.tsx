// Вкладка "Загрузки" — очередь, прогресс, активные операции.
import type { State } from "../store";
import type { PanelToWorkerMsg, VideoCandidate } from "../../../shared/types";
import { formatBytes, formatCount, formatTimeAgo } from "../../../shared/utils";

export function DownloadsTab({ state, send }: { state: State; send: (m: PanelToWorkerMsg) => void }) {
  const cands = state.view.candidates;
  const active = cands.filter((c) => c.status === "downloading" || c.status === "checking" || c.status === "queued");
  const done = cands.filter((c) => c.status === "downloaded");
  const failed = cands.filter((c) => c.status === "failed");
  const skipped = cands.filter((c) => c.status === "skipped");
  const stats = state.view.stats;
  const counts = state.view.taskCounts;

  return (
    <div className="downloads-tab">
      <div className="downloads-summary">
        <Card label="В работе" value={formatCount(active.length)} hl={active.length > 0} />
        <Card label="В очереди" value={formatCount(counts.queued)} />
        <Card label="Скачано" value={formatCount(done.length)} ok={done.length > 0} />
        <Card label="Ошибки" value={formatCount(failed.length)} err={failed.length > 0} />
        <Card label="Пропущено" value={formatCount(skipped.length)} />
        <Card label="Объём" value={formatBytes(stats.totalBytes)} />
        {stats.msUntilNextRetry > 0 && (
          <Card label="До retry" value={`${Math.ceil(stats.msUntilNextRetry / 1000)} с`} warn />
        )}
      </div>

      <div className="downloads-controls">
        <button className="btn sm" onClick={() => send({ type: "VDE_PAUSE" })} disabled={state.view.status !== "running"}>⏸ Пауза</button>
        <button className="btn sm" onClick={() => send({ type: "VDE_RESUME" })} disabled={state.view.status !== "paused"}>▶ Продолжить</button>
        <button className="btn sm" onClick={() => send({ type: "VDE_CANCEL_DOWNLOAD" })} disabled={!active.length}>⏹ Отменить всё</button>
        <button className="btn sm" onClick={() => send({ type: "VDE_RETRY" })} disabled={!failed.length}>↻ Повторить все ошибки</button>
        <button className="btn sm danger" onClick={() => { if (confirm("Очистить текущую задачу?")) send({ type: "VDE_CLEAR_JOB" }); }}>🗑 Очистить</button>
      </div>

      {active.length > 0 && (
        <Section title="Активные операции">
          {active.map((c) => <ActiveRow key={c.id} candidate={c} send={send} />)}
        </Section>
      )}

      {done.length > 0 && (
        <Section title={`Скачано (${done.length})`}>
          {done.map((c) => <DoneRow key={c.id} candidate={c} />)}
        </Section>
      )}

      {failed.length > 0 && (
        <Section title={`Ошибки (${failed.length})`} err>
          {failed.map((c) => <FailedRow key={c.id} candidate={c} send={send} />)}
        </Section>
      )}

      {cands.length === 0 && (
        <div className="empty">
          <div className="empty-icon">📥</div>
          <p>Здесь будут отображаться активные и завершённые загрузки.</p>
          <p className="muted">Скачайте вкладку «Результаты», выберите видео и нажмите «Скачать».</p>
        </div>
      )}
    </div>
  );
}

function Section({ title, err, children }: { title: string; err?: boolean; children: React.ReactNode }) {
  return (
    <details className="section" open>
      <summary className={err ? "err" : ""}>{title}</summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

function Card({ label, value, ok, err, warn, hl }: { label: string; value: string; ok?: boolean; err?: boolean; warn?: boolean; hl?: boolean }) {
  return (
    <div className={`summary-card ${ok ? "ok" : err ? "err" : warn ? "warn" : ""} ${hl ? "hl" : ""}`}>
      <div className="sc-label">{label}</div>
      <div className="sc-value">{value}</div>
    </div>
  );
}

function ActiveRow({ candidate: c, send }: { candidate: VideoCandidate; send: (m: PanelToWorkerMsg) => void }) {
  const pct = Math.round((c.progress || 0) * 100);
  return (
    <div className="row active">
      <div className="row-main">
        <div className="row-title" title={c.videoUrl}>{c.title || c.videoUrl.slice(0, 60)}</div>
        <div className="row-meta">
          <span className={`container-badge ${c.container}`}>{c.container.toUpperCase()}</span>
          {c.receivedBytes !== undefined && c.receivedBytes > 0 && (
            <span className="muted">{formatBytes(c.receivedBytes)}{c.fileSize ? ` / ${formatBytes(c.fileSize)}` : ""}</span>
          )}
          <span className="muted">{c.message || c.phase}</span>
        </div>
        <div className="bar">
          <div className="bar-fill" style={{ width: `${pct}%` }} />
          <div className="bar-text">{pct}%</div>
        </div>
      </div>
      <div className="row-actions">
        <button className="btn sm" onClick={() => send({ type: "VDE_CANCEL_DOWNLOAD", ids: [c.id] })}>⏹</button>
      </div>
    </div>
  );
}

function DoneRow({ candidate: c }: { candidate: VideoCandidate }) {
  return (
    <div className="row done">
      <div className="row-main">
        <div className="row-title">✅ {c.title || c.videoUrl.slice(0, 60)}</div>
        <div className="row-meta">
          <span className="muted">{formatBytes(c.receivedBytes ?? c.fileSize)}</span>
          <span className="muted">{c.message}</span>
          <span className="muted">{formatTimeAgo(c.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

function FailedRow({ candidate: c, send }: { candidate: VideoCandidate; send: (m: PanelToWorkerMsg) => void }) {
  return (
    <div className="row failed">
      <div className="row-main">
        <div className="row-title">❌ {c.title || c.videoUrl.slice(0, 60)}</div>
        <div className="row-meta err">{c.message}</div>
      </div>
      <div className="row-actions">
        <button className="btn sm" onClick={() => send({ type: "VDE_RETRY", ids: [c.id] })}>↻</button>
      </div>
    </div>
  );
}
