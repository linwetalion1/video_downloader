import { useState } from "react";
import { DEPTH_OPTIONS, IMAGE_LIMIT_OPTIONS, PAGE_LIMIT_OPTIONS } from "../../../shared/constants";
import { usePanel } from "../store";
import { DebugPanel } from "./DebugPanel";
import { FiltersPanel } from "./FiltersPanel";

export function FindTab({ busy }: { busy: boolean }) {
  const panel = usePanel();
  const { settings } = panel.state;
  const [autoScroll, setAutoScroll] = useState(true);
  const [monitorMs, setMonitorMs] = useState(10000);
  const [showDeep, setShowDeep] = useState(true);

  const patchSettings = (p: Partial<typeof settings>) => panel.send({ type: "IDE_UPDATE_SETTINGS", settings: p });

  const ensureHostPermission = async (): Promise<boolean> => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const url = tab?.url || "";
      if (!url || /^(chrome|edge|about|chrome-extension):/.test(url)) return true;
      const origin = new URL(url).origin + "/*";
      const has = await chrome.permissions.contains({ origins: [origin] });
      if (has) return true;
      // Запрос в контексте жеста sidePanel — Edge показывает системный prompt.
      // Если host_permissions уже в manifest, этот путь не нужен, но оставляем фолбек.
      const granted = await chrome.permissions.request({ origins: [origin] });
      return granted;
    } catch {
      return true; // не блокируем скан, пусть пробует SW (там есть фолбек по activeTab)
    }
  };

  const scanCurrent = async (deep: boolean) => {
    // Важно: запрос разрешений ДОЛЖЕН быть в chain клика (user gesture), иначе Edge не показывает prompt и SW получает "отклонено" без диалога.
    const ok = await ensureHostPermission();
    if (!ok) {
      // SW тоже залогирует, но локально показываем сразу
      panel.send({ type: "IDE_PING" }); // триггер лога
      alert("Доступ к сайту не предоставлен. Откройте edge://extensions → Image Downloader Explorer → «Разрешить доступ к сайту» или «На всех сайтах», затем повторите.");
      return;
    }
    if (deep) {
      let rootUrl = "";
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        rootUrl = tab?.url || "";
      } catch { /* SW возьмёт активную вкладку */ }
      panel.send({ type: "IDE_START_JOB", settings, rootUrl });
    } else {
      panel.send({ type: "IDE_SCAN_PAGE", autoScroll, monitorMs: monitorMs > 0 ? monitorMs : undefined });
    }
  };

  return (
    <div className="tab-body">
      <section className="card">
        <h2>Режим «Только изображения страницы»</h2>
        <p className="hint">Сканирует DOM текущей вкладки: img, srcset, picture, lazy-load, background, meta и прямые ссылки.</p>
        <label className="row">
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          Прокручивать страницу для lazy-load изображений
        </label>
        <label className="row">
          <input type="checkbox" checked={monitorMs > 0} onChange={(e) => setMonitorMs(e.target.checked ? 10000 : 0)} />
          Следить за динамическим контентом (MutationObserver, ограниченное окно)
        </label>
        <button className="btn primary big" disabled={busy} onClick={() => void scanCurrent(false)}>
          Найти изображения на текущей странице
        </button>
      </section>

      <section className="card">
        <h2>
          <button className="btn ghost small" onClick={() => setShowDeep((v) => !v)} aria-expanded={showDeep}>
            {showDeep ? "▾" : "▸"}
          </button>
          Глубокий поиск
        </h2>
        <p className="hint">Рекурсивный обход по ссылкам (глубина 1–2) с учётом robots.txt и ограничений скорости.</p>
        {showDeep && (
          <>
            <div className="grid2">
              <label className="field">
                Глубина обхода
                <select value={settings.maxDepth} onChange={(e) => patchSettings({ maxDepth: Number(e.target.value) })}>
                  {DEPTH_OPTIONS.map((d) => (
                    <option key={d} value={d}>{d === 0 ? "0 — текущая страница" : d === 1 ? "1 уровень" : "2 уровня"}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Максимум страниц
                <select value={settings.maxPages} onChange={(e) => patchSettings({ maxPages: Number(e.target.value) })}>
                  {PAGE_LIMIT_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Максимум изображений
                <select value={settings.maxImages} onChange={(e) => patchSettings({ maxImages: Number(e.target.value) })}>
                  {IMAGE_LIMIT_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                Область обхода
                <select value={settings.scope} onChange={(e) => patchSettings({ scope: e.target.value as typeof settings.scope })}>
                  <option value="origin">Текущий origin</option>
                  <option value="site">Текущий сайт (домен)</option>
                  <option value="all">Разрешить внешние домены</option>
                </select>
              </label>
            </div>
            <label className="row">
              <input
                type="checkbox"
                checked={settings.respectRobotsTxt}
                onChange={(e) => patchSettings({ respectRobotsTxt: e.target.checked })}
              />
              Учитывать robots.txt (best-effort)
            </label>
            <div className="grid2">
              <label className="field">
                Папка сохранения
                <input type="text" value={settings.saveTo} onChange={(e) => patchSettings({ saveTo: e.target.value })} />
                <span className="hint">Подпапка в стандартной папке «Загрузки» Edge (например, <code>Downloads\{settings.saveTo || "images"}</code>). Расширение не имеет доступа к произвольной папке на диске — только через <code>chrome.downloads</code>.</span>
              </label>
              <label className="field">
                Структура папок
                <select value={settings.folderMode} onChange={(e) => patchSettings({ folderMode: e.target.value as typeof settings.folderMode })}>
                  <option value="flat">Все в одну папку</option>
                  <option value="page">Разбить по страницам</option>
                  <option value="domain">Разбить по доменам</option>
                  <option value="depth">Разбить по глубине</option>
                </select>
              </label>
            </div>
            <button className="btn primary big" disabled={busy} onClick={() => void scanCurrent(true)}>
              Глубокий поиск
            </button>
          </>
        )}
      </section>

      <section className="card">
        <h2>Фильтры поиска</h2>
        <FiltersPanel settings={settings} onChange={patchSettings} />
      </section>

      {panel.state.scanSummary && !panel.state.scanSummary.ok && (
        <div className="error-banner">
          ⚠️ Скан не выполнен: {panel.state.scanSummary.error}
        </div>
      )}

      <DebugPanel
        summary={panel.state.scanSummary}
        logs={panel.state.logs}
        conn={panel.state.conn}
        swVersion={panel.state.swVersion}
        lastPong={panel.state.lastPong}
        sentCount={panel.state.sentCount}
        ping={() => panel.send({ type: "IDE_PING" })}
      />
    </div>
  );
}