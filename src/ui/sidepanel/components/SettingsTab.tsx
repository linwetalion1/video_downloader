import { useState } from "react";
import { CONCURRENCY_OPTIONS, PAGE_LIMIT_OPTIONS, IMAGE_LIMIT_OPTIONS, FORMAT_OPTIONS } from "../../../shared/constants";
import type { Settings } from "../../../shared/types";
import { usePanel } from "../store";

/** Экран настроек с разделами (ТЗ §54). Значения сохраняются автоматически. */
export function SettingsTab() {
  const panel = usePanel();
  const { settings } = panel.state;
  const [saved, setSaved] = useState(false);

  const patch = (p: Partial<Settings>) => {
    panel.send({ type: "IDE_UPDATE_SETTINGS", settings: p });
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  const num = (v: string) => (v === "" ? 0 : Math.max(0, Number(v) || 0));

  return (
    <div className="tab-body settings">
      {saved && <div className="ok-banner">✓ Настройки сохранены</div>}

      <section className="card">
        <h3>Основные</h3>
        <div className="grid2">
          <label className="field">Режим отображения
            <select value={settings.viewMode} onChange={(e) => patch({ viewMode: e.target.value as Settings["viewMode"] })}>
              <option value="grid">Grid</option>
              <option value="compact">Compact Grid</option>
              <option value="list">List</option>
            </select>
          </label>
          <label className="field">Сортировка
            <select value={settings.sortKey} onChange={(e) => patch({ sortKey: e.target.value as Settings["sortKey"] })}>
              <option value="fileSize">По размеру файла</option>
              <option value="width">По ширине</option>
              <option value="height">По высоте</option>
              <option value="resolution">По разрешению</option>
              <option value="name">По имени</option>
              <option value="url">По URL</option>
              <option value="depth">По глубине</option>
              <option value="page">По странице</option>
            </select>
          </label>
          <label className="field inline">Папка сохранения
            <input type="text" value={settings.saveTo} onChange={(e) => patch({ saveTo: e.target.value })} />
            <span className="hint">Относительно папки «Загрузки» браузера (см. edge://settings/downloads). Напр. <code>Downloads\{settings.saveTo || "images"}</code>.</span>
          </label>
          <label className="field inline">Структура папок
            <select value={settings.folderMode} onChange={(e) => patch({ folderMode: e.target.value as Settings["folderMode"] })}>
              <option value="flat">Все в одну папку</option>
              <option value="page">По страницам</option>
              <option value="domain">По доменам</option>
              <option value="depth">По глубине</option>
            </select>
          </label>
        </div>
      </section>

      <section className="card">
        <h3>Поиск</h3>
        <div className="grid2">
          <label className="field">Глубина обхода
            <select value={settings.maxDepth} onChange={(e) => patch({ maxDepth: Number(e.target.value) })}>
              <option value={0}>0 — текущая страница</option>
              <option value={1}>1 уровень</option>
              <option value={2}>2 уровня</option>
            </select>
          </label>
          <label className="field">Область обхода
            <select value={settings.scope} onChange={(e) => patch({ scope: e.target.value as Settings["scope"] })}>
              <option value="origin">Только origin</option>
              <option value="site">Текущий сайт</option>
              <option value="all">Внешние домены</option>
            </select>
          </label>
          <label className="field inline">Максимум страниц
            <input type="number" min={1} value={settings.maxPages} onChange={(e) => patch({ maxPages: Number(e.target.value) || 10 })} list="pages" />
            <datalist id="pages">{PAGE_LIMIT_OPTIONS.map((n) => <option key={n} value={n} />)}</datalist>
          </label>
          <label className="field inline">Максимум изображений
            <input type="number" min={1} value={settings.maxImages} onChange={(e) => patch({ maxImages: Number(e.target.value) || 100 })} list="imgs" />
            <datalist id="imgs">{IMAGE_LIMIT_OPTIONS.map((n) => <option key={n} value={n} />)}</datalist>
          </label>
          <label className="field inline">Макс. общий объём скачивания (MB)
            <input type="number" min={1} value={settings.maxTotalDownloadMB} onChange={(e) => patch({ maxTotalDownloadMB: num(e.target.value) })} />
          </label>
          <label className="row">
            <input type="checkbox" checked={settings.respectRobotsTxt} onChange={(e) => patch({ respectRobotsTxt: e.target.checked })} />
            Учитывать robots.txt
          </label>
        </div>
      </section>

      <section className="card">
        <h3>Фильтры</h3>
        <div className="grid2">
          <label className="field inline">Мин. ширина (px)
            <input type="number" value={settings.minWidth} onChange={(e) => patch({ minWidth: num(e.target.value) })} />
          </label>
          <label className="field inline">Мин. высота (px)
            <input type="number" value={settings.minHeight} onChange={(e) => patch({ minHeight: num(e.target.value) })} />
          </label>
          <label className="field inline">Мин. размер (KB)
            <input type="number" value={settings.minFileSizeKB} onChange={(e) => patch({ minFileSizeKB: num(e.target.value) })} />
          </label>
          <label className="field">Логика
            <select value={settings.filterMode} onChange={(e) => patch({ filterMode: e.target.value as Settings["filterMode"] })}>
              <option value="AND">AND</option>
              <option value="OR">OR</option>
            </select>
          </label>
        </div>
        <div className="row wrap">
          {FORMAT_OPTIONS.map((f) => (
            <label key={f} className="checkbox">
              <input type="checkbox" checked={settings.excludeFormats.includes(f)}
                onChange={(e) => {
                  const cur = settings.excludeFormats;
                  patch({ excludeFormats: e.target.checked ? [...cur, f] : cur.filter((x) => x !== f) });
                }} />
              исключить {f}
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>Скорость</h3>
        <div className="grid2">
          <label className="field inline">Задержка страниц: мин (ms)
            <input type="number" value={settings.pageDelayMin} onChange={(e) => patch({ pageDelayMin: num(e.target.value) })} />
          </label>
          <label className="field inline">Задержка страниц: макс (ms)
            <input type="number" value={settings.pageDelayMax} onChange={(e) => patch({ pageDelayMax: num(e.target.value) })} />
          </label>
          <label className="field inline">Задержка изображений: мин (ms)
            <input type="number" value={settings.imageDelayMin} onChange={(e) => patch({ imageDelayMin: num(e.target.value) })} />
          </label>
          <label className="field inline">Задержка изображений: макс (ms)
            <input type="number" value={settings.imageDelayMax} onChange={(e) => patch({ imageDelayMax: num(e.target.value) })} />
          </label>
          <label className="field inline">Задержка скачивания: мин (ms)
            <input type="number" value={settings.downloadDelayMin} onChange={(e) => patch({ downloadDelayMin: num(e.target.value) })} />
          </label>
          <label className="field inline">Задержка скачивания: макс (ms)
            <input type="number" value={settings.downloadDelayMax} onChange={(e) => patch({ downloadDelayMax: num(e.target.value) })} />
          </label>
          <label className="field inline">Таймаут страницы (ms)
            <input type="number" value={settings.pageTimeout} onChange={(e) => patch({ pageTimeout: num(e.target.value) })} />
          </label>
          <label className="field inline">Таймаут изображения (ms)
            <input type="number" value={settings.imageTimeout} onChange={(e) => patch({ imageTimeout: num(e.target.value) })} />
          </label>
          <label className="field inline">Таймаут скачивания (ms)
            <input type="number" value={settings.downloadTimeout} onChange={(e) => patch({ downloadTimeout: num(e.target.value) })} />
          </label>
          <label className="field inline">Повторные попытки
            <input type="number" min={0} max={5} value={settings.maxRetries} onChange={(e) => patch({ maxRetries: num(e.target.value) })} />
          </label>
          <label className="field">Параллелизм
            <select value={settings.concurrency} onChange={(e) => patch({ concurrency: Number(e.target.value) })}>
              {CONCURRENCY_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="field inline">Макс. backoff (ms)
            <input type="number" value={settings.maxBackoffMs} onChange={(e) => patch({ maxBackoffMs: num(e.target.value) })} />
          </label>
        </div>
        <p className="hint">
          Случайные задержки — для снижения нагрузки на сайты. При 429/503/Retry-After scheduler автоматически
          увеличивает задержку (×2 до maxBackoff), а после нормализации ответов постепенно возвращает интервал.
        </p>
      </section>

      <section className="card">
        <h3>Хранилище и безопасность</h3>
        <p className="hint">
          Настройки и состояние задачи хранятся в chrome.storage.local. Содержимое изображений не сохраняется.
          Расширение не выполняет код со страниц, не отключает CSP и не обходит ограничения доступа:
          при CORS/403 показывается ошибка и предложение «Открыть оригинал».
        </p>
      </section>
    </div>
  );
}