// Crawler / Orchestrator — сердце расширения.
//
// Жизненный цикл:
//   1) init() — создаёт новое задание
//   2) ingestScan() — получает сырые кандидаты от content script
//   3) start() — крутит scheduler
//   4) pause/resume/cancel
//
// Scheduler в одной EventLoop-итерации:
//   - берёт следующую задачу (по приоритету + retryAt)
//   - если VIDEO_METADATA — resolveVideoMetadata
//   - если VIDEO_DOWNLOAD — downloadVideo
//   - после выполнения: onProgress / onCandidateUpdate → broadcast в UI
//   - повторяет пока есть задачи
//
// ВАЖНО: каждая фаза жизни кандидата пишется в лог и в phase. UI показывает
//        баннер "Сейчас делаем: ..." + каждая карточка имеет status-pill.
import type {
  CandidatePatch, CrawlerEvent, JobStats, JobStatus, Phase, RawVideoCandidate,
  ScanOptions, ScanSummary, Settings, Task, TaskCounts, TaskType, UILogEntry, VideoCandidate,
} from "../shared/types";
import { PRIORITIES } from "../shared/constants";
import { canonicalUrl, formatDurationHuman, hostnameOf, isObscureTitle, uid, variantGroupKey } from "../shared/utils";
import { downloadVideo } from "../media/downloader";
import { resolveVideoMetadata } from "../media/metadata";
import { fetchAndParseHls } from "../media/hls";
import { fetchAndParseDash } from "../media/dash";
import { downloadLog } from "../shared/logger";
import {
  logger, manifestLog, queueLog, scanLog, swLog,
} from "../shared/logger";
import { TaskQueue } from "./queue";
import { RateLimiter } from "./rate-limiter";

export interface CrawlerDeps {
  settings: Settings;
  rootUrl: string;
  rootTitle?: string;
  ensureOriginPermission: (url: string) => Promise<boolean>;
  hasOriginPermission: (url: string) => Promise<boolean>;
  onEvent: (ev: CrawlerEvent) => void;
  persist: () => void;
}

export class Crawler {
  readonly jobId: string;
  readonly startedAt: number;
  finishedAt: number | null = null;
  status: JobStatus = "idle";
  active: boolean = false;
  private pauseRequested = false;
  private cancelRequested = false;

  private candidates = new Map<string, VideoCandidate>();
  private byUrl = new Map<string, string>(); // variantGroupKey → id
  private queue = new TaskQueue();
  private limiter!: RateLimiter;
  private running = new Set<string>();
  /** Активные AbortController'ы по candidateId — для честной отмены загрузок. */
  private aborts = new Map<string, AbortController>();
  private nextRetryAt: number | null = null;

  private errors: JobView["errors"] = [];
  private logTail: UILogEntry[] = [];
  private logListener: (e: UILogEntry) => void;
  private removeLogListener: (() => void) | null = null;
  private stats: JobStats = {
    totalFound: 0, totalChecked: 0, totalDownloaded: 0, totalFailed: 0, totalSkipped: 0, totalBytes: 0,
    activeTask: null, activeCandidateId: null, startedAt: null, finishedAt: null,
    msUntilNextRetry: 0, backoffFactor: 1,
  };

  private snapshotTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: CrawlerDeps) {
    this.jobId = uid("job");
    this.startedAt = Date.now();
    this.stats.startedAt = this.startedAt;
    this.limiter = new RateLimiter({
      minMs: this.deps.settings.downloadDelayMin,
      maxMs: this.deps.settings.downloadDelayMax,
      maxBackoffMs: this.deps.settings.maxBackoffMs,
    });
    this.logListener = (e) => this.onLog(e);
    import("../shared/logger").then((m) => {
      // Отменяем любые ранее зарегистрированные слушатели этого экземпляра (защита от утечки).
      this.removeLogListener = m.addLogListener(this.logListener);
    });
  }

  static fromSnapshot(snap: JobView, deps: CrawlerDeps): Crawler {
    const c = new Crawler(deps);
    c.status = snap.status === "running" ? "paused" : snap.status;
    c.finishedAt = snap.finishedAt ?? null;
    for (const cand of snap.candidates) c.candidates.set(cand.id, cand);
    c.rebuildUrlIndex();
    c.stats = { ...snap.stats };
    return c;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  addCandidates(raw: RawVideoCandidate[], sourceUrl: string, sourceTitle?: string, sourceType?: string): void {
    const seen = new Set<string>();
    for (const r of raw) {
      const key = variantGroupKey(r.videoUrl);
      if (seen.has(key) || this.byUrl.has(key)) continue;
      seen.add(key);
      const id = uid("v");
      const cand: VideoCandidate = {
        id,
        videoUrl: r.videoUrl,
        canonicalUrl: canonicalUrl(r.videoUrl),
        alternatives: r.alternatives ?? [],
        sourceType: r.sourceType,
        sourcePageUrl: sourceUrl,
        sourcePageTitle: sourceTitle,
        sourceDomain: hostnameOf(sourceUrl),
        iframeSrc: r.iframeSrc,
        container: r.container ?? "unknown",
        mimeType: r.mimeType,
        extension: r.extension,
        isManifest: r.isManifest ?? false,
        isDRM: r.isDRM ?? false,
        isBlob: r.videoUrl.startsWith("blob:") || r.videoUrl.startsWith("data:"),
        needsSignature: !!(r.context as any)?.needsSignature,
        // Подсказки из контекста детекторов (YouTube signatureCipher и т.п.).
        message: (r.context as any)?.needsSignature
          ? "Ссылка требует подписи YouTube (PO-токен) — обычно недоступна напрямую, попробуйте HLS/DASH или другой вариант."
          : undefined,
        title: r.title,
        thumbnailUrl: r.thumbnailUrl,
        durationSec: r.durationSec,
        width: r.width,
        height: r.height,
        isLive: r.isLive ?? !!(r.context as any)?.isLive,
        segmentsCount: r.segmentsCount,
        hlsVariants: r.hlsVariants,
        status: "discovered",
        selected: false,
        phase: "init",
        progress: 0,
        depth: 0,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.candidates.set(id, cand);
      this.byUrl.set(key, id);
      this.stats.totalFound++;
      this.emitCandidate(cand);
      this.enqueueMetadata(cand);
    }
  }

  start(): void {
    if (this.status === "running") return;
    this.ensureLogListener();
    this.status = "running";
    this.active = true;
    this.cancelRequested = false;
    this.pauseRequested = false;
    this.deps.onEvent({ type: "status", status: this.status });
    this.deps.onEvent({ type: "log", entry: logger.info(`Задача ${this.jobId.slice(-6)} запущена`) });
    this.startSnapshotTimer();
    void this.loop();
  }

  /** Регистрирует лог-слушатель, если был удалён destroy() после завершения задачи. */
  private ensureLogListener(): void {
    if (this.removeLogListener) return;
    import("../shared/logger").then((m) => {
      this.removeLogListener = m.addLogListener(this.logListener);
    });
  }

  pause(): void {
    if (this.status !== "running") return;
    this.pauseRequested = true;
    this.deps.onEvent({ type: "log", entry: logger.warn("Пауза запрошена") });
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.status = "running";
    this.pauseRequested = false;
    this.deps.onEvent({ type: "status", status: this.status });
    this.deps.onEvent({ type: "log", entry: logger.info("Возобновление работы") });
    void this.loop();
  }

  cancel(): void {
    this.cancelRequested = true;
    this.pauseRequested = false;
    for (const ctrl of this.aborts.values()) ctrl.abort();
    this.deps.onEvent({ type: "log", entry: logger.warn("Отмена запрошена") });
  }

  setSelected(ids: string[], selected: boolean): void {
    let n = 0;
    for (const id of ids) {
      const c = this.candidates.get(id);
      if (c && c.selected !== selected) {
        c.selected = selected;
        n++;
      }
    }
    if (n > 0) this.deps.onEvent({ type: "log", entry: logger.debug(`Выделение: ${n} кандидатов → ${selected ? "выбрано" : "снято"}`) });
  }

  enqueueDownloads(ids?: string[]): void {
    const list = ids
      ? ids.map((id) => this.candidates.get(id)).filter((c): c is VideoCandidate => !!c)
      : [...this.candidates.values()].filter((c) => c.selected);
    let n = 0;
    let skippedBlobs = 0;
    for (const c of list) {
      if (c.status === "downloading" || c.status === "downloaded") continue;
      if (c.isDRM) {
        c.status = "skipped";
        c.phase = "done";
        c.message = "DRM — пропущено";
        this.stats.totalSkipped++;
        this.deps.onEvent({ type: "log", entry: downloadLog.warn(`SKIP ${c.title || c.videoUrl.slice(0, 60)}: DRM`) });
        this.emitCandidateUpdate(c.id, { status: c.status, phase: c.phase, message: c.message });
        continue;
      }
      // blob: — на Instagram/YouTube это MediaSource (MSE): байтов нет.
      // Реальные ссылки — соседние кандидаты (mp4/HLS). Пропускаем с подсказкой.
      if (c.isBlob) {
        c.status = "skipped";
        c.phase = "done";
        c.message = "blob (MSE) — файла в нём нет. Запустите воспроизведение видео на странице и нажмите «Сканировать» ещё раз: расширение перехватит реальный поток (mp4/HLS/DASH).";
        this.stats.totalSkipped++;
        skippedBlobs++;
        this.deps.onEvent({ type: "log", entry: downloadLog.warn(`SKIP blob: ${c.videoUrl.slice(0, 60)} — MSE. Запустите воспроизведение на странице и просканируйте заново.`) });
        this.emitCandidateUpdate(c.id, { status: c.status, phase: c.phase, message: c.message });
        continue;
      }
      // YouTube signatureCipher без расшифровки: googlevideo всегда ответит 403 —
      // не спамим ретраями, помечаем сразу с внятной подсказкой.
      if (c.needsSignature) {
        c.status = "skipped";
        c.phase = "done";
        c.message = "Ссылка YouTube требует подписи (PO-токен) — недоступна напрямую. Используйте HLS/DASH-вариант этого видео.";
        this.stats.totalSkipped++;
        this.deps.onEvent({ type: "log", entry: downloadLog.warn(`SKIP ${c.title || c.videoUrl.slice(0, 60)}: needsSignature (YouTube)`) });
        this.emitCandidateUpdate(c.id, { status: c.status, phase: c.phase, message: c.message });
        continue;
      }
      const task: Task = {
        id: uid("t"), type: "VIDEO_DOWNLOAD", url: c.videoUrl, candidateId: c.id,
        priority: PRIORITIES.DOWNLOAD, createdAt: Date.now(), status: "QUEUED", retryCount: 0,
      };
      this.queue.push(task);
      c.status = "queued";
      c.phase = "waiting";
      c.message = "В очереди на скачивание";
      this.emitCandidateUpdate(c.id, { status: c.status, phase: c.phase, message: c.message });
      n++;
    }
    this.deps.onEvent({ type: "log", entry: downloadLog.info(`Поставлено в очередь на скачивание: ${n} видео` + (skippedBlobs ? `, blob пропущено: ${skippedBlobs}` : "")) });
    if (!this.active) this.start();
  }

  cancelDownloads(ids?: string[]): void {
    if (!ids) {
      const removed = this.queue.clear();
      for (const ctrl of this.aborts.values()) ctrl.abort();
      this.deps.onEvent({ type: "log", entry: downloadLog.warn(`Очередь очищена (${removed} задач), активные загрузки прерваны`) });
      return;
    }
    for (const id of ids) {
      const c = this.candidates.get(id);
      if (!c) continue;
      // Активная загрузка — честно рвём соединение.
      if (c.status === "downloading") {
        this.aborts.get(id)?.abort();
        c.status = "cancelled";
        c.phase = "cancelled";
        c.message = "Отменено";
        this.emitCandidateUpdate(c.id, { status: c.status, phase: c.phase, message: c.message });
        continue;
      }
      const removed = this.queue.removeByCandidate(id);
      if (removed > 0) {
        c.status = "cancelled";
        c.phase = "cancelled";
        c.message = "Отменено";
        this.emitCandidateUpdate(c.id, { status: c.status, phase: c.phase, message: c.message });
      }
    }
  }

  retry(ids?: string[]): void {
    const list = ids
      ? ids.map((id) => this.candidates.get(id)).filter((c): c is VideoCandidate => !!c && c.status === "failed")
      : [...this.candidates.values()].filter((c) => c.status === "failed");
    for (const c of list) {
      c.status = "discovered";
      c.phase = "init";
      c.message = "Повтор…";
      c.retryCount = 0;
      this.stats.totalFailed = Math.max(0, this.stats.totalFailed - 1);
      // Если метаданные уже получены (ошибка была на этапе скачивания) —
      // сразу в очередь скачивания, а не на повторный разбор метаданных.
      const hasMeta = c.fileSize !== undefined || c.container !== "unknown" || c.durationSec !== undefined || c.isBlob;
      if (hasMeta) {
        const task: Task = {
          id: uid("t"), type: "VIDEO_DOWNLOAD", url: c.videoUrl, candidateId: c.id,
          priority: PRIORITIES.DOWNLOAD, createdAt: Date.now(), status: "QUEUED", retryCount: 0,
        };
        this.queue.push(task);
        c.status = "queued";
        c.phase = "waiting";
        c.message = "В очереди на скачивание (повтор)";
      } else {
        this.enqueueMetadata(c);
      }
    }
    this.deps.onEvent({ type: "log", entry: downloadLog.info(`Повтор для ${list.length} видео`) });
    if (!this.active) this.start();
  }

  setVariant(candidateId: string, variantId: string): void {
    const c = this.candidates.get(candidateId);
    if (!c?.hlsVariants) return;
    const v = c.hlsVariants.find((x) => x.id === variantId);
    if (!v) return;
    c.selectedVariantId = variantId;
    c.videoUrl = v.url;
    c.bitrateKbps = Math.round(v.bandwidth / 1000);
    c.width = v.width ?? c.width;
    c.height = v.height ?? c.height;
    c.message = `Выбран вариант: ${v.resolutionLabel}`;
    this.deps.onEvent({ type: "log", entry: downloadLog.info(`HLS/DASH: ${c.title || "—"} → ${v.resolutionLabel} (${Math.round(v.bandwidth / 1000)}kbps)`) });
    this.emitCandidateUpdate(c.id, { videoUrl: c.videoUrl, selectedVariantId: variantId, bitrateKbps: c.bitrateKbps, message: c.message });
  }

  getState(): JobStatus { return this.status; }

  /** URL страницы, на которой задача была запущена (для сброса при навигации). */
  get rootUrl(): string { return this.deps.rootUrl; }
  get rootTitle(): string | undefined { return this.deps.rootTitle; }

  snapshot(): JobView {
    const taskCounts = this.computeTaskCounts();
    return {
      jobId: this.jobId,
      status: this.status,
      rootUrl: this.deps.rootUrl,
      rootTitle: this.deps.rootTitle,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? undefined,
      settings: this.deps.settings,
      candidates: [...this.candidates.values()],
      logTail: this.logTail.slice(-200),
      taskCounts,
      stats: { ...this.stats, backoffFactor: this.limiter.factor, msUntilNextRetry: this.nextRetryAt ? Math.max(0, this.nextRetryAt - Date.now()) : 0 },
      activeMessage: this.computeActiveMessage(),
      errors: [...this.errors].slice(-100),
      history: [],
    };
  }

  destroy(): void {
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }
    if (this.removeLogListener) { try { this.removeLogListener(); } catch { /* noop */ } this.removeLogListener = null; }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private enqueueMetadata(c: VideoCandidate): void {
    const task: Task = {
      id: uid("t"), type: "VIDEO_METADATA", url: c.videoUrl, candidateId: c.id,
      priority: PRIORITIES.METADATA, createdAt: Date.now(), status: "QUEUED", retryCount: 0,
    };
    this.queue.push(task);
  }

  private rebuildUrlIndex(): void {
    this.byUrl.clear();
    for (const c of this.candidates.values()) {
      this.byUrl.set(variantGroupKey(c.videoUrl), c.id);
    }
  }

  private async loop(): Promise<void> {
    swLog.debug(`Scheduler loop start (queue=${this.queue.size}, running=${this.running.size})`);
    while (this.active) {
      if (this.cancelRequested) {
        await this.finish("cancelled");
        return;
      }
      if (this.pauseRequested) {
        this.status = "paused";
        this.deps.onEvent({ type: "status", status: this.status });
        this.deps.onEvent({ type: "log", entry: logger.info("Пауза") });
        return;
      }

      // Проверка лимитов.
      const maxBytes = this.deps.settings.maxTotalDownloadMB * 1024 * 1024;
      if (this.stats.totalBytes > maxBytes) {
        this.deps.onEvent({ type: "log", entry: downloadLog.warn(`Достигнут лимит общего объёма: ${(maxBytes / 1024 / 1024).toFixed(0)} МБ`) });
        await this.finish("completed");
        return;
      }

      // Запустить максимум N задач параллельно.
      const slots = Math.max(0, this.deps.settings.concurrency - this.running.size);
      for (let i = 0; i < slots; i++) {
        const task = this.queue.pop(Date.now());
        if (!task) break;
        this.running.add(task.id);
        this.runTask(task).catch((e) => {
          this.deps.onEvent({ type: "log", entry: logger.error(`Task ${task.id} crashed: ${(e as Error).message}`) });
        }).finally(() => {
          this.running.delete(task.id);
        });
      }

      if (this.queue.isEmpty && this.running.size === 0) {
        this.deps.onEvent({ type: "log", entry: logger.info("Очередь пуста, все задачи завершены") });
        await this.finish("completed");
        return;
      }

      // Ждём перед следующей итерацией.
      const waitMs = this.queue.isEmpty ? 200 : 250;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  private async runTask(task: Task): Promise<void> {
    this.stats.activeTask = task.type;
    this.stats.activeCandidateId = task.candidateId ?? null;
    const cand = task.candidateId ? this.candidates.get(task.candidateId) : undefined;
    this.emitStats();
    try {
      switch (task.type) {
        case "VIDEO_METADATA":
          if (cand) await this.runMetadata(cand, task);
          break;
        case "VIDEO_DOWNLOAD":
          if (cand) await this.runDownload(cand, task);
          break;
        default:
          this.deps.onEvent({ type: "log", entry: queueLog.warn(`Неизвестный тип задачи: ${task.type}`) });
      }
    } catch (e) {
      this.deps.onEvent({ type: "log", entry: logger.error(`Task ${task.type} упал: ${(e as Error).message}`) });
    } finally {
      this.stats.activeTask = null;
      this.stats.activeCandidateId = null;
      this.emitStats();
    }
  }

  private async runMetadata(c: VideoCandidate, task: Task): Promise<void> {
    c.phase = "fetching-meta";
    c.status = "checking";
    c.message = "Запрашиваем метаданные…";
    c.updatedAt = Date.now();
    this.emitCandidateUpdate(c.id, { phase: c.phase, status: c.status, message: c.message });
    this.deps.onEvent({ type: "log", entry: scanLog.debug(`Meta: ${c.title || c.videoUrl.slice(0, 60)} (${c.container})`) });

    const meta = await resolveVideoMetadata(c.videoUrl, {
      timeoutMs: 15_000,
      knownWidth: c.width,
      knownHeight: c.height,
      knownDurationSec: c.durationSec,
      sourceType: c.sourceType,
      // Hotlink-защита (erome, CDN и т.п.): сервер отдаёт 403 без Referer со страницы-источника.
      referer: c.sourcePageUrl,
    });
    Object.assign(c, filterMeta(meta));

    // Проверяем на мёртвый стаб (0 байт, неизвестный контейнер, не манифест, не blob, не live)
    if (c.container === "unknown" && (!c.fileSize || c.fileSize === 0) && !c.isManifest && !c.isBlob && !c.isLive) {
      c.status = "failed";
      c.phase = "done";
      c.message = "Файл недоступен (0 байт или 403 Forbidden)";
      this.stats.totalSkipped++;
      this.emitCandidateUpdate(c.id, this.candidatePatch(c));
      this.deps.onEvent({ type: "log", entry: scanLog.debug(`SKIP ${c.videoUrl.slice(0, 60)}: 0 bytes / unknown container`) });
      return;
    }

    // Человекочитаемое название для обычных видео (если скрыто или raw URL)
    if (!c.title || isObscureTitle(c.title)) {
      const baseTitle = c.sourcePageTitle && !isObscureTitle(c.sourcePageTitle)
        ? c.sourcePageTitle.replace(/\s*-\s*YouTube$/i, "").trim()
        : "";
      const res = c.height ? `${c.height}p` : c.container.toUpperCase();
      const durStr = c.durationSec ? formatDurationHuman(c.durationSec) : "";
      if (baseTitle) {
        c.title = `${baseTitle} · [${res}${durStr ? `, ${durStr}` : ""}]`;
      } else if (c.durationSec && c.durationSec > 0) {
        c.title = `Видео (${durStr}, ${res})`;
      }
    }

    c.status = "ready";
    c.phase = "done";
    c.message = c.message || `Метаданные получены: ${c.container}, ${c.width || "?"}×${c.height || "?"}`;
    this.stats.totalChecked++;
    this.emitCandidateUpdate(c.id, this.candidatePatch(c));
    this.deps.onEvent({ type: "log", entry: scanLog.info(`✓ ${c.title || c.videoUrl.slice(0, 50)}: ${c.container.toUpperCase()}, ${c.durationSec ? Math.round(c.durationSec) + 's' : '?'}, ${c.width || '?'}×${c.height || '?'}${c.fileSize ? ', ' + (c.fileSize / 1024 / 1024).toFixed(1) + 'MB' : ''}${c.isDRM ? ' [DRM]' : ''}${c.isManifest ? ' [manifest]' : ''}`) });

    // Если манифест — раскрываем автоматически.
    if (c.isManifest && this.deps.settings.expandManifests) {
      await this.expandManifest(c);
    }
  }

  private async expandManifest(c: VideoCandidate): Promise<void> {
    try {
      c.phase = "fetching-meta";
      c.message = `Раскрытие ${c.container.toUpperCase()} манифеста…`;
      this.emitCandidateUpdate(c.id, { phase: c.phase, message: c.message });
      if (c.container === "hls") {
        const r = await fetchAndParseHls(c.videoUrl);
        if (r.ok && r.isMaster && r.variants.length > 0) {
          c.hlsVariants = r.variants;
          // По умолчанию — лучший по bandwidth.
          const best = [...r.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
          c.selectedVariantId = best.id;
          c.videoUrl = best.url;
          c.width = best.width ?? c.width;
          c.height = best.height ?? c.height;
          c.bitrateKbps = Math.round(best.bandwidth / 1000);

          // Проверяем дочерний медиа-плейлист, чтобы узнать точную длительность, сегменты и live/VOD
          try {
            const sub = await fetchAndParseHls(best.url);
            if (sub.ok) {
              if (sub.segments && sub.segments.length > 0) {
                c.segmentsCount = sub.segments.length;
                const dur = sub.totalDurationSec || Math.round(sub.segments.reduce((acc, s) => acc + (s.duration || 0), 0));
                if (dur > 0) {
                  c.durationSec = dur;
                  c.fileSize = Math.round((best.bandwidth / 8) * dur);
                }
              }
              c.isLive = !sub.isVOD;
            }
          } catch { /* ignore */ }

          // Человекочитаемое название: если скрыто или просто "video.m3u8", даём понятное имя
          if (!c.title || isObscureTitle(c.title)) {
            const res = best.resolutionLabel || (c.height ? `${c.height}p` : "");
            const durStr = c.durationSec ? formatDurationHuman(c.durationSec) : "";
            const baseTitle = c.sourcePageTitle && !isObscureTitle(c.sourcePageTitle)
              ? c.sourcePageTitle.replace(/\s*-\s*YouTube$/i, "").trim()
              : "";
            if (c.isLive) {
              c.title = baseTitle ? `${baseTitle} · 🔴 Прямой эфир (${res})` : `🔴 Прямой эфир ${res}`.trim();
            } else if (c.durationSec && c.durationSec >= 3600) {
              c.title = baseTitle ? `${baseTitle} · 📼 Запись (${durStr}, ${res})` : `📼 Трансляция / Запись (${durStr}, ${res})`.trim();
            } else if (c.durationSec && c.durationSec > 0) {
              c.title = baseTitle ? `${baseTitle} · [${res || "HLS"}]` : `Видео (${durStr}, ${res})`.trim();
            } else {
              c.title = baseTitle ? `${baseTitle} · Поток HLS (${res})` : `Поток HLS (${res})`.trim();
            }
          }

          c.message = `HLS: ${r.variants.length} вар., выбран ${best.resolutionLabel}${c.durationSec ? ` · ${formatDurationHuman(c.durationSec)}` : ""}${c.segmentsCount ? ` (${c.segmentsCount} сегм.)` : ""}`;
          this.deps.onEvent({ type: "log", entry: manifestLog.info(`${c.title || c.videoUrl.slice(0, 50)}: HLS → ${r.variants.length} вариантов, выбран ${best.resolutionLabel} (${Math.round(best.bandwidth / 1000)}kbps)`) });
        } else if (r.ok && !r.isMaster && r.segments) {
          c.segmentsCount = r.segments.length;
          const dur = r.totalDurationSec || Math.round(r.segments.reduce((acc, s) => acc + (s.duration || 0), 0));
          if (dur > 0) c.durationSec = dur;
          c.isLive = !r.isVOD;
          if (!c.title || isObscureTitle(c.title)) {
            const durStr = c.durationSec ? formatDurationHuman(c.durationSec) : "";
            const baseTitle = c.sourcePageTitle && !isObscureTitle(c.sourcePageTitle)
              ? c.sourcePageTitle.replace(/\s*-\s*YouTube$/i, "").trim()
              : "";
            c.title = c.isLive
              ? (baseTitle ? `${baseTitle} · 🔴 Прямой эфир (HLS)` : "🔴 Прямой эфир (HLS)")
              : (c.durationSec && c.durationSec >= 3600
                  ? (baseTitle ? `${baseTitle} · 📼 Запись (${durStr})` : `📼 Трансляция (${durStr})`)
                  : (baseTitle ? `${baseTitle} · Видео (${durStr})` : `Видео HLS (${durStr})`));
          }
        }
      } else if (c.container === "dash") {
        const r = await fetchAndParseDash(c.videoUrl);
        if (r.ok && r.variants.length > 0) {
          c.hlsVariants = r.variants;
          const best = [...r.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
          c.selectedVariantId = best.id;
          c.videoUrl = best.url;
          c.width = best.width ?? c.width;
          c.height = best.height ?? c.height;
          c.bitrateKbps = Math.round(best.bandwidth / 1000);
          c.message = `DASH: ${r.variants.length} представлений, выбран ${best.resolutionLabel}`;
          this.deps.onEvent({ type: "log", entry: manifestLog.info(`${c.title || c.videoUrl.slice(0, 50)}: DASH → ${r.variants.length} представлений, выбран ${best.resolutionLabel}`) });
        }
      }
    } catch (e) {
      this.deps.onEvent({ type: "log", entry: manifestLog.error(`Раскрытие манифеста не удалось: ${(e as Error).message}`) });
    }
    c.phase = "done";
    this.emitCandidateUpdate(c.id, {
      hlsVariants: c.hlsVariants,
      selectedVariantId: c.selectedVariantId,
      videoUrl: c.videoUrl,
      width: c.width,
      height: c.height,
      bitrateKbps: c.bitrateKbps,
      message: c.message,
      phase: c.phase,
      durationSec: c.durationSec,
      fileSize: c.fileSize,
      title: c.title,
      isLive: c.isLive,
      segmentsCount: c.segmentsCount,
    });
  }

  private async runDownload(c: VideoCandidate, task: Task): Promise<void> {
    c.phase = "init";
    c.status = "downloading";
    c.message = "Подготовка…";
    c.progress = 0;
    c.receivedBytes = 0;
    c.updatedAt = Date.now();
    this.emitCandidateUpdate(c.id, this.candidatePatch(c));
    this.deps.onEvent({ type: "log", entry: downloadLog.info(`START: ${c.title || c.videoUrl.slice(0, 60)} (${c.container}, ${(c.fileSize ?? 0) / 1024 / 1024 || "?"} MB)`) });

    // Rate limit.
    await this.limiter.wait();
    if (this.cancelRequested) {
      c.status = "cancelled";
      c.message = "Отменено";
      this.emitCandidateUpdate(c.id, { status: c.status, message: c.message });
      return;
    }

    const abort = new AbortController();
    this.aborts.set(c.id, abort);
    let result: Awaited<ReturnType<typeof downloadVideo>>;
    try {
      result = await downloadVideo({
        candidate: c,
        options: this.deps.settings,
        ensurePermission: this.deps.ensureOriginPermission,
        onProgress: (received, total) => {
          c.receivedBytes = received;
          c.progress = total ? received / total : (c.fileSize ? received / c.fileSize : 0);
          c.message = total ? `${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB` : `${(received / 1024 / 1024).toFixed(1)} MB`;
          this.emitCandidateUpdate(c.id, { receivedBytes: received, progress: c.progress, message: c.message });
        },
        setMessage: (msg) => {
          c.message = msg;
          c.updatedAt = Date.now();
          this.emitCandidateUpdate(c.id, { message: msg });
        },
        setPhase: (phase) => {
          c.phase = phase;
          c.updatedAt = Date.now();
          this.emitCandidateUpdate(c.id, { phase });
        },
        signal: abort.signal,
      });
    } finally {
      this.aborts.delete(c.id);
    }

    if (result.ok) {
      c.status = "downloaded";
      c.phase = "done";
      c.progress = 1;
      c.message = `Скачано: ${result.filename || c.videoUrl.slice(0, 50)}`;
      c.receivedBytes = result.bytes ?? c.receivedBytes;
      c.fileSize = result.bytes ?? c.fileSize;
      this.stats.totalDownloaded++;
      if (result.bytes) this.stats.totalBytes += result.bytes;
      this.deps.onEvent({ type: "log", entry: downloadLog.info(`✓ DONE: ${c.title || c.videoUrl.slice(0, 50)} → ${result.filename} (${(result.bytes ?? 0) / 1024 / 1024} MB)`) });
      this.limiter.reportStatus(200, c.videoUrl);
      this.emitCandidateUpdate(c.id, this.candidatePatch(c));
    } else if (result.errorCode === "ABORTED") {
      c.status = this.cancelRequested ? "cancelled" : c.status === "downloading" ? "failed" : "cancelled";
      c.phase = "cancelled";
      c.message = "Отменено пользователем";
      this.emitCandidateUpdate(c.id, { status: c.status, phase: c.phase, message: c.message });
    } else {
      c.retryCount++;
      if (result.retryable && c.retryCount <= this.deps.settings.maxRetries) {
        c.status = "checking";
        c.phase = "init";
        c.message = `Ошибка, повтор ${c.retryCount}/${this.deps.settings.maxRetries}: ${result.error}`;
        const delay = Math.min(30_000, 2000 * Math.pow(2, c.retryCount - 1));
        const t: Task = {
          ...task, id: uid("t"), retryCount: c.retryCount, status: "QUEUED",
          retryAt: Date.now() + delay,
        };
        this.queue.push(t);
        this.deps.onEvent({ type: "log", entry: downloadLog.warn(`RETRY ${c.retryCount}/${this.deps.settings.maxRetries} через ${delay}мс: ${c.title || c.videoUrl.slice(0, 50)} — ${result.error}`) });
        this.nextRetryAt = Date.now() + delay;
        this.emitCandidateUpdate(c.id, { status: c.status, phase: c.phase, message: c.message });
      } else {
        c.status = "failed";
        c.phase = "failed";
        c.message = `Ошибка: ${result.error}`;
        this.stats.totalFailed++;
        this.errors.push({ time: Date.now(), candidateId: c.id, url: c.videoUrl, message: result.error || "?", retryable: !!result.retryable });
        this.deps.onEvent({ type: "log", entry: downloadLog.error(`✗ FAIL: ${c.title || c.videoUrl.slice(0, 50)} — ${result.error} (code=${result.errorCode})`) });
        this.limiter.reportStatus(result.errorCode === "HTTP" ? 500 : undefined, c.videoUrl);
        this.emitCandidateUpdate(c.id, this.candidatePatch(c));
      }
    }
  }

  private async finish(status: JobStatus): Promise<void> {
    this.status = status;
    this.finishedAt = Date.now();
    this.stats.finishedAt = this.finishedAt;
    this.active = false;
    this.deps.onEvent({ type: "status", status });
    this.deps.onEvent({ type: "log", entry: logger.info(`Задача завершена со статусом: ${status}`) });
    this.emitStats();
    this.stopSnapshotTimer();
    this.flushLogs(true);
    this.destroy();
  }

  private startSnapshotTimer(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setInterval(() => {
      this.deps.persist();
    }, 3000);
  }
  private stopSnapshotTimer(): void {
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }
  }

  private onLog(e: UILogEntry): void {
    this.logTail.push(e);
    if (this.logTail.length > 500) this.logTail.shift();
  }

  private flushLogs(_force = false): void {
    // Устаревший механизм — логи в UI доставляет глобальный слушатель service worker.
    // Оставлен заглушкой для обратной совместимости интерфейса.
  }

  private computeTaskCounts(): TaskCounts {
    const byType: Partial<Record<TaskType, number>> = {};
    let queued = 0, running = 0, completed = 0, failed = 0, skipped = 0, cancelled = 0;
    for (const t of this.queue.all) {
      queued++;
      byType[t.type] = (byType[t.type] ?? 0) + 1;
    }
    for (const c of this.candidates.values()) {
      if (c.status === "downloading") running++;
      else if (c.status === "downloaded") completed++;
      else if (c.status === "failed") failed++;
      else if (c.status === "skipped") skipped++;
      else if (c.status === "cancelled") cancelled++;
    }
    return { queued, running, completed, failed, skipped, cancelled, total: this.candidates.size, byType };
  }

  private computeActiveMessage(): string {
    if (this.cancelRequested) return "Отмена…";
    if (this.pauseRequested) return "Пауза…";
    if (this.status !== "running") return `Статус: ${this.status}`;
    if (this.stats.activeTask) {
      const cand = this.stats.activeCandidateId ? this.candidates.get(this.stats.activeCandidateId) : null;
      if (cand) {
        const name = cand.title || cand.videoUrl.slice(0, 50);
        if (this.stats.activeTask === "VIDEO_DOWNLOAD") {
          const pct = Math.round((cand.progress || 0) * 100);
          return `Скачиваем: ${name} (${pct}%)`;
        }
        if (this.stats.activeTask === "VIDEO_METADATA") return `Метаданные: ${name}`;
        return `${this.stats.activeTask}: ${name}`;
      }
      return `Выполняется: ${this.stats.activeTask}`;
    }
    if (this.nextRetryAt && this.nextRetryAt > Date.now()) {
      const sec = Math.ceil((this.nextRetryAt - Date.now()) / 1000);
      return `Ожидание перед повтором: ${sec} с`;
    }
    if (!this.queue.isEmpty) return `В очереди: ${this.queue.size} задач, параллельно: ${this.running.size}`;
    if (this.limiter.factor > 1) return `Backoff: ${this.limiter.factor.toFixed(2)}×`;
    return "Ожидание задач…";
  }

  private emitCandidate(c: VideoCandidate): void {
    this.deps.onEvent({ type: "candidate", candidate: c });
  }
  private emitCandidateUpdate(id: string, patch: Partial<VideoCandidate>): void {
    this.deps.onEvent({ type: "candidateUpdate", id, patch });
  }
  private emitStats(): void {
    this.deps.onEvent({ type: "stats", stats: { ...this.stats, backoffFactor: this.limiter.factor } });
    this.deps.onEvent({ type: "tasks", counts: this.computeTaskCounts() });
  }
  private candidatePatch(c: VideoCandidate): Partial<VideoCandidate> {
    return {
      title: c.title,
      isLive: c.isLive,
      segmentsCount: c.segmentsCount,
      status: c.status, phase: c.phase, progress: c.progress,
      message: c.message, receivedBytes: c.receivedBytes, fileSize: c.fileSize,
      width: c.width, height: c.height, durationSec: c.durationSec,
      bitrateKbps: c.bitrateKbps, container: c.container, mimeType: c.mimeType,
      extension: c.extension, isManifest: c.isManifest, isDRM: c.isDRM,
      hlsVariants: c.hlsVariants, selectedVariantId: c.selectedVariantId,
      videoUrl: c.videoUrl, updatedAt: c.updatedAt,
    };
  }
}

function filterMeta(meta: any): Partial<VideoCandidate> {
  const out: Partial<VideoCandidate> = {};
  if (meta.fileSize !== undefined) out.fileSize = meta.fileSize;
  if (meta.mimeType) out.mimeType = meta.mimeType;
  if (meta.extension) out.extension = meta.extension;
  if (meta.container) out.container = meta.container;
  if (meta.isManifest !== undefined) out.isManifest = meta.isManifest;
  if (meta.isDRM !== undefined) out.isDRM = meta.isDRM;
  if (meta.isEncrypted !== undefined) out.isEncrypted = meta.isEncrypted;
  if (meta.durationSec !== undefined) out.durationSec = meta.durationSec;
  if (meta.width !== undefined) out.width = meta.width;
  if (meta.height !== undefined) out.height = meta.height;
  if (meta.codecVideo) out.codecVideo = meta.codecVideo;
  if (meta.codecAudio) out.codecAudio = meta.codecAudio;
  if (meta.bitrateKbps !== undefined) out.bitrateKbps = meta.bitrateKbps;
  if (meta.fingerprint) out.fingerprint = meta.fingerprint;
  if (meta.hotlinkProtected !== undefined) out.hotlinkProtected = meta.hotlinkProtected;
  return out;
}

// Re-exports
import type { JobView } from "../shared/types";
export type { JobView };
