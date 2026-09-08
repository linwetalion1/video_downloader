import { useEffect, useState } from "react";
import type { ImageCandidate } from "../../../shared/types";
import { formatBytes } from "../../../shared/utils";
import { usePanel } from "../store";

interface Props {
  candidate: ImageCandidate;
  onClose: () => void;
}

/** Увеличенный просмотр (ТЗ §5): оригинал, URL, размеры, вес, формат, источник, действия. */
export function ImageModal({ candidate: c, onClose }: Props) {
  const panel = usePanel();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyUrl = async () => {
    await navigator.clipboard.writeText(c.imageUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const openOriginal = () => {
    void chrome.tabs.create({ url: c.imageUrl });
  };

  const downloadOne = () => {
    panel.send({ type: "IDE_DOWNLOAD_SELECTED", ids: [c.id] });
  };

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Просмотр изображения">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close btn" onClick={onClose} aria-label="Закрыть">✕</button>
        <div className="modal-img-wrap">
          <img src={c.imageUrl} alt={c.alt || "preview"} referrerPolicy="no-referrer" />
        </div>
        <div className="modal-info">
          <h3>{c.title || c.alt || "Изображение"}</h3>
          <dl className="meta-dl">
            <dt>Размеры</dt><dd>{c.width && c.height ? `${c.width} × ${c.height}` : "неизвестен"}</dd>
            <dt>Вес</dt><dd>{c.fileSize !== undefined ? formatBytes(c.fileSize) : "—"}</dd>
            <dt>Формат</dt><dd>{(c.extension || c.mimeType || "?").toUpperCase()}</dd>
            <dt>Глубина</dt><dd>{c.depth}</dd>
            <dt>Источник</dt>
            <dd>
              <a href={c.sourcePageUrl} onClick={(e) => { e.preventDefault(); void chrome.tabs.create({ url: c.sourcePageUrl }); }} title={c.sourcePageUrl}>
                {new URL(c.sourcePageUrl).hostname}/… (открыть страницу)
              </a>
            </dd>
            <dt>URL</dt><dd className="url-cell" title={c.imageUrl}>{c.imageUrl}</dd>
          </dl>
          {c.error && <div className="error-text">{c.error}</div>}
          <div className="modal-actions">
            <button className="btn primary" onClick={downloadOne}>Скачать</button>
            <button className="btn" onClick={openOriginal}>Открыть оригинал</button>
            <button className="btn" onClick={() => void copyUrl()}>{copied ? "✓ Скопировано" : "Копировать URL"}</button>
          </div>
          {c.variants.length > 1 && (
            <div className="variants">
              <span className="muted">Варианты URL:</span>
              {c.variants.map((v) => (
                <button key={v.url} className="chip" title={v.url} onClick={() => void navigator.clipboard.writeText(v.url)}>
                  {v.width ? `${v.width}px` : v.url.slice(0, 60)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}