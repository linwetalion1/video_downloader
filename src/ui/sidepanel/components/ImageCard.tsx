import type { ImageCandidate } from "../../../shared/types";
import { formatBytes } from "../../../shared/utils";

interface Props {
  candidate: ImageCandidate;
  compact: boolean;
  list: boolean;
  onPreview: () => void;
  onToggle: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  discovered: "найдено",
  checking: "проверка…",
  ready: "готово",
  failed: "ошибка",
  downloaded: "✓ скачано",
  skipped: "пропущено",
};

export function ImageCard({ candidate: c, compact, list, onPreview, onToggle }: Props) {
  const dims = c.width && c.height ? `${c.width} × ${c.height}` : "размер неизвестен";

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === " ") {
      e.preventDefault();
      onToggle();
    } else if (e.key === "Enter") {
      onPreview();
    }
  };

  if (list) {
    return (
      <div className={`card list-row ${c.selected ? "selected" : ""} ${c.status}`}>
        <label className="check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={c.selected} onChange={onToggle} aria-label="Выбрать" />
        </label>
        <div className="list-thumb" onClick={onPreview} role="button" tabIndex={0} onKeyDown={handleKey}>
          <PreviewImg url={c.imageUrl} alt={c.alt || "preview"} status={c.status} />
        </div>
        <div className="list-main" onClick={onPreview} role="button" tabIndex={0} onKeyDown={handleKey}>
          <div className="list-title">{c.title || c.alt || c.imageUrl}</div>
          <div className="meta-line">
            <span>{dims}</span>
            <span>{c.fileSize !== undefined ? formatBytes(c.fileSize) : "—"}</span>
            <span className="ext-badge">{(c.extension || "?").toUpperCase()}</span>
            <span>depth: {c.depth}</span>
            <span className="muted">{c.sourceDomain}</span>
            <span className={`status-badge ${c.status}`}>{STATUS_LABEL[c.status]}</span>
          </div>
          {c.error && <div className="error-text" title={c.error}>{c.error}</div>}
        </div>
        <button className="btn small" onClick={onPreview}>∧</button>
      </div>
    );
  }

  return (
    <div
      className={`card ${compact ? "compact" : "grid"} ${c.selected ? "selected" : ""} ${c.status}`}
      style={{ width: compact ? 140 : 220 }}
      role="button"
      tabIndex={0}
      aria-label={`${dims}, ${formatBytes(c.fileSize)}`}
      onKeyDown={handleKey}
    >
      <div className="thumb" onClick={onPreview}>
        <PreviewImg url={c.imageUrl} alt={c.alt || "preview"} status={c.status} />
        <label className="check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={c.selected} onChange={onToggle} aria-label="Выбрать" />
        </label>
        <span className="depth-badge">d{c.depth}</span>
        <span className="ext-badge">{(c.extension || "?").toUpperCase()}</span>
      </div>
      <div className="card-meta">
        {compact ? (
          <div className="meta-line">
            <span>{dims}</span>
          </div>
        ) : (
          <>
            <div className="meta-line">
              <span>{dims}</span>
              <span>{c.fileSize !== undefined ? formatBytes(c.fileSize) : "—"}</span>
            </div>
            <div className="meta-line muted">
              <span>{c.sourceDomain}</span>
            </div>
            <div className={`status-badge ${c.status}`}>{STATUS_LABEL[c.status]}</div>
            {c.error && <div className="error-text" title={c.error}>{c.error}</div>}
          </>
        )}
      </div>
    </div>
  );
}

function PreviewImg({ url, alt, status }: { url: string; alt: string; status: string }) {
  return (
    <div className="thumb-wrap">
      <img
        src={url}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        decoding="async"
        onError={(e) => {
          const img = e.currentTarget;
          img.style.display = "none";
          img.parentElement?.classList.add("img-error");
        }}
      />
      <span className="thumb-empty">Нет доступа / ошибка</span>
      {status === "downloaded" && <span className="done-overlay">✓</span>}
    </div>
  );
}