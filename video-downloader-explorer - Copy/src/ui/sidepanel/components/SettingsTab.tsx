// Настройки.
import type { State } from "../store";
import type { PanelToWorkerMsg, Settings } from "../../../shared/types";
import { CONCURRENCY_OPTIONS } from "../../../shared/constants";

export function SettingsTab({ state, send }: { state: State; send: (m: PanelToWorkerMsg) => void }) {
  const s = state.settings;
  if (!s) return <div className="empty">Загрузка…</div>;
  const update = (patch: Partial<Settings>) => send({ type: "VDE_UPDATE_SETTINGS", settings: patch });

  return (
    <div className="settings-tab">
      <Section title="Сканирование">
        <Row label="Прокрутка для lazy-load">
          <input type="checkbox" checked={s.autoScroll} onChange={(e) => update({ autoScroll: e.target.checked })} />
        </Row>
        <Row label="Окно MutationObserver, мс">
          <input type="number" min={0} step={500} value={s.monitorMs} onChange={(e) => update({ monitorMs: parseInt(e.target.value) || 0 })} />
        </Row>
        <Row label="Сканировать iframe-плееры">
          <input type="checkbox" checked={s.scanIframes} onChange={(e) => update({ scanIframes: e.target.checked })} />
        </Row>
        <Row label="Детектировать плеерные фреймворки">
          <input type="checkbox" checked={s.detectPlayers} onChange={(e) => update({ detectPlayers: e.target.checked })} />
        </Row>
        <Row label="Детектировать соцсети (YouTube, Vimeo и т.п.)">
          <input type="checkbox" checked={s.detectSocial} onChange={(e) => update({ detectSocial: e.target.checked })} />
        </Row>
        <Row label="Сниффить performance.getEntriesByType('resource')">
          <input type="checkbox" checked={s.sniffPerfResources} onChange={(e) => update({ sniffPerfResources: e.target.checked })} />
        </Row>
        <Row label="Раскрывать HLS/DASH автоматически">
          <input type="checkbox" checked={s.expandManifests} onChange={(e) => update({ expandManifests: e.target.checked })} />
        </Row>
        <Row label="Скачивать blob: и data: URL">
          <input type="checkbox" checked={s.downloadBlobs} onChange={(e) => update({ downloadBlobs: e.target.checked })} />
        </Row>
      </Section>

      <Section title="Скачивание">
        <Row label="Корневая папка">
          <input type="text" value={s.saveTo} onChange={(e) => update({ saveTo: e.target.value })} />
        </Row>
        <Row label="Структура папок">
          <select value={s.folderMode} onChange={(e) => update({ folderMode: e.target.value as any })}>
            <option value="flat">Плоская</option>
            <option value="domain">По домену</option>
            <option value="page">По домену/странице</option>
          </select>
        </Row>
        <Row label="Шаблон имени файла">
          <input type="text" value={s.filenameTemplate} onChange={(e) => update({ filenameTemplate: e.target.value })} />
        </Row>
        <Row label="Параллелизм">
          <select value={s.concurrency} onChange={(e) => update({ concurrency: parseInt(e.target.value) })}>
            {CONCURRENCY_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Row>
        <Row label="Задержка мин, мс">
          <input type="number" min={0} step={50} value={s.downloadDelayMin} onChange={(e) => update({ downloadDelayMin: parseInt(e.target.value) || 0 })} />
        </Row>
        <Row label="Задержка макс, мс">
          <input type="number" min={0} step={50} value={s.downloadDelayMax} onChange={(e) => update({ downloadDelayMax: parseInt(e.target.value) || 0 })} />
        </Row>
        <Row label="Таймаут скачивания, мс">
          <input type="number" min={1000} step={1000} value={s.downloadTimeout} onChange={(e) => update({ downloadTimeout: parseInt(e.target.value) || 60_000 })} />
        </Row>
        <Row label="Макс. попыток">
          <input type="number" min={0} step={1} value={s.maxRetries} onChange={(e) => update({ maxRetries: parseInt(e.target.value) || 0 })} />
        </Row>
        <Row label="Макс. backoff, мс">
          <input type="number" min={1000} step={1000} value={s.maxBackoffMs} onChange={(e) => update({ maxBackoffMs: parseInt(e.target.value) || 60_000 })} />
        </Row>
        <Row label="Лимит общего объёма, МБ">
          <input type="number" min={0} step={100} value={s.maxTotalDownloadMB} onChange={(e) => update({ maxTotalDownloadMB: parseInt(e.target.value) || 0 })} />
        </Row>
        <Row label="Конфликт имён">
          <select value={s.conflictAction} onChange={(e) => update({ conflictAction: e.target.value as any })}>
            <option value="uniquify">uniquify (image (1).mp4)</option>
            <option value="overwrite">overwrite</option>
            <option value="prompt">prompt</option>
          </select>
        </Row>
        <Row label="Передавать cookies (useCookies)">
          <input type="checkbox" checked={s.useCookies} onChange={(e) => update({ useCookies: e.target.checked })} />
        </Row>
      </Section>

      <Section title="Юридическое">
        <p className="muted small">
          Убедитесь, что вы имеете право на скачивание контента. Расширение не обходит DRM (Widevine, PlayReady, FairPlay, SAMPLE-AES) — такие видео помечаются «DRM» и не скачиваются.
          Не передавайте cookies без необходимости. Не используйте расширение для нарушения авторских прав.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="settings-section" open>
      <summary>{title}</summary>
      <div className="settings-body">{children}</div>
    </details>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <label>{label}</label>
      <div>{children}</div>
    </div>
  );
}
