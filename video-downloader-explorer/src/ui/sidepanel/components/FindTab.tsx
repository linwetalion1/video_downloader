import type { State } from "../store";
import type { PanelToWorkerMsg } from "../../../shared/types";
import { formatCount } from "../../../shared/utils";

export function FindTab({ state, send }: { state: State; send: (m: PanelToWorkerMsg) => void }) {
  const { view, scanSummary } = state;
  const busy = view.status === "running" || view.status === "paused";

  const onScan = () => {
    send({ type: "VDE_SCAN_PAGE" });
  };

  return (
    <div className="find-tab">
      <div className="hero">
        <div className="hero-icon">🎬</div>
        <h1>Поиск видео на странице</h1>
        <p className="hero-desc">
          Автоматически находит потоки HLS / m3u8, трансляции (VK, YouTube, Twitch и др.),
          файлы MP4, WebM и встроенные плееры.
        </p>
        <button className="btn primary big" onClick={onScan} disabled={busy}>
          {busy ? "⏳ Сканирование…" : "🔍 Найти видео"}
        </button>
      </div>

      {scanSummary && (
        <div className={`summary ${scanSummary.ok ? "ok" : "err"}`}>
          <div className="summary-header">
            <span className="summary-title">{scanSummary.ok ? "✅ Сканирование завершено" : "❌ Ошибка сканирования"}</span>
            <span className="summary-url" title={scanSummary.tabUrl}>{scanSummary.pageTitle || scanSummary.tabUrl}</span>
          </div>

          {scanSummary.ok ? (
            <>
              <div className="summary-quick-stats">
                <span className="stat-pill big">Найдено: <b>{formatCount(scanSummary.candidates)}</b></span>
                {scanSummary.manifestCount > 0 && (
                  <span className="stat-pill hls">HLS / DASH: <b>{scanSummary.manifestCount}</b></span>
                )}
                {scanSummary.drmCount > 0 && (
                  <span className="stat-pill drm">DRM: <b>{scanSummary.drmCount}</b></span>
                )}
                <span className="stat-pill muted">{scanSummary.timeMs} мс</span>
              </div>

              {scanSummary.drmCount > 0 && (
                <div className="summary-note warn">
                  ⚠️ Обнаружены потоки с DRM-защитой. Они помечены и не могут быть скачаны напрямую.
                </div>
              )}
            </>
          ) : (
            <div className="summary-error">
              <p>Не удалось просканировать страницу:</p>
              <code>{scanSummary.error}</code>
            </div>
          )}
        </div>
      )}

      {view.candidates.length === 0 && !scanSummary && (
        <details className="capabilities-details">
          <summary>Поддерживаемые форматы и платформы</summary>
          <div className="capabilities-body">
            <ul>
              <li><b>ВКонтакте (VK Video / Трансляции)</b> — HLS-стримы любой длительности (до 24ч+), прямые MP4 всех качеств (от 240p до 4K).</li>
              <li><b>YouTube, RuTube, Vimeo, Twitch</b> — извлечение потоков и прямых ссылок со страниц плееров.</li>
              <li><b>HLS / m3u8 & DASH / mpd</b> — скачивание чанков с авто-сборкой в MP4 без перекодирования.</li>
              <li><b>HTML5 &lt;video&gt; & WebM / MP4</b> — детекция нативных элементов, включая динамическую подгрузку.</li>
            </ul>
          </div>
        </details>
      )}
    </div>
  );
}

