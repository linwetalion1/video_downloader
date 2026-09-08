// Crawler: оркестрация discovery/scan/metadata/download (ТЗ §7, §10, §19–21, §37).
import { detectImages } from "../content/dom-image-detector";
import { extractLinks } from "../content/link-detector";
import { Deduplicator } from "./deduplicator";
import {
    hostnameOf, normalizeUrl, pickPrimaryVariant, uid,
} from "../shared/utils";
import { RobotsTxt } from "./robots";
import { RateLimiter } from "./rate-limiter";
import { Scheduler } from "./scheduler";
import { httpFetch, isHtmlContentType } from "./http";
import { resolveImageMetadata } from "../images/metadata";
import { downloadImage, resolveCandidateFilename } from "../images/downloader";
import { PRIORITIES } from "../shared/constants";
import type {
  ImageCandidate, JobError, JobMode, JobStats, JobStatus, JobView,
  RawHit, Settings, Task, TaskCounts, TaskType, UILogEntry,
} from "../shared/types";

export interface CrawlerDeps {
  settings: Settings;
  rootUrl: string;
  mode: JobMode;
  ensureOriginPermission: (url: string) => Promise<boolean>;
  hasOriginPermission?: (url: string) => Promise<boolean>;
  persist: () => void;
  fetchLike?: typeof fetch;
  onEvent: (ev: CrawlerEvent) => void;
}

export type CrawlerEvent =
  | { type: "candidate"; candidate: ImageCandidate }
  | { type: "candidate_update"; id: string; patch: Partial<ImageCandidate> }
  | { type: "stats"; stats: JobStats }
  | { type: "status"; status: JobStatus }
  | { type: "tasks"; counts: TaskCounts }
  | { type: "error"; error: JobError }
  | { type: "log"; entry: UILogEntry };

const MULTI_TLDS = new Set([
  "com", "co", "org", "net", "gov", "edu", "ac", "ne", "gouv", "govt", "gob", "gen", "info", "mil",
]);

export class Crawler {
  readonly jobId: string;
  readonly mode: JobMode;
  readonly rootUrl: string;
  readonly settings: Settings;

  private deps: CrawlerDeps;
  private candidates = new Map<string, ImageCandidate>();
  private dedup = new Deduplicator();
  private robotsCache = new Map<string, RobotsTxt>();
  private contentDisposition = new Map<string, string | undefined>();
  private pageLimiter: RateLimiter;
  private imageLimiter: RateLimiter;
  private downloadLimiter: RateLimiter;
  private scheduler: Scheduler;
  private status: JobStatus = "idle";
  private startedAt?: number;
  private finishedAt?: number;
  private stats: JobStats = {
    pagesVisited: 0, imagesFound: 0, downloadsCompleted: 0, downloadBytes: 0,
    errors: 0, limitImagesReached: false, limitPagesReached: false,
  };
  private errors: JobError[] = [];
  private logTail: UILogEntry[] = [];
  private plannedDownloadBytes = 0;
  private pageTitleById = new Map<string, string>();
  private pageIndex = new Map<string, number>();

  static fromSnapshot(view: JobView, deps: CrawlerDeps): Crawler {
    const c = new Crawler({ ...deps, settings: view.settings, rootUrl: view.rootUrl || deps.rootUrl, mode: view.mode });
    (c as { jobId: string }).jobId = view.jobId || c.jobId;
    c.startedAt = view.startedAt;
    c.finishedAt = undefined;
    c.status = "idle";
    c.stats = { ...view.stats };
    c.errors = [...(view.errors ?? [])];
    c.logTail = [...(view.logTail ?? [])];
    for (const cand of view.candidates ?? []) {
      const copy = { ...cand, selected: false, status: cand.status === "downloaded" ? "downloaded" : cand.status === "failed" ? "failed" : "ready" } as ImageCandidate;
      c.candidates.set(copy.id, copy);
      c.dedup.registerImage(copy.imageUrl);
      if (copy.fingerprint) c.dedup.registerFingerprint(copy.fingerprint);
    }
    c.log("INFO", `Восстановлено из снимка: ${c.candidates.size} кандидатов, скачано ${c.stats.downloadsCompleted}`);
    return c;
  }

  constructor(deps: CrawlerDeps) {
    this.deps = deps;
    this.jobId = uid("job");
    this.mode = deps.mode;
    this.rootUrl = deps.rootUrl;
    this.settings = deps.settings;
    this.pageLimiter = new RateLimiter({
      minMs: deps.settings.pageDelayMin, maxMs: deps.settings.pageDelayMax, maxBackoffMs: deps.settings.maxBackoffMs,
    });
    this.imageLimiter = new RateLimiter({
      minMs: deps.settings.imageDelayMin, maxMs: deps.settings.imageDelayMax, maxBackoffMs: deps.settings.maxBackoffMs,
    });
    this.downloadLimiter = new RateLimiter({
      minMs: deps.settings.downloadDelayMin, maxMs: deps.settings.downloadDelayMax, maxBackoffMs: deps.settings.maxBackoffMs,
    });

    this.scheduler = new Scheduler({
      concurrency: deps.settings.concurrency,
      maxRetries: deps.settings.maxRetries,
      timeouts: {
        PAGE_DISCOVERY: deps.settings.pageTimeout,
        PAGE_SCAN: deps.settings.pageTimeout,
        IMAGE_METADATA: deps.settings.imageTimeout,
        IMAGE_DOWNLOAD: deps.settings.downloadTimeout,
      },
      handle: this.handleTask,
      onCounts: (counts) => this.emit({ type: "tasks", counts }),
      onStatus: (status) => this.setStatus(status),
      onRetry: (_t, err) => this.log("WARN", `Retry: ${err}`),
      onFailure: (t, err) => this.registerErrorSimple(t.type, t.url, err, false),
      log: (level, msg) => this.log(level, msg),
    });
  }

  // ─── Публичный API ──────────────────────────────────────────────────────

  startCrawl(): void {
    this.startedAt = Date.now();
    this.dedup.markPageQueued(this.rootUrl);
    this.scheduler.enqueue({
      type: "PAGE_DISCOVERY", url: this.rootUrl, depth: 0,
      priority: PRIORITIES.DISCOVERY_D0,
    });
    this.scheduler.start();
  }

  /** Запуск только обработки очереди (page-режим: метаданные и загрузки, без обхода). */
  startSchedulerOnly(): void {
    this.startedAt ??= Date.now();
    this.scheduler.start();
  }

  /** Кандидаты из живого сканирования (текущая страница, content script). */
  addPageHits(hits: RawHit[], sourcePageUrl: string, depth: number, pageTitle?: string): void {
    this.startedAt ??= Date.now();
    for (const hit of hits) this.addCandidate(hit, sourcePageUrl, depth, pageTitle);
    if (depth === 0) this.stats.pagesVisited = Math.max(this.stats.pagesVisited, 1);
    this.emitStats();
  }

  addSourcePageTitle(pageUrl: string, title: string): void {
    this.pageTitleById.set(pageUrl, title);
  }

  enqueueDownloads(ids: string[]): void {
    const maxBytes = this.settings.maxTotalDownloadMB * 1024 * 1024;
    let added = 0;
    let skippedDownloaded = 0;
    for (const id of ids) {
      const cand = this.candidates.get(id);
      if (!cand) continue;
      if (cand.status === "downloaded") { skippedDownloaded++; continue; }
      // Было: if (checking) continue — из-за этого ранний клик "Скачать выбранные" (до завершения IMAGE_METADATA)
      // давал 0 в очереди и "Повторная обработка: 0". Теперь checking не пропускаем.
      if (cand.status === "failed" && cand.retryKind === "metadata") {
        this.enqueueMetadata(cand);
        added++;
        continue;
      }
      const size = cand.fileSize ?? 0;
      if (size > 0 && this.plannedDownloadBytes + size > maxBytes) {
        this.patch(id, { status: "failed", error: "Превышен лимит общего объёма", retryKind: "download" });
        this.registerErrorSimple("IMAGE_DOWNLOAD", cand.imageUrl, "Превышен лимит общего объёма", false);
        continue;
      }
      this.plannedDownloadBytes += size;
      const filename = this.resolveFilename(cand);
      this.scheduler.enqueue({
        type: "IMAGE_DOWNLOAD",
        url: cand.imageUrl,
        priority: PRIORITIES.DOWNLOAD,
        depth: cand.depth,
        data: { id, filename, size },
      });
      this.patch(id, { status: "discovered" });
      added++;
    }
    if (added > 0) {
      this.log("INFO", `Поставлено в очередь на скачивание: ${added} (очередь DL: ${this.scheduler.queuedByType()["IMAGE_DOWNLOAD"]}, всего queued: ${this.scheduler.getCounts().queued}, running: ${this.scheduler.getCounts().running}, статус: ${this.scheduler.getState()})`);
      this.ensureSchedulerRunning("DL");
    } else {
      const total = ids.length;
      this.log("WARN", `Скачивание не поставлено: выбрано=${total}, добавлено=0, уже_скачано=${skippedDownloaded}, статус_кандидатов=${[...this.candidates.values()].filter(c=>ids.includes(c.id)).map(c=>c.status).join(",") || "(нет выбранных)"} | очередь DL ${this.scheduler.queuedByType()["IMAGE_DOWNLOAD"]} | scheduler ${this.scheduler.getState()}`);
    }
  }

  retryFailed(): void {
    let n = 0;
    for (const cand of this.candidates.values()) {
      if (cand.status !== "failed") continue;
      const kind = cand.retryKind ?? (cand.width === undefined || cand.fileSize === undefined ? "metadata" : "download");
      const patchBase = { status: "discovered" as const, error: undefined, retryKind: undefined };
      if (kind === "metadata") {
        this.patch(cand.id, patchBase);
        this.enqueueMetadata(cand);
      } else {
        this.patch(cand.id, patchBase);
        this.enqueueDownloads([cand.id]);
      }
      n++;
    }
    this.errors = this.errors.filter((e) => e.retryable);
    this.log("INFO", `Повторная обработка: ${n} (очередь после: DL ${this.scheduler.queuedByType()["IMAGE_DOWNLOAD"]}, META ${this.scheduler.queuedByType()["IMAGE_METADATA"]}, статус ${this.scheduler.getState()})`);
    if (n > 0) this.ensureSchedulerRunning("retry");
  }

  private ensureSchedulerRunning(reason: string): void {
    const st = this.scheduler.getState();
    if (st === "completed" || st === "idle" || st === "cancelled" || st === "failed") {
      this.log("DEBUG", `▶ Перезапуск scheduler для ${reason} (статус был ${st})`);
      this.finishedAt = undefined;
      this.scheduler.start();
    }
  }

  pause(): void {
    this.scheduler.pause();
  }
  resume(): void {
    this.scheduler.resume();
  }
  cancel(): void {
    this.scheduler.cancel();
    this.setStatus("cancelled");
    this.finishedAt = Date.now();
  }

  getState(): JobStatus {
    return this.status;
  }

  snapshot(): JobView {
    return {
      jobId: this.jobId,
      mode: this.mode,
      rootUrl: this.rootUrl,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      settings: this.settings,
      candidates: [...this.candidates.values()],
      errors: [...this.errors],
      taskCounts: this.scheduler.getCounts(),
      queueByType: this.scheduler.queuedByType(),
      limiterInfo: {
        page: this.pageLimiter.describe(),
        image: this.imageLimiter.describe(),
        download: this.downloadLimiter.describe(),
      },
      msUntilNextRetry: this.scheduler.msUntilNextReady(),
      stats: { ...this.stats },
      logTail: [...this.logTail],
    };
  }

  // ─── Обработчики задач ──────────────────────────────────────────────────

  private handleTask = async (t: Task): Promise<{ ok: boolean; skipped?: boolean; retryable?: boolean; error?: string }> => {
    try {
      switch (t.type) {
        case "PAGE_DISCOVERY": return await this.taskDiscovery(t);
        case "PAGE_SCAN": return await this.taskScan(t);
        case "IMAGE_METADATA": return await this.taskMetadata(t);
        case "IMAGE_DOWNLOAD": return await this.taskDownload(t);
      }
    } catch (e) {
      const err = e as { code?: string; retryable?: boolean; message?: string };
      return { ok: false, retryable: !!err.retryable, error: err.message || String(e) };
    }
    return { ok: true };
  };

  private async waitWithLog(limiter: RateLimiter, label: string, url: string): Promise<void> {
    const delay = limiter.nextDelayMs();
    if (delay > 50) {
      this.log("DEBUG", `⏳ Ждём ${Math.round(delay)}ms перед ${label} ${url} [${limiter.describe()}]`);
    }
    const t0 = Date.now();
    await limiter.wait(delay);
    const spent = Date.now() - t0;
    if (spent > 100) this.log("DEBUG", `▶ Старт ${label} ${url} (ждали ${spent}ms)`);
  }

  private async taskDiscovery(t: Task): Promise<{ ok: boolean; skipped?: boolean }> {
    if (this.stats.limitPagesReached || this.stats.limitImagesReached) {
      return { ok: true, skipped: true };
    }
    await this.waitWithLog(this.pageLimiter, "PAGE_DISCOVERY", t.url);

    // robots.txt (кэш по origin)
    const allowed = await this.robotsAllowed(t.url);
    if (!allowed) {
      this.log("INFO", `robots.txt: пропуск ${t.url}`);
      return { ok: true, skipped: true };
    }

    // HEAD-проверка: не переходим на не-HTML файлы (ТЗ §8)
    try {
      const head = await httpFetch({
        url: t.url, method: "HEAD", timeoutMs: this.settings.pageTimeout,
        fetchLike: this.deps.fetchLike, onStatus: (s) => this.pageLimiter.reportStatus(s),
      });
      if (!head.ok) return { ok: true, skipped: true };
      const ct = head.headers["content-type"];
      if (ct && !isHtmlContentType(ct)) {
        this.log("DEBUG", `Не HTML: ${t.url} (${ct})`);
        return { ok: true, skipped: true };
      }
    } catch {
      // HEAD запрещён/ошибся — всё равно пробуем GET в taskScan
    }

    this.scheduler.enqueue({ type: "PAGE_SCAN", url: t.url, depth: t.depth, priority: scanPriority(t.depth) });
    return { ok: true };
  }

  private async taskScan(t: Task): Promise<{ ok: boolean; skipped?: boolean }> {
    if (this.stats.limitPagesReached || this.stats.limitImagesReached) {
      return { ok: true, skipped: true };
    }
    await this.waitWithLog(this.pageLimiter, "PAGE_SCAN", t.url);
    const res = await httpFetch({
      url: t.url, method: "GET", timeoutMs: this.settings.pageTimeout,
      fetchLike: this.deps.fetchLike, onStatus: (s) => this.pageLimiter.reportStatus(s),
    });
    if (!res.ok) return { ok: true, skipped: true };
    if (!res.isHtml || !res.bodyText) return { ok: true, skipped: true };

    if (!this.dedup.markPageVisited(res.finalUrl || t.url)) {
      return { ok: true, skipped: true };
    }
    this.stats.pagesVisited++;
    if (this.stats.pagesVisited > this.settings.maxPages) {
      this.stats.limitPagesReached = true;
      this.emitStats();
      return { ok: true, skipped: true };
    }
    this.emitStats();

    let doc: Document;
    const g: unknown = globalThis as unknown;
    if (typeof (g as { DOMParser?: typeof DOMParser }).DOMParser !== "undefined") {
      doc = new (g as { DOMParser: typeof DOMParser }).DOMParser().parseFromString(res.bodyText, "text/html");
    } else {
      // Service Worker MV3: DOMParser недоступен → используем linkedom (лёгкий, без нативных зависимостей)
      const { parseHTML } = await import("linkedom");
      const parsed = parseHTML(res.bodyText);
      doc = parsed.document as unknown as Document;
    }
    const baseUrl = res.finalUrl || t.url;
    this.addSourcePageTitle(baseUrl, doc.title);

    // Сначала полностью обрабатываем страницу, потом ссылки следующего уровня (ТЗ §10).
    const hits = detectImages(doc, { baseUrl, live: false });
    for (const hit of hits) this.addCandidate(hit, baseUrl, t.depth);
    const links = extractLinks(doc, baseUrl);
    for (const link of links) await this.maybeEnqueuePage(link, t.depth + 1);

    this.deps.persist();
    return { ok: true };
  }

  private async taskMetadata(t: Task): Promise<{ ok: boolean; skipped?: boolean; retryable?: boolean; error?: string }> {
    const cand = this.candidates.get(t.data?.id as string);
    if (!cand) return { ok: true, skipped: true };
    const id = cand.id;

    await this.waitWithLog(this.imageLimiter, "IMAGE_METADATA", cand.imageUrl);
    this.patch(id, { status: "checking" });
    try {
      const meta = await resolveImageMetadata(cand.imageUrl, {
        timeoutMs: this.settings.imageTimeout,
        knownWidth: cand.naturalWidth,
        knownHeight: cand.naturalHeight,
        fetchLike: this.deps.fetchLike,
        onStatus: (s) => this.imageLimiter.reportStatus(s),
      });
      const width = meta.width ?? cand.naturalWidth;
      const height = meta.height ?? cand.naturalHeight;
      this.contentDisposition.set(cand.canonicalUrl, meta.contentDisposition);
      if (meta.fingerprint && !this.dedup.registerFingerprint(meta.fingerprint)) {
        this.patch(id, { status: "skipped", fingerprint: meta.fingerprint, width, height, fileSize: meta.fileSize });
        this.emitStats();
        return { ok: true, skipped: true };
      }
      const latest = this.candidates.get(id);
      const keepStatus = latest && (latest.status === "downloaded" || latest.status === "failed" && latest.retryKind === "download");
      this.patch(id, {
        width,
        height,
        fileSize: meta.fileSize,
        mimeType: meta.mimeType,
        extension: meta.extension || cand.extension || extFromUrl(cand.imageUrl),
        fingerprint: meta.fingerprint,
        aspectRatio: width && height ? width / height : undefined,
        ...(keepStatus ? {} : { status: "ready" as const }),
      });
      return { ok: true };
    } catch (e) {
      const err = e as { message?: string; retryable?: boolean };
      this.patch(id, { status: "failed", error: filteredError(err.message), retryKind: "metadata" });
      this.registerErrorSimple("IMAGE_METADATA", cand.imageUrl, err.message || String(e), !!err.retryable);
      return { ok: false, retryable: !!err.retryable, error: err.message || String(e) };
    }
  }

  private async taskDownload(t: Task): Promise<{ ok: boolean; skipped?: boolean; retryable?: boolean; error?: string }> {
    const cand = this.candidates.get(t.data?.id as string);
    if (!cand) return { ok: true, skipped: true };
    const id = cand.id;
    const filename = (t.data?.filename as string | undefined) || this.resolveFilename(cand);

    await this.waitWithLog(this.downloadLimiter, "IMAGE_DOWNLOAD", cand.imageUrl);
    this.patch(id, { status: "checking" });
    const res = await downloadImage({
      url: cand.imageUrl,
      candidateFilename: filename,
      downloadRoot: this.settings.saveTo,
      folderMode: this.settings.folderMode,
      sourcePageUrl: cand.sourcePageUrl,
      depth: cand.depth,
      timeoutMs: this.settings.downloadTimeout,
      mimeType: cand.mimeType,
      extension: cand.extension,
      ensurePermission: this.deps.ensureOriginPermission,
    });

    const size = cand.fileSize ?? 0;
    if (res.ok) {
      this.plannedDownloadBytes = Math.max(0, this.plannedDownloadBytes - size);
      this.stats.downloadsCompleted++;
      this.stats.downloadBytes += res.bytes ?? size;
      this.patch(id, { status: "downloaded" });
      this.emitStats();
      return { ok: true };
    }
    this.plannedDownloadBytes = Math.max(0, this.plannedDownloadBytes - size);
    this.patch(id, { status: "failed", error: `DL: ${res.error}`, retryKind: "download" });
    this.registerErrorSimple("IMAGE_DOWNLOAD", cand.imageUrl, res.error || "download error", !!res.retryable);
    return { ok: false, retryable: !!res.retryable, error: res.error };
  }

  // ─── Внутренняя логика ──────────────────────────────────────────────────

  private addCandidate(hit: RawHit, sourcePageUrl: string, depth: number, pageTitle?: string): void {
    if (this.stats.imagesFound >= this.settings.maxImages) {
      if (!this.stats.limitImagesReached) {
        this.stats.limitImagesReached = true;
        this.log("WARN", `Поиск остановлен: достигнут установленный лимит изображений (${this.settings.maxImages})`);
        this.emitStats();
      }
      return;
    }
    const primary = pickPrimaryVariant(hit.variants);
    if (!primary) return;
    if (!this.dedup.registerImage(primary.url)) return;

    const id = uid("img");
    const width = hit.naturalWidth;
    const height = hit.naturalHeight;
    const cand: ImageCandidate = {
      id,
      imageUrl: primary.url,
      canonicalUrl: normalizeUrl(primary.url) ?? primary.url,
      variants: [primary, ...hit.variants.filter((v) => v !== primary)].map((v) => ({
        url: v.url,
        canonicalUrl: normalizeUrl(v.url) ?? v.url,
        width: v.width,
        height: v.height,
        sourceType: v.sourceType,
      })),
      sourcePageUrl,
      sourcePageTitle: pageTitle || this.pageTitleById.get(sourcePageUrl),
      sourceDomain: hostnameOf(primary.url),
      width,
      height,
      naturalWidth: width,
      naturalHeight: height,
      aspectRatio: width && height ? width / height : undefined,
      displayWidth: hit.displayWidth,
      displayHeight: hit.displayHeight,
      depth,
      sourceType: primary.sourceType,
      alt: hit.alt,
      title: hit.title,
      selected: false,
      status: "discovered",
    };
    if (!this.pageIndex.has(sourcePageUrl)) {
      this.pageIndex.set(sourcePageUrl, this.pageIndex.size + 1);
    }
    this.candidates.set(id, cand);
    this.stats.imagesFound++;
    this.emit({ type: "candidate", candidate: cand });
    this.emitStats();
    this.enqueueMetadata(cand);
  }

  private enqueueMetadata(cand: ImageCandidate): void {
    this.scheduler.enqueue({
      type: "IMAGE_METADATA",
      url: cand.imageUrl,
      priority: metadataPriority(cand.depth),
      depth: cand.depth,
      data: { id: cand.id },
    });
  }

  private async maybeEnqueuePage(pageUrl: string, depth: number): Promise<void> {
    if (depth > this.settings.maxDepth) return;
    if (this.stats.limitPagesReached || this.stats.limitImagesReached) return;
    if (this.dedup.visitedPagesCount + this.dedup.queuedPagesCount >= this.settings.maxPages) {
      if (!this.stats.limitPagesReached) {
        this.stats.limitPagesReached = true;
        this.log("WARN", `Достигнут лимит страниц (${this.settings.maxPages}) — discovery остановлен`);
        this.emitStats();
      }
      return;
    }
    if (!this.inScope(pageUrl)) return;
    if (this.dedup.isPageVisited(pageUrl) || this.dedup.isPageQueued(pageUrl)) return;
    if (this.deps.hasOriginPermission) {
      const ok = await this.deps.hasOriginPermission(pageUrl);
      if (!ok) {
        this.log("DEBUG", `Нет host-доступа, пропуск: ${pageUrl}`);
        return;
      }
    }

    this.dedup.markPageQueued(pageUrl);
    this.scheduler.enqueue({
      type: "PAGE_DISCOVERY",
      url: this.dedup.pageKey(pageUrl),
      depth,
      priority: discoveryPriority(depth),
    });
  }

  private inScope(url: string): boolean {
    if (this.settings.scope === "all") return true;
    if (this.settings.scope === "origin") {
      const a = originOfFast(this.rootUrl);
      const b = originOfFast(url);
      return a === b;
    }
    return registrableDomain(this.rootUrl) === registrableDomain(url);
  }

  private async robotsAllowed(url: string): Promise<boolean> {
    if (!this.settings.respectRobotsTxt) return true;
    const o = originOfFast(url);
    if (!o) return true;
    let rt = this.robotsCache.get(o);
    if (!rt) {
      rt = await RobotsTxt.fetch(o, {
        timeoutMs: this.settings.pageTimeout,
        fetchLike: this.deps.fetchLike,
      });
      if (rt.crawlDelay) {
        this.pageLimiter.setFloorMs(Math.min(Math.max(this.settings.pageDelayMin, rt.crawlDelay * 1000), this.settings.pageDelayMax));
      }
      this.robotsCache.set(o, rt);
    }
    return rt.allows(url);
  }

  private resolveFilename(cand: ImageCandidate): string {
    const cd = this.contentDisposition.get(cand.canonicalUrl);
    return resolveCandidateFilename(cand, cd);
  }

  private patch(id: string, patch: Partial<ImageCandidate>): void {
    const c = this.candidates.get(id);
    if (!c) return;
    Object.assign(c, patch);
    this.emit({ type: "candidate_update", id, patch });
  }

  private registerErrorSimple(taskType: TaskType, url: string, message: string, retryable: boolean): void {
    this.stats.errors++;
    const error: JobError = { id: uid("err"), taskType, url, message, retryable, time: Date.now() };
    this.errors.push(error);
    if (this.errors.length > 500) this.errors.splice(0, this.errors.length - 500);
    this.emit({ type: "error", error });
    this.emitStats();
  }

  private log(level: UILogEntry["level"], message: string): void {
    const entry: UILogEntry = { time: Date.now(), level, message };
    this.logTail.push(entry);
    if (this.logTail.length > 200) this.logTail.splice(0, this.logTail.length - 200);
    this.emit({ type: "log", entry });
  }

  private setStatus(status: JobStatus): void {
    this.status = status;
    this.emit({ type: "status", status });
    if (status === "completed" || status === "cancelled" || status === "failed") {
      this.finishedAt = Date.now();
      this.deps.persist();
    }
  }

  private emitStats(): void {
    this.emit({ type: "stats", stats: { ...this.stats } });
  }

  private emit(ev: CrawlerEvent): void {
    this.deps.onEvent(ev);
  }
}

// ─── Вспомогательные функции ──────────────────────────────────────────────

function priorityFor(base: number, depth: number): number {
  return base - depth * 300;
}

function discoveryPriority(depth: number): number {
  return priorityFor(PRIORITIES.DISCOVERY_D0, depth);
}

function scanPriority(depth: number): number {
  return priorityFor(PRIORITIES.SCAN_D0, depth);
}

function metadataPriority(depth: number): number {
  return priorityFor(PRIORITIES.METADATA_D0, depth);
}

function originOfFast(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Приближение registrable domain (eTLD+1 без PSL — см. README). */
export function registrableDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const labels = host.split(".");
    if (labels.length <= 2) return host;
    const tld = labels[labels.length - 1];
    const sld = labels[labels.length - 2];
    if (/^[a-z]{2}$/.test(tld) && MULTI_TLDS.has(sld)) return labels.slice(-3).join(".");
    return labels.slice(-2).join(".");
  } catch {
    return url;
  }
}

function extFromUrl(url: string): string | undefined {
  try {
    const p = new URL(url).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(p);
    return m ? m[1].toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function filteredError(msg?: string): string | undefined {
  if (!msg) return undefined;
  return msg.length > 300 ? msg.slice(0, 300) : msg;
}