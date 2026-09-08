# ТЗ: Video Downloader Explorer — Edge MV3 расширение для скачивания любых видео

> **Расширение‑предшественник в этой же папке** — `image-downloader-explorer` (MV3, React side‑panel, service worker, content script, TypeScript, vite, vitest). Архитектура, naming, структура каталогов, схема сообщений, scheduler, rate‑limiter, deduplicator, robots, package/CRX‑сборка и UI‑паттерны намеренно повторяются 1‑в‑1, чтобы можно было переиспользовать компоненты и инфраструктуру. Ниже описано только то, что **отличается** для видео, и видео‑специфичные требования.

---

## 0. Цель

Edge‑расширение, которое:

1. **Находит на текущей странице все видео** любого происхождения (HTML5 `<video>`, встроенные iframe‑плееры, прямые ссылки на медиа, blob/data: URL, динамически подгружаемые, HLS/DASH, YouTube, Vimeo, RuTube, VK, OK, Instagram Reels, TikTok, X/Twitter, Twitch, Reddit, Pornhub и т. д., RTMP/RTSP, WebRTC‑записи, эзотерические форматы).
2. **Показывает их в side‑panel** с превью, метаданными (длительность, разрешение, кодек, контейнер, вес, битрейт), фильтрами и массовым выбором.
3. **Скачивает** в выбранную папку с автоматической структурой каталогов, уникальными именами, без перезаписи.
4. **Не нарушает CSP**, не обходит авторизацию/CAPTCHА/WAF, не модифицирует cookies/заголовки, не использует `eval` и не исполняет код страниц.
5. **Не пытается** обойти DRM (Widevine/PlayReady/FairPlay/EME) — такие видео корректно скрываются с пометкой «DRM‑защищено, скачивание недоступно».

---

## 1. Имя, версия, идентичность

- Внутреннее имя: `video-downloader-explorer`
- Расширение генерируется в подпапке `dist/` параллельно с image‑версией; `manifest.json` отдельно, `sidepanel.html` отдельно, иконки в `icons/`.
- Поле `"key"` в манифесте — **свой собственный** ключ в `keys/edge-key.pem` (нельзя переиспользовать ключ image‑версии — иначе ID расширения совпадёт и Edge перезапишет установку).
- Описание в манифесте: «Поиск, превью, фильтрация и массовое скачивание видео с веб‑страниц (HTML5, HLS, DASH, blob, встроенные плееры, прямые ссылки).»

---

## 2. Permissions

```
"permissions": [
  "activeTab",
  "tabs",
  "storage",
  "downloads",
  "scripting",
  "sidePanel",
  "declarativeNetRequestWithHostAccess"  // для опциональной подмены Range/Referer — см. §14
],
"host_permissions": ["http://*/*", "https://*/*"]
```

- `<all_urls>` не используется; на конкретном origin права запрашиваются по кнопке «Скачать с этого сайта» через `chrome.permissions.request({ origins: ["<origin>"] })`.
- `declarativeNetRequest` — только для опциональной подстановки `Referer`/`Origin` на тех origin, где пользователь явно разрешил, и только в виде добавляющих заголовков (без drop/replace существующих). Список правил — `chrome://extensions` → «Разрешения сайта» → `optional_host_permissions`.
- `webRequestBlocking` **не используется** (MV3 это и не позволяет для большинства задач).

---

## 3. Архитектура (слои, как в image‑версии)

```
dist/
└── (после npm run build):
    ├── manifest.json
    ├── background.js           # service worker (ESM)
    ├── content.js              # content script (IIFE)
    ├── sidepanel.html
    └── icons/*.png

src/
├── background/
│   ├── service-worker.ts      # роутер сообщений, владелец Crawler, permissions, история
│   └── download-orchestrator.ts  # скачивание через downloads API, fallback blob, m3u8 → mp4
├── content/
│   ├── content.ts             # точка входа
│   ├── video-scanner.ts       # поиск <video>, <source>, <iframe>, blob:, data:, shadow roots
│   ├── player-detector.ts     # эвристики плееров: YouTube, Vimeo, VK, OK, RuTube, IG, TikTok,
│   │                          # Twitch, Twitter/X, Reddit, Facebook, 9GAG, Rumble, Bilibili,
│   │                          # Pinterest, Rutube, VK Видео, OK Видео, Coub, Vimeo, Wistia,
│   │                          # JWPlayer, Video.js, Plyr, Shaka, HLS.js, dash.js, Clappr,
│   │                          # Flowplayer, Vidyard, Brightcove, Kaltura, generic MP4
│   ├── manifest-sniffer.ts    # парсинг HLS (m3u8) / DASH (mpd) / ISM / VTT / TTML / WebVTT
│   ├── network-sniffer.ts     # webRequest / performance API для перехвата медиа‑URL
│   ├── media-info.ts          # duration, readyState, videoWidth/Height, currentSrc, src chain
│   ├── mutation-monitor.ts    # ограниченный по времени MutationObserver
│   └── shadow-piercer.ts      # безопасный проход по open shadow roots
├── crawler/
│   ├── crawler.ts             # discovery→scan→metadata→download (по аналогии с image)
│   ├── scheduler.ts
│   ├── queue.ts
│   ├── deduplicator.ts        # canonical URL, группы вариантов, fingerprint
│   ├── rate-limiter.ts
│   ├── robots.ts
│   └── http.ts                # fetch с таймаутом/классификацией ошибок, Range‑докачка
├── media/
│   ├── formats.ts             # распознавание контейнера по сигнатуре первых байт
│   ├── hls.ts                 # парсер m3u8 (master + media), выбор качества, AES‑KEY warning
│   ├── dash.ts                # парсер MPD (Period/AdaptationSet/Representation), выбор качества
│   ├── metadata.ts            # HEAD + Range‑sniff, длительность, битрейт, шифрование
│   ├── filters.ts
│   ├── fingerprint.ts         # sha1 первых 256 КБ
│   └── downloader.ts          # downloads API, blob‑fallback, m3u8/mpd → fmp4 (см. §15)
├── storage/
│   └── settings.ts
├── shared/
│   ├── types.ts               # VideoItem, MediaFormat, PlayerHint, JobView, Message
│   ├── constants.ts
│   └── utils.ts
└── ui/sidepanel/
    ├── App.tsx                # Tabs: Найти / Результаты / Загрузка / Настройки
    ├── components/
    │   ├── VideoCard.tsx      # превью (canvas‑snapshot первого кадра или постер)
    │   ├── VideoGrid.tsx      # виртуализированная сетка
    │   ├── FiltersBar.tsx
    │   ├── QualitySelector.tsx # выбор качества для HLS/DASH
    │   └── DebugPanel.tsx
    └── ...
```

Принцип: **UI не знает о сети**, **crawler не знает о React**, **downloader не зависит от React**. Общение — через `chrome.runtime.connect({ name: 'video-explorer' })` и типизированные сообщения.

---

## 4. Обнаружение видео (VideoScanner)

Контент‑скрипт **по требованию** (`chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })`, как и в image‑версии). Сканирует **только текущую страницу** (без рекурсивного обхода по ссылкам — рекурсия для видео слишком дорогая и часто неуместна; вместо этого — см. §8 «Ассоциативное расширение»).

Источники кандидатов (уровни приоритета):

| # | Источник | Пример | Примечание |
|---|----------|--------|------------|
| 1 | `<video>` элементы | `<video src=…>`, `<video><source src=…></video>` | самые надёжные |
| 2 | `currentSrc` после readyState > 0 | `videoEl.currentSrc` | часто отличается от `src` после выбора источника |
| 3 | Blob URL из `src` | `blob:https://…` | нужно скачать blob (см. §10) |
| 4 | Прямые ссылки в DOM | `<a href="…mp4">`, `<a href="…webm">` | как в image‑версии |
| 5 | Плееры в `<iframe>` (same‑origin) | `iframe[src*=youtube]`, `iframe[src*=vimeo]` | см. §6 |
| 6 | Плеерные фреймворки | JWPlayer, Video.js, Plyr, Shaka, HLS.js, dash.js, Clappr, MediaElement, Vidyard, Brightcove, Kaltura | доступ к глобальным переменным плеера и его манифесту |
| 7 | Социальные сети (см. §6) | IG Reels, TikTok, X, Reddit, VK, OK, RuTube, YouTube, Pinterest, Facebook | детекторы по URL + DOM‑сигнатурам |
| 8 | `performance.getEntriesByType('resource')` фильтр по типу | `video/`, аудио‑range ответы | уже загруженные браузером куски |
| 9 | `performance.getEntriesByType('navigation')` для blob‑видео | «Navi to blob:…» | редко |
| 10 | meta‑теги | `<meta property="og:video" content="…">`, `<meta property="og:video:url">`, `twitter:player:stream` | |
| 11 | JSON‑LD `VideoObject` | schema.org | |
| 12 | Lazy‑load атрибуты | `data-src`, `data-video-src`, `data-srcset` | |
| 13 | Custom elements / Web Components | <my-video>, <amp-video>… | |
| 14 | Shadow DOM (open) | обход всех `element.shadowRoot` | |
| 15 | Canvas + `captureStream` | если сайт рисует кадры в canvas → MediaStream | не для скачивания, но кандидат на запись (см. §12) |
| 16 | WebRTC peer metadata | `getStats()` для `inbound-rtp` video track | отметка «WebRTC, нужна запись» |
| 17 | `picture‑in‑picture` document | `document.pictureInPictureElement` | в основном дубликат #1 |

Все кандидаты собираются в `RawVideoCandidate[]` и передаются в `manifest-sniffer.ts` (если это HLS/DASH/ISM) и в `media-info.ts` (для уже загруженных `<video>`).

MutationObserver включается на `5 секунд` (настраивается) после старта скана — ловит лениво подгружаемые превью‑плееры.

---

## 5. Определение формата и метаданных

`formats.ts` по первым 16 байтам (через `Range: bytes=0-15` или `videoEl.canPlayType` + сигнатура):

| Сигнатура | Контейнер | Кодеки (типично) |
|-----------|-----------|------------------|
| `00 00 00 ?? 66 74 79 70` (ftyp) | MP4 / MOV / M4V / 3GP | avc1, hvc1, av01, mp4a, opus |
| `1A 45 DF A3` | Matroska / WebM | av1, vp9, vp8, opus, vorbis |
| `52 49 46 46 ?? ?? ?? ?? 41 56 49 20` («RIFF…AVI ») | AVI | разные |
| `46 4C 56 01` | FLV | h264, aac |
| `4F 67 67 53` | Ogg / OGV | theora, vorbis |
| `2E 73 6E 64` | AU | |
| `23 21 41 4D 52 0A` (`.snd`) | AU Sun | |
| `4D 54 68 64` | MIDI (ложно‑положительный, отбрасывать) | — |
| `47` (0x47) с шагом 188 | MPEG‑TS (`.ts`, `.m2ts`, `.mts`) | h264, aac |
| `44 48 44` (mpd — XML) | text/mpd | DASH manifest |
| `#EXTM3U` | text/plain | HLS playlist |
| `<?xml … <MPD` | text/xml | DASH manifest |
| `PK 03 04` (ZIP/EBML внутри — редко) | EBML внутри контейнера | см. mkv |

Спец‑случаи:

- `video/webm;codecs=vp9,opus` — нормально, скачиваем.
- `video/mp2t` (MPEG‑TS) — качаем как есть или перепаковываем в mp4 (см. §15).
- `application/x-mpegURL`, `application/vnd.apple.mpegurl` — HLS.
- `application/dash+xml` — DASH.
- `application/x-shockwave-flash` (FLV) — качаем, перепаковка по запросу.
- `application/octet-stream` с расширением `.m3u8`/`.mpd`/`.ts`/`.f4m` — трактуем по расширению.
- `data:video/…;base64,…` — blob‑fallback (см. §10).
- `blob:https://…` — blob‑fallback (см. §10).
- `rtsp://`, `rtmp://`, `mms://` — **не поддерживаем как прямое скачивание** (эти протоколы не работают в fetch); предлагаем «Открыть оригинал».

Метаданные MP4/WebM/MKV:

- MP4: трейлеры `moov`, `trak`, `tkhd`, `mdia` → `width/height/duration/timescale`.
- WebM/MKV: EBML‑элементы `Segment` → `Tracks` → `Video` → `PixelWidth/PixelHeight/FrameRate` и `Duration`.
- Длительность в `seconds` (double), разрешение (W×H), битрейт (по `duration` × `size`).
- «Размер неизвестен» если контейнер не парсится — пометка «?» в карточке.

Для уже загруженного `<video>`:

- `videoEl.duration`, `videoEl.videoWidth/Height`, `videoEl.readyState`, `videoEl.currentSrc`.
- Если `readyState < 2` — ждать `loadedmetadata` до 5 с; иначе брать только сигнатуру по Range.

---

## 6. Детекторы плееров и соцсетей (player-detector.ts)

Эвристика — комбинация URL, глобальных объектов страницы, DOM‑сигнатур. Никакого `eval` кода страниц; только чтение глобалов и `iframe.contentDocument` (если same‑origin).

| Домен / плеер | Сигнатура | Что извлекаем |
|---|---|---|
| `youtube.com` / `youtu.be` | URL, `#movie_player`, `ytplayer.config.args.player_response` | progressive URLs (до 1080p для не‑Premium, иначе только audio/muxed; **DRM‑контент → «Premium/DRM»**). Извлекаем через `JSON.parse(ytplayer.config.args.player_response)→streamingData.formats/progressive/adaptive` |
| `vimeo.com` | URL, `player.vimeo.com`, `playerConfig`, JSON‑конфиг | `progressive` массив (mp4); если только DASH — скачиваем mpd→fmp4 |
| `rutube.ru` | URL, `__NEXT_DATA__`, `playerData` | прямые mp4/hls |
| `vk.com` / `vkvideo.ru` | URL, `mv.cur()`, `flashVars`, JSON `player` | `url240/360/480/720/1080` |
| `ok.ru` | URL, `flashVars`, JSON | mp4/hls |
| `coub.com` | URL, `data‑permalink` | mp4 + отдельно аудио (опционально мёрдж) |
| `dailymotion.com` | URL, JSON‑config | progressive + HLS |
| `twitch.tv` | URL, `__twitch` store | VOD HLS (с AccessToken из `usher` JSON) |
| `reddit.com`/redd.it | URL + JSON `dash_url`/`hls_url`/`fallback_url` | DASH/HLS |
| `instagram.com` | URL, `__additionalData`, `graphql` payload | mp4/HLS для Reels, Posts, Stories (если доступны) |
| `tiktok.com` | URL, `__UNIVERSAL_DATA_FOR_REHYDRATION__` | HLS для большинства видео |
| `twitter.com` / `x.com` | URL, `tweet_result`, GraphQL | mp4/HLS через `video_info.variants` |
| `facebook.com` | URL, `sd_src`/`hd_src` | progressive mp4 |
| `pinterest.com` | URL, JSON | mp4 |
| `9gag.com` | URL, JSON | mp4 |
| `bilibili.com` | URL, `__INITIAL_STATE__` | DASH (`dash.mpd` после sign) |
| `rumble.com` | URL, JSON | mp4/HLS |
| `pornhub.com` и др. | URL, JSON flashVars, `mediaDefinitions` | progressive mp4 |
| `generic Video.js` | `videojs.getAllPlayers()` | `currentSrc()` |
| `generic JWPlayer` | `jwplayer().getConfig().playlist[0].sources` | file/sources |
| `generic Plyr` | `plyr.getInstances()` | `source` |
| `generic HLS.js` | `Hls.isSupported()` + инстанс на `window.hls` | `levels[].url` |
| `generic dash.js` | `dashjs.MediaPlayer().getActiveStream().getStreamInfo()` | manifest URL |
| `generic Clappr` | `Clappr.Player.getInstances()` | `options.source` |
| `generic Vidyard` | `window.VYODA`/`vidyardEmbed` | JSON |
| `generic Brightcove` | `videojs.bc()`, `players.bc()` | sources |
| `generic Kaltura` | `kWidget.embed` | sources |
| `generic Wistia` | `Wistia.api` | `medias[].assets[]` |

Для каждого детектора результат — `PlayerHint { type, manifestUrls?: string[], progressive?: { url, quality, mime, size? }[], title?, thumbnail?, duration? }`.

---

## 7. Манифесты: HLS, DASH, ISM, M3U8, MPD

### 7.1. HLS (`hls.ts`)

Парсер m3u8: master playlist (`#EXT-X-STREAM-INF`) → массив вариантов с `BANDWIDTH`, `RESOLUTION`, `CODECS`, `FRAME-RATE`. Media playlist → сегменты, ключи `#EXT-X-KEY` (METHOD=AES‑128/SAMPLE‑AES), `#EXT-X-MAP` для fmp4, `#EXT-X-ENDLIST`, `#EXT-X-PLAYLIST-TYPE`.

- **Выбор качества** в UI: «Авто» (по умолчанию — лучшее до выбранного в настройках потолка), список вариантов с разрешением/битрейтом.
- **AES‑128 ключи** — скачиваем и прокидываем в скачиватель, **если** CORS позволяет (HEAD к URL ключа). Если ключ недоступен — предупреждение «Зашифровано AES‑128, скачивание невозможно».
- **SAMPLE‑AES / CENC / CENS** (DRM) — **не поддерживается**; помечается «DRM (SAMPLE‑AES)».
- **Скачивание** — два пути:
  1. **Склейка сегментов в MP4**: если все сегменты — fMP4 (`#EXT-X-MAP`), перепаковываем через `mp4box.js` (см. §15) в один файл.
  2. **Склейка как TS/MPEG‑TS**: если контейнер `.ts` — склеиваем в один `.ts` (без перекодирования, muxer — лёгкий конкатенатор, т.к. TS‑пакеты самосинхронны). Не идеально, но работает в VLC/ffmpeg.
  3. **Скачать как .m3u8 + .ts файлы** в подпапку — fallback, когда перепаковка невозможна.

### 7.2. DASH (`dash.ts`)

Парсер MPD: `MPD→Period[].AdaptationSet[].Representation[]`. Извлекаем `BaseURL`, `SegmentTemplate` (с `$RepresentationID$`, `$Number$`, `$Bandwidth$`, `$Time$`), `SegmentList`. Сегменты init‑range (`$init$`) и media‑segments.

- **Выбор качества** аналогично HLS: «Авто»/«Лучшее»/«Худшее»/«Аудио отдельно»/«Только видео».
- **DRM ContentProtection** (`<ContentProtection schemeIdUri="urn:uuid:…">` для Widevine/PlayReady/FairPlay) → **не поддерживается**, помечается «DRM».
- **Скачивание** — через `dash.js` (или собственный клиент) для получения инициализации и сегментов, перепаковка в fMP4 с `mp4box.js`.

### 7.3. Smooth Streaming (ISM)

`<video src=…ism/Manifest">` (`.ism`, `.ism/Manifest`, `.ism/QualityLevels`) — поддержка по запросу (Phase 2). Сейчас — детектируем и предлагаем «Открыть оригинал».

### 7.4. Скачивание манифестов

- `chrome.downloads.download({ url: m3u8_url })` — для пользователя как есть, **если** он явно выбрал «Скачать .m3u8».
- По умолчанию — раскрытие в один mp4/ts.

---

## 8. «Ассоциативное расширение» (вместо рекурсивного обхода)

Рекурсивный обход страниц для видео в image‑версии даёт картинки. Для видео он чаще ведёт на страницы‑обёртки без полезных видео и расходует трафик. Поэтому:

- **На текущей странице** — полный скан.
- **Кнопка «Найти похожие»** — открывает 1‑уровневый поиск ссылок «video/watch/play» на текущей странице (ограниченный список, не рекурсия). Пользователь выбирает, какие страницы посетить, в side‑panel (а не в background, чтобы избежать скрытых переходов).
- **Кнопка «Скачать встроенные»** — отдельно для YouTube/Vimeo/IG/TikTok/… — пытается извлечь progressive из публичного JSON‑эндпойнта страницы (см. §6) без переходов.
- **«Скачать весь плейлист»** — если на странице есть ссылки на плейлист (YouTube playlist, Vimeo album, VK album, RuTube playlist, TikTok user page) — переход и скан по страницам плейлиста (глубина 1, лимит страниц 50, лимит видео 200).

---

## 9. Скачивание blob: и data:

В `downloader.ts`:

- Если `src` — `blob:https://…`:
  1. В content script: `fetch(blobUrl).then(r => r.blob()).then(b => { ... })` → `arrayBuffer()` → base64 чанками 16 МБ → сообщение в SW `BLOB_CHUNK { id, base64, offset }` → `chrome.downloads.download({ url: 'data:video/mp4;base64,…' })` (маленькие файлы) **или** `URL.createObjectURL(blob)` в offscreen document + `chrome.downloads.download({ url })` (большие файлы).
  2. Ограничение: 2 ГБ blob (лимит `URL.createObjectURL` в MV3). Больше — чанками.
- Если `src` — `data:video/…;base64,…`:
  1. Декодировать base64 → `Blob` → тот же путь.

---

## 10. Blob URL из media‑источника (MSE)

Современные плееры строят `MediaSource`/`SourceBuffer` с фрагментами fMP4, а `currentSrc` становится `blob:…`. Алгоритм в `network-sniffer.ts`:

1. **Перехват** через `performance.getEntriesByType('resource')` с типом `video/`, `audio/`, `application/octet-stream` с расширениями `.m4s/.mp4/.ts/.cmfv/.cmfa` — собрать список URL.
2. Проверить, не совпадают ли они с `MediaSource.sourceBuffers[*].buffered` диапазонами.
3. Если совпадают — это сегменты искомого `<video>`. Склеить через `mp4box.js` (§15) по `SegmentTemplate`/`SegmentList` или по времени в `buffered`.
4. Скачать склеенный файл.

Для YouTube/Twitch/Instagram и т. п. (где сегменты за auth‑токеном) — отдельный путь через публичный API, см. §6.

---

## 11. Запись MediaStream / WebRTC / canvas captureStream

**Не реализуем запись «с экрана»** — это пересекается с `desktopCapture` и ухудшает UX/безопасность. Разрешено **только** чтение метаданных существующих `<video>`/`<canvas>` потоков, без записи.

---

## 12. Скачивание (downloader.ts)

```ts
type DownloadRequest = {
  id: string;
  url: string;
  filename: string;          // уже безопасное имя
  folder: string;            // подпапка внутри savePath
  headers?: Record<string,string>;
  sizeHint?: number;         // из HEAD/Range
  conflictAction: 'uniquify' | 'overwrite' | 'prompt';
  onProgress?: (p: { received: number, total: number }) => void;
  onComplete?: (path: string) => void;
  onError?: (err: DownloadError) => void;
  abortSignal?: AbortSignal;
  resume?: boolean;          // докачка, если сервер поддерживает Range
};
```

- **Скачивание больших видео** — через `chrome.downloads.download({ url, filename, conflictAction: 'uniquify', method: 'GET' })`.
- **Докачка** — `Range: bytes=N-` если `Accept-Ranges: bytes` и `Content-Length` известен. На 206/206 — продолжаем, иначе с нуля.
- **Стрим с прогрессом** — для UI: `chrome.downloads.onChanged` фильтруем по `id`, отображаем `bytesReceived/totalBytes`.
- **Blob/data:** — путь из §9.
- **HLS/DASH** — путь из §7.
- **Subtitle/CC** — если есть `<track>`, скачиваются рядом, опционально.
- **Лимит общего объёма** — настраивается (по умолчанию 10 ГБ, для превью‑сборки).
- **Имена файлов** (§как в image‑версии): Content‑Disposition → URL basename → title → сгенерированное. Конфликты — `conflictAction: "uniquify"`.
- **Структура папок** по умолчанию:
  ```
  <savePath>/
    <domain>/
      <page-slug>/
        <timestamp>/
          <video>__<quality>__<codec>.<ext>
          <video>__<quality>__<codec>.<ext>.vtt
  ```
- **Cookies/session** — НЕ передаются (для CORS‑защищённых видео покажем ошибку и «Открыть оригинал»). Исключение — explicit `withCredentials: true` по кнопке «Использовать cookies сайта» (только для origin, на котором пользователь дал host‑permission).

---

## 13. Сеть, заголовки, CORS

- По умолчанию fetch отправляет **только безопасные** заголовки (Referer автоматически; Origin автоматически).
- **Referer** на cross‑origin — оставляем нативный (если сайт требует определённый Referer — кнопка «Подменить Referer» в карточке видео, заголовок пробрасывается через `chrome.declarativeNetRequest` (см. §2) с явным `host_permissions`).
- **Cookies** — `credentials: 'include'` опционально, через настройку «Использовать cookies текущего сайта» (по умолчанию OFF).
- **User‑Agent** — нативный.
- **CORS‑ошибки** → в UI: «Недоступно из‑за CORS», кнопка «Открыть оригинал».

---

## 14. Подмена Referer / Origin через declarativeNetRequest (Phase 2)

Только если пользователь явно разрешил для конкретного origin (через `optional_host_permissions` + per‑origin toggle в настройках). Правило вида:

```json
{
  "id": 1,
  "priority": 1,
  "action": { "type": "modifyHeaders", "requestHeaders": [
    { "header": "Referer", "operation": "set", "value": "https://expected-referer/" }
  ]},
  "condition": {
    "resourceTypes": ["media", "xmlhttprequest", "other"],
    "domains": ["cdn.example.com"],
    "requestDomains": ["cdn.example.com"]
  }
}
```

`removeHeaders` и `redirect` **не используются** (безопасность).

---

## 15. Muxing / repackaging (HLS fMP4 → MP4, TS → TS, DASH → MP4)

Цель: один файл, который открывается везде, без потери качества и без перекодирования (remux only).

- **mp4box.js** (npm `mp4box`) — для fMP4: склейка `init` + media segments → один MP4 с одним `moov` в начале. Подходит для HLS fMP4, DASH, MSE‑blob.
- **MPEG‑TS** — лёгкий конкатенатор TS‑пакетов (188 байт) в один `.ts`. Если в HLS смешаны разные программы/кодеки — оставляем как есть и пишем в карточке «возможны проблемы с переключением».
- **FLV** — не перепаковываем, сохраняем `.flv`.
- **WebM** — `EBML` парсер для склейки (если сегменты одинаковые) или сохранение как `.webm` (один сегмент уже играется).
- **Не делаем transcode** (без ffmpeg.wasm): это утяжелит бандл и противоречит «remux only». Если в будущем потребуется — отдельный opt‑in.

Требования к mp4box: tree‑shakable ESM, ≤ 150 КБ gzip, lazy import только при необходимости.

---

## 16. Фильтры и сортировки (FiltersBar.tsx)

- **Минимум**: длительность (сек), разрешение (W×H), битрейт (Мбит/с), размер (МБ).
- **Форматы**: MP4, WebM, MKV, TS, M3U8/HLS, MPD/DASH, FLV, AVI, MOV, data:, blob:.
- **Источник**: HTML5, iframe (same‑origin), player:YouTube/Vimeo/…, HLS.js, dash.js, generic, custom.
- **Качество**: SD/HD/FHD/4K/8K (по `videoWidth`).
- **Только с субтитрами / только с аудио / только видео (без аудио)** — где применимо.
- **Исключения**: tracking‑pixel, icon, tiny‑video (< 320×180), favicon‑видео, реклама (по сигнатурам `ads.`, `doubleclick`, и т. п. — **best effort, не фильтр‑факт**).
- **Сортировка**: длительность ↑/↓, разрешение ↑/↓, размер ↑/↓, имя, домен, дата добавления.
- **Логика**: AND между группами, OR внутри группы (как в image‑версии).

---

## 17. UI (side‑panel, React)

Вкладки:

1. **Найти** — кнопка «Сканировать», сводка последнего скана (сколько `<video>`, сколько `<source>`, сколько blob, сколько HLS, сколько плееров, сколько shadow roots, сколько мутаций), debug‑лог.
2. **Результаты** — виртуализированная сетка карточек, мульти‑селект, фильтры, сортировки, экспорт CSV/JSON списка URL, копирование URL.
3. **Загрузка** — очередь, прогресс‑бары, пауза/продолжить/отменить, retry, история.
4. **Настройки** — папка сохранения, шаблон имени, лимит объёма, таймауты, заголовки, диапазоны задержек, parallel, blacklist доменов, opt‑in cookies, opt‑in Referer‑подмена.

Карточка видео (`VideoCard.tsx`):

- Превью: `<img poster>` (из `videoEl.poster` или `meta og:image` или `config.screenshot` или `first‑frame canvas snapshot` в content script).
- Метаданные: длительность, W×H, кодек, контейнер, вес (если есть), битрейт, источник, формат.
- Действия: ▶ Открыть оригинал, ⬇ Скачать, ⏬ Скачать все выбранные, ⋮ (контекст: выбор качества для HLS/DASH, копировать URL, открыть в новой вкладке, пожаловаться).

Доступность: клавиатурная навигация, `Ctrl+A`/`Ctrl+D`/`Esc`/`Space`, aria‑атрибуты, контраст.

---

## 18. Scheduler и Rate limiting (наследуется из image‑версии)

- Очереди: `PAGE_SCAN` (здесь редко), `VIDEO_SCAN` (лёгкий), `VIDEO_METADATA` (HEAD/Range/парс), `VIDEO_DOWNLOAD` (тяжёлый), `HLS_DOWNLOAD`/`DASH_DOWNLOAD` (самый тяжёлый), `BLOB_DOWNLOAD`.
- Параллелизм: 1–4 (по умолчанию 2), настраивается отдельно от image‑версии.
- Задержки: 200–800 мс между загрузками по умолчанию, настраивается.
- Backoff: 2^n до 30 с, реакция на 429/503, автоматический сброс.
- Retry: только для временных ошибок (timeout, сеть, 5xx, 429), max 2 попытки; 401/403/404/CORS не повторяются.
- Snapshot задачи в `chrome.storage.local` — восстановление после рестарта SW.

---

## 19. Безопасность и юридические аспекты

- **DRM** (`<ContentProtection>`, Widevine, PlayReady, FairPlay, SAMPLE‑AES) — **обходится отказом** (помечаем «DRM, недоступно»). Никаких попыток извлечения ключей.
- **CSP страниц** — не ломаем. Если страница запрещает инжекцию — показываем ошибку.
- **Cookies/session** — не отправляем, кроме явного opt‑in.
- **Referer/Origin подмена** — только по явному разрешению на origin.
- **Авторизация/CAPTCHA/WAF** — не обходим.
- **«Не загружать с сайтов…»** — blacklist доменов в настройках, по умолчанию пусто.
- **Юридический disclaimer** — в README и в карточке «Скачать» мелким шрифтом: «Убедитесь, что имеете право на скачивание контента; расширение не несёт ответственности за нарушение авторских прав.»

---

## 20. Тесты (vitest, как в image‑версии)

Покрытие ≥ 80% для `src/media/`, `src/crawler/`, `src/content/manifest-sniffer.ts`, `src/content/player-detector.ts` (детекторы), `hls.ts`, `dash.ts`, `formats.ts`, `downloader.ts` (моки `chrome.*`).

Фикстуры:

- MP4 (`ftyp` + минимальный `moov` + `mdat`) с известной длительностью.
- WebM с EBML.
- M3U8 master + media playlist.
- MPD с Period/AdaptationSet/Representation.
- Blob URL, data: URL.
- YouTube JSON, Vimeo JSON, RuTube JSON (синтетические).
- Edge cases: пустой `<video>`, невалидный blob, DRM, CORS‑ошибка, 404, 429, 503, range‑ответ.

---

## 21. Сборка, пакетирование, распространение (наследуется)

- `npm run dev` — watch, 3 сборки: SW (ESM), content (IIFE), sidepanel (React).
- `npm run build` — production.
- `npm run package` — `image-downloader-explorer.crx/.zip` **плюс** `video-downloader-explorer.crx/.zip` в `release/`. Ключ в `keys/edge-key.pem` — **свой** (см. §1).
- `npm run typecheck`, `npm test`, `npm run test:watch`.

Загрузка в Edge — `.crx` через drag‑and‑drop в `edge://extensions` (Developer mode) или `.zip` → «Загрузить распакованное».

---

## 22. Отличия от image‑версии (cheat sheet)

| Аспект | Image | Video |
|---|---|---|
| Скан | `<img>`, `srcset`, `background-image`, `<picture>`, `data-src` | `<video>`, `<source>`, iframe, blob:, data:, perf‑entries, сетевой sniffer, MSE, плееры |
| Формат | PNG/JPEG/GIF/WebP/AVIF/BMP/ICO/SVG | MP4/WebM/MKV/AVI/FLV/TS/HLS/DASH/blob/data |
| Метаданные | W×H, MIME, размер (сигнатура) | W×H, длительность, битрейт, кодек, контейнер, encrypted? |
| Muxing | нет | да (mp4box.js) |
| Blob URL | игнор | **полная поддержка** (data: + blob:) |
| MSE/segments | нет | **да** (sniffer, перехват) |
| Детекторы плееров | нет | ~25 (YouTube, Vimeo, …, HLS.js, dash.js, Video.js, JWPlayer, Plyr, …) |
| HLS/DASH парсер | нет | **да** |
| DRM | нет | **явный отказ** (помечаем, не пытаемся) |
| Рекурсивный обход | да (0–2) | **нет** (ассоциативное расширение, плейлисты отдельно) |
| Scheduler | page/scan/metadata/download | + HLS/DASH/BLOB/muxing |
| Размер бандла | small | + mp4box.js (~150 КБ gzip), + hls/dash парсеры |
| Permissions | + `declarativeNetRequestWithHostAccess` (Phase 2) |
| UI | как в image | + QualitySelector, + выбор mux vs raw |

---

## 23. MVP vs Phase 2

**MVP (1.0)**: §1–§5, §7 (только HLS fMP4 + TS), §8 (минимум), §9, §12, §16–§18, §21.

**Phase 2 (1.1)**: §6 (расширенные детекторы), §7.2 DASH muxing, §7.3 Smooth, §10 MSE‑сниффинг, §13–§14 Referer/Cookies, §15 WebM mux, §20 (расширенные тесты), blacklist доменов, opt‑in cookies.

**Phase 3 (1.2)**: §11 запись MediaStream (отдельный opt‑in), расписание загрузок, интеграция с yt-dlp/yt-dlp-ejs (с явным дисклеймером, без скрытого обхода DRM).

---

## 24. Критерии приёмки (Definition of Done для MVP)

- [ ] На странице с 5+ `<video>` (включая blob, HLS fMP4, DASH, iframe‑YouTube, прямой mp4) расширение находит ≥ 90% кандидатов (вручную проверяется на 5 разнообразных страницах).
- [ ] На YouTube (не Premium) — находит progressive до 1080p, скачивает.
- [ ] На Vimeo/Reddit/Instagram — находит progressive или HLS, скачивает.
- [ ] На Twitch VOD — находит HLS, скачивает (возможно с предупреждением о токене).
- [ ] На YouTube Premium / Netflix / Disney+ — корректно показывает «DRM, недоступно», не падает.
- [ ] На странице с blob: video — скачивает файл целиком.
- [ ] Фильтры работают, сортировки работают, мульти‑селект работает.
- [ ] Скачивание 1 ГБ видео успешно, с прогрессом, без перезаписи, с докачкой после дисконнекта (если сервер поддерживает Range).
- [ ] На странице с CSP `script-src 'self'` (без `'unsafe-inline'`) — расширение работает (благодаря тому, что content script инжектируется через `chrome.scripting` в isolated world, не зависит от CSP страницы).
- [ ] Никакого `eval`, никакой передачи cookies без opt‑in, никакой подмены заголовков без opt‑in.
- [ ] Тесты `npm test` зелёные, покрытие ≥ 80% для `src/media/` и `src/crawler/`.
- [ ] `npm run package` собирает `.crx`/`.zip` без ошибок, ID расширения стабильный.
- [ ] README с инструкцией по установке и разделом «Юридическая ответственность».

---

## 25. Открытые вопросы для заказчика

1. **Premium‑контент**: только пометка «DRM», или нужен opt‑in режим «через yt-dlp wrapper» (с явным дисклеймером и без скрытого обхода)?
2. **Cookies** — по умолчанию OFF (рекомендуется) или ON (с предупреждением)?
3. **Mux vs raw** — по умолчанию «mux в mp4 где возможно» (рекомендуется) или «всегда как есть (.ts/.m3u8/.mpd)»?
4. **Лимит на одно видео** — 10 ГБ хватит (типично 4K ≈ 20–30 ГБ, нужен ли 50 ГБ)?
5. **Blacklist сайтов** по умолчанию — пусто или предзаполнен популярными «нельзя» (соцсети с лицензионными ограничениями)?
6. **i18n** — только русский/английский или сразу мультиязычный (uk, de, fr, es, …)?
7. **Telemetry** — никакой, или opt‑in анонимная (версия, страна, число скачиваний — без URL и личных данных)?
8. **Хранение истории** — N дней (по умолчанию 30), или «до явной очистки»?
9. **Drag‑and‑drop видео из side‑panel в проводник** — нужна поддержка? (требует `chrome.downloads` + drag api, есть нюансы в MV3)
10. **Параллелизм по умолчанию** — 2 (рекомендуется), 4 (быстрее, но грузит канал) или 1 (бережно)?

---

*Документ — 2026‑08‑25. Версия ТЗ: 0.9 (draft). После ответов на §25 — фиксация в 1.0 и старт MVP.*
