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
        <h1>Скачать любое видео с текущей страницы</h1>
        <p>
          Находит <code>&lt;video&gt;</code>, HLS / DASH, blob, встроенные плееры (YouTube, Vimeo, VK, RuTube, Twitch, TikTok, Instagram и др.).
          Показывает превью, метаданные, очередь, прогресс.
        </p>
        <button className="btn primary big" onClick={onScan} disabled={busy}>
          {busy ? "⏳ Идёт работа…" : "🔍 Сканировать страницу"}
        </button>
      </div>

      {scanSummary && (
        <div className={`summary ${scanSummary.ok ? "ok" : "err"}`}>
          <div className="summary-header">
            <h2>{scanSummary.ok ? "Результат скана" : "Ошибка скана"}</h2>
            <span className="summary-url" title={scanSummary.tabUrl}>{scanSummary.pageTitle || scanSummary.tabUrl}</span>
          </div>
          {scanSummary.ok ? (
            <>
              <div className="summary-stats">
                <Pill label="Кандидатов" value={formatCount(scanSummary.candidates)} big />
                <Pill label="Hits" value={formatCount(scanSummary.hits)} />
                <Pill label="Манифестов" value={formatCount(scanSummary.manifestCount)} warn={scanSummary.manifestCount > 0} />
                <Pill label="Blob" value={formatCount(scanSummary.blobCount)} warn={scanSummary.blobCount > 0} />
                <Pill label="DRM" value={formatCount(scanSummary.drmCount)} err={scanSummary.drmCount > 0} />
                <Pill label="Время" value={`${scanSummary.timeMs} мс`} />
              </div>
              {Object.keys(scanSummary.byType).length > 0 && (
                <div className="summary-breakdown">
                  <h3>По источникам</h3>
                  <div className="breakdown">
                    {Object.entries(scanSummary.byType).map(([k, v]) => (
                      <div key={k} className="breakdown-row">
                        <span className="breakdown-key">{k}</span>
                        <span className="breakdown-bar"><span style={{ width: `${Math.min(100, (v as number) * 12)}%` }} /></span>
                        <span className="breakdown-val">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {Object.keys(scanSummary.byContainer).length > 0 && (
                <div className="summary-breakdown">
                  <h3>По контейнерам</h3>
                  <div className="breakdown">
                    {Object.entries(scanSummary.byContainer).map(([k, v]) => (
                      <div key={k} className="breakdown-row">
                        <span className="breakdown-key">{k}</span>
                        <span className="breakdown-bar"><span style={{ width: `${Math.min(100, (v as number) * 12)}%` }} /></span>
                        <span className="breakdown-val">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {scanSummary.drmCount > 0 && (
                <div className="summary-note warn">
                  ⚠️ {scanSummary.drmCount} видео с DRM (Widevine/PlayReady/FairPlay). Скачивание недоступно — это защита правообладателя.
                </div>
              )}
            </>
          ) : (
            <div className="summary-error">
              <p>Не удалось просканировать страницу.</p>
              <code>{scanSummary.error}</code>
            </div>
          )}
        </div>
      )}

      {view.candidates.length === 0 && !scanSummary && (
        <div className="hints">
          <h3>Что умеет</h3>
          <ul>
            <li><b>HTML5 &lt;video&gt;</b> — все нативные плееры, включая lazy-load и shadow DOM</li>
            <li><b>HLS / DASH</b> — раскрывает master playlist и предлагает выбрать качество</li>
            <li><b>blob: / data:</b> — скачивает встроенные blob-видео целиком (до 2 ГБ)</li>
            <li><b>YouTube / Vimeo / VK / OK / RuTube / Twitch / TikTok / Instagram / Twitter / Bilibili / Reddit / 9GAG</b> и др. — извлекает прогрессивные/HLS ссылки прямо из публичных JSON-блобов страницы</li>
            <li><b>Performance API</b> — ловит уже загруженные браузером видео</li>
            <li><b>Плеерные фреймворки</b> — HLS.js, dash.js, Video.js, JWPlayer, Plyr, Clappr, Shaka, Brightcove, Vidyard, Kaltura, Wistia</li>
          </ul>
          <h3>Не пытается</h3>
          <ul>
            <li>Обходить DRM (Widevine, PlayReady, FairPlay, SAMPLE-AES) — такие видео помечаются «DRM»</li>
            <li>Ломать CSP, обходить авторизацию или обходить CAPTCHA</li>
            <li>Передавать cookies без явного opt-in</li>
          </ul>
        </div>
      )}
    </div>
  );
}

function Pill({ label, value, big, warn, err }: { label: string; value: string | number; big?: boolean; warn?: boolean; err?: boolean }) {
  return (
    <div className={`pill ${big ? "big" : ""} ${warn ? "warn" : ""} ${err ? "err" : ""}`}>
      <div className="pill-label">{label}</div>
      <div className="pill-value">{value}</div>
    </div>
  );
}
