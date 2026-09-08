# Video Downloader Explorer

Edge MV3-расширение для поиска и скачивания **любых видео** с веб-страниц: HTML5 `<video>`, HLS, DASH, blob:/data:, встроенные плееры (YouTube, Vimeo, VK, OK, RuTube, Twitch, TikTok, Instagram, Twitter, Bilibili, Reddit, 9GAG, Rumble и т.д.) и плеерные фреймворки (HLS.js, dash.js, Video.js, JWPlayer, Plyr, Clappr, Shaka, Brightcove, Vidyard, Kaltura, Wistia, MediaElement, Flowplayer).

> ⚠️ Расширение **не обходит DRM** (Widevine, PlayReady, FairPlay, SAMPLE-AES). Такие видео корректно помечаются «DRM — недоступно» и не скачиваются.

---

## Что внутри

- **17 источников** видео на странице (HTML5, shadow DOM, perf API, плееры, соцсети)
- **MAIN-world сниффер сети**: перехват fetch/XHR страницы — манифесты, mp4, JSON API
  (Instagram GraphQL и т.п.), включая видео без расширений (googlevideo/videoplayback)
- **Автоматическое раскрытие** HLS master playlist — выбор качества в UI
- **HLS**: init-сегмент fMP4 первым байтом, расшифровка AES-128 (crypto.subtle),
  byteRange, ротация ключей; выход .ts или .mp4 по типу сегментов
- **DASH**: перечисление сегментов SegmentTemplate ($Number$/$Time$) и SegmentTimeline,
  полное скачивание init+сегментов с выбором лучшего видео-представления
- **Скачивание blob: и data:** (через content script, до 2 ГБ)
- **Mux**: HLS fMP4 / TS → один файл
- **Экстенсивное логирование** (11 категорий, 5 уровней, фильтры, экспорт)
- **Визуализация состояния**: status-баннер с активной фазой, прогресс-бар активной загрузки, статус-строка каждой карточки
- **Очередь** с приоритетами, rate-limiting, автоматический backoff на 429/503
- **Retry** с экспоненциальной задержкой
- **Виртуализация не нужна** — типично 5–30 видео на странице

---

## 🍏 Отдельная версия для Google Chrome на macOS

Для пользователей macOS доступен специализированный отдельный билд:
- 📦 **Скачать готовую сборку (ZIP)**: [video-downloader-explorer-chrome-macos.zip](https://github.com/linwetalion1/video_downloader/releases/download/v1.0.0-chrome-macos/video-downloader-explorer-chrome-macos.zip)
- 🏷️ **Страница релиза на GitHub**: [Release v1.0.0-chrome-macos](https://github.com/linwetalion1/video_downloader/releases/tag/v1.0.0-chrome-macos)
- 📄 **Инструкция**: [INSTALL_MACOS.md](file:///c:/Users/ivgol/Desktop/AI%20experiments/video%20downloader/release/chrome-macos/INSTALL_MACOS.md)

### Особенности версии для Mac:
1. **Файловая система APFS / HFS+ и Unicode NFC**: автоматическая нормализация предотвращает сбои загрузки в Chrome при русских названиях и спецсимволах. Очищены зарезервированные Finder двоеточия `:` и скрывающие начальные точки `.`.
2. **Горячие клавиши macOS**: нативная поддержка `⌘ + A`, `⌘ + D`, `⌘ + Enter`, `⌘ + F`, `⌘ + L`.
3. **Chrome Side Panel**: поддержка Chrome 116+ с гарантированным открытием по клику на иконку (`action.onClicked` fallback).
4. **Быстрая установка**: распакуйте ZIP → `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное».

---

### Требования

- Node.js ≥ 18.18, npm ≥ 9
- Microsoft Edge (Chromium ≥ 111)

### Шаги

```bash
cd "video-downloader-explorer"
npm install
npm run build        # собирает dist/
npm run package      # создаёт release/video-downloader-explorer.zip + распакованную папку
```

В `release/` появятся:

- **`video-downloader-explorer-unpacked/`** — готовая к загрузке папка (рекомендуемый путь)
- **`video-downloader-explorer.zip`** — тот же контент в zip (для переноса)
- **`video-downloader-explorer.crx`** (если найден `msedge.exe`) — бинарный пакет

### Установка в Edge (распакованный путь — основной)

1. Откройте `edge://extensions`
2. Включите **«Режим разработчика»** (Developer mode) — переключатель слева внизу
3. **«Загрузить распакованное»** → выберите папку `release/video-downloader-explorer-unpacked/`
4. Закрепите расширение на панели инструментов (иконка ▶)
5. Клик по иконке открывает side panel

### Установка через .crx (альтернатива)

1. Включите режим разработчика (см. выше)
2. Перетащите `video-downloader-explorer.crx` в окно `edge://extensions`
3. Подтвердите установку в диалоге

Если Edge пишет «This extension is not from any known source» — Edge не «узнаёт» подпись. В таком случае:
- Удалите старую версию (если есть)
- Используйте путь «Загрузить распакованное» с папкой `release/video-downloader-explorer-unpacked/`

---

## Использование

1. **Откройте страницу** с видео (YouTube, Vimeo, VK, twitch.tv, и т.д.)
2. **Кликните на иконку ▶** — откроется side panel
3. **«Найти → Сканировать страницу»** — расширение найдёт все видео
4. **«Результаты»** — выберите нужные галочками
5. **«Скачать выбранные»** — загрузка начнётся автоматически
6. **«Загрузки»** — наблюдайте прогресс в реальном времени
7. **«Лог»** — полный журнал всех событий (фильтр по уровню/категории, экспорт)

### Горячие клавиши

- `Ctrl+A` — выбрать все
- `Ctrl+D` — снять выбор
- `Ctrl+F` — на вкладку «Найти»
- `Ctrl+L` — на вкладку «Лог»

---

## Визуализация состояния (главный акцент)

### Status-баннер (всегда виден сверху)

- **Цвет фона** меняется в зависимости от состояния:
  - 🔵 синий — работает
  - 🟢 зелёный — готово
  - 🔴 красный — ошибка
  - ⚪ серый — пауза / idle
- **Pill** с иконкой и текстом текущей фазы (Сканирование / Метаданные / Скачивание / HLS / DASH / Blob / …)
- **Активное сообщение**: что прямо сейчас происходит («Скачиваем: title (45%)», «HLS: 12.3 MB», «Ожидание retry: 5 с»)
- **Backoff pill** появляется когда сервер ограничивает (×2.00)
- **Progress bar** активной загрузки с процентами
- **Последние ошибки** в раскрывающемся блоке
- **8 счётчиков**: Найдено / Проверено / В работе / В очереди / Скачано / Ошибки / Объём / Активно

### Карточка видео

- **Обложка** (постер / первый кадр / заглушка с разрешением)
- **Бейджи**: контейнер (MP4/WEBM/HLS/DASH/…), DRM, manifest
- **Метаданные**: W×H, длительность, размер, битрейт
- **Status-строка** под метаданными с точкой-индикатором:
  - 🔵 пульсирующая — скачиваем / проверяем
  - 🟢 — готово / скачано
  - 🔴 — ошибка
  - 🟡 — пропущено
  - ⚪ — отменено
- **Progress-bar** с процентами (если идёт скачивание)
- **Кнопки**: Скачать / Повторить / Отмена / ✅ / ⏭

### Вкладка «Загрузки»

- 6 сводных карточек сверху
- 4 секции: **Активные** (с прогресс-баром), **Скачано**, **Ошибки** (с кнопкой retry), **Пропущено**
- Каждая строка имеет status-индикатор

### Вкладка «Лог»

- 5 уровней: TRACE / DEBUG / INFO / WARN / ERROR
- 11 категорий: scan / manifest / metadata / download / queue / perm / http / blob / ui / sw / general
- Фильтр по уровню + чекбоксы по категориям + поиск по тексту
- **Экспорт в .txt** (кнопка «💾 Скачать лог»)
- Цветовое кодирование строк по уровню

---

## Permissions

`manifest.json`:

- `activeTab` — сканирование текущей вкладки без `<all_urls>`
- `tabs` — доступ к URL вкладки (иначе URL скрыт)
- `storage` — настройки, снимок задачи, лог
- `downloads` — скачивание файлов
- `scripting` — инжекция content script
- `sidePanel` — side panel UI
- `host_permissions: http://*/*, https://*/*` — для скачивания cross-origin (Edge спросит разрешение при первом скачивании)

`<all_urls>` **не используется**. На конкретном origin права запрашиваются через `chrome.permissions.request`.

---

## Безопасность и юридические аспекты

- **DRM** (`<ContentProtection>`, Widevine, PlayReady, FairPlay, SAMPLE-AES) — **обходится отказом**. Никаких попыток извлечения ключей.
- **CSP страниц** — не ломается. Content script инжектируется в isolated world через `chrome.scripting`.
- **Cookies/session** — по умолчанию НЕ передаются. Включается вручную в настройках (`useCookies: true`); DNR-правило приклеивает cookies только при включённой настройке.
- **Referer** — подмена через `declarativeNetRequest` (Referer=корень сайта, Sec-Fetch-набор медиа-запроса).
- **CAPTCHA / WAF** — не обходятся.
- **Blacklist доменов** — в коде помечены `KNOWN_DOMAINS_HEAVY_DRM` (Netflix, Disney+ и т.п.); пользователь может включить «Скрыть рекламу» в фильтрах.
- **Юридический disclaimer** в настройках.

---

## Архитектура

```
video-downloader-explorer/
├── manifest.json
├── sidepanel.html
├── scripts/
│   ├── build.mjs       # 3 независимые vite-сборки: SW (ESM), content (IIFE), sidepanel (React)
│   ├── make-icons.mjs  # генерация PNG-иконок (синий play на белом)
│   └── package.mjs     # dist/ → release/*.zip + unpacked/
├── src/
│   ├── background/service-worker.ts   # роутер сообщений, владелец Crawler
│   ├── content/                       # content script (IIFE)
│   │   ├── content.ts                 # точка входа, обработчик VDE_SCAN_PAGE
│   │   ├── video-scanner.ts           # <video>, <source>, shadow DOM
│   │   ├── player-detector.ts         # HLS.js, dash.js, Video.js, JWPlayer, Plyr, Clappr, Shaka…
│   │   ├── social-detector.ts         # YouTube, Vimeo, VK, OK, RuTube, Twitch, IG, TikTok, X, FB, …
│   │   ├── perf-sniffer.ts            # performance.getEntriesByType('resource')
│   │   └── blob-reader.ts             # fetch blob:/data: в content script
│   ├── crawler/
│   │   ├── orchestrator.ts            # главный класс Crawler (планировщик, retry, backoff)
│   │   ├── queue.ts                   # приоритетная очередь задач
│   │   └── rate-limiter.ts            # с автоматическим backoff (логирует изменения)
│   ├── media/
│   │   ├── formats.ts                 # detectFormat() по magic bytes
│   │   ├── hls.ts                     # парсер m3u8 (master + media)
│   │   ├── dash.ts                    # парсер MPD
│   │   ├── metadata.ts                # HEAD + Range + MP4/EBML парсер (размеры, длительность, кодеки)
│   │   ├── filters.ts                 # фильтр-движок (AND/OR, контейнеры, DRM, manifest)
│   │   └── downloader.ts              # chrome.downloads, blob fallback, HLS/DASH mux
│   ├── shared/
│   │   ├── types.ts                   # все типы (VideoCandidate, CrawlerEvent, …)
│   │   ├── constants.ts               # DEFAULTS, лимиты, опции
│   │   ├── utils.ts                   # URL, filename, форматирование, sha1
│   │   └── logger.ts                  # расширенный логгер (11 категорий, ring buffer, storage)
│   ├── storage/settings.ts            # chrome.storage: settings, snapshot, history
│   └── ui/sidepanel/
│       ├── main.tsx, App.tsx, store.ts, types.ts, styles.css
│       └── components/
│           ├── StatusBanner.tsx       # главная визуализация (фаза, прогресс, статистика, ошибки)
│           ├── FindTab.tsx            # герой, кнопка скана, разбивка по источникам/контейнерам
│           ├── ResultsTab.tsx         # виртуализированная сетка карточек
│           ├── VideoCard.tsx          # карточка видео (статус-pill, прогресс, действия)
│           ├── FiltersBar.tsx         # фильтры (W/H, длительность, битрейт, контейнеры, DRM, manifest, blob)
│           ├── DownloadsTab.tsx       # очередь, прогресс, retry
│           ├── LogsTab.tsx            # лог с фильтрами и экспортом
│           └── SettingsTab.tsx        # настройки сканирования/скачивания
└── tests/                             # vitest (форматы, HLS, фильтры, утилиты, логгер)
```

Принцип: **UI не знает о сети**, **orchestrator не знает о React**, **downloader не зависит от React**. Общение — через `chrome.runtime.connect({ name: 'panel' })` и типизированные сообщения.

---

## Тесты

```bash
npm test
```

Покрытие: форматы, HLS парсер, фильтры, утилиты, логгер. Без сетевых вызовов.

---

## Roadmap (Phase 3)

- WebM/MKV mux
- Smooth Streaming (ISM)
- Расшифровка YouTube signatureCipher (сейчас такие ссылки честно помечаются и пропускаются)
- Чёрный список доменов в настройках
- i18n (uk, de, fr, es, …)
- Drag-and-drop в проводник
- Интеграция с yt-dlp (Phase 3, с явным дисклеймером)

---

## Лицензия и дисклеймер

Расширение предоставляется «как есть». Используйте только для скачивания контента, на который у вас есть права. Автор не несёт ответственности за нарушение авторских прав.
