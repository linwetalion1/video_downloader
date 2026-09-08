// Центральный scheduler (ТЗ §20, §22, §13.3): concurrency, timeout, retry, pause/resume/cancel.
import type { JobStatus, Task, TaskCounts, TaskType } from "../shared/types";
import { uid } from "../shared/utils";
import { TaskQueue } from "./queue";
import { makeHttpError } from "./http";

export interface TaskResult {
  ok: boolean;
  skipped?: boolean;
  retryable?: boolean;
  error?: string;
}

export interface SchedulerOptions {
  concurrency: number;
  maxRetries: number;
  timeouts: Record<TaskType, number>;
  handle: (task: Task) => Promise<TaskResult>;
  onCounts: (counts: TaskCounts) => void;
  onStatus: (status: JobStatus) => void;
  onTaskFinished?: (task: Task) => void;
  onRetry?: (task: Task, error: string) => void;
  onFailure?: (task: Task, error: string) => void;
  log?: (level: "INFO" | "WARN" | "ERROR" | "DEBUG", msg: string) => void;
}

export class Scheduler {
  private queue = new TaskQueue();
  private running = 0;
  private status: JobStatus = "idle";
  private counts: TaskCounts = { queued: 0, running: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0, total: 0 };
  private opts: SchedulerOptions;
  private loopPromise: Promise<void> | null = null;
  private lastRetryDelay = 500;
  private lastConcurrencyLog = 0;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
  }

  enqueue(task: Omit<Task, "id" | "createdAt" | "status" | "retryCount"> & { id?: string }): Task {
    const t: Task = {
      id: task.id || uid("task"),
      type: task.type,
      url: task.url,
      priority: task.priority,
      depth: task.depth,
      createdAt: Date.now(),
      status: "QUEUED",
      retryCount: 0,
      data: task.data,
    };
    this.queue.push(t);
    this.counts.queued++;
    this.counts.total++;
    this.emitCounts();
    return t;
  }

  enqueueRetry(task: Task): void {
    task.status = "WAITING";
    const delay = this.lastRetryDelay;
    this.lastRetryDelay = Math.min(this.lastRetryDelay * 2, 10_000);
    task.retryAt = Date.now() + delay;
    this.queue.push(task);
    this.counts.queued++;
    this.emitCounts();
  }

  start(): void {
    if (this.status === "running" || this.status === "paused") return;
    this.status = "running";
    this.opts.onStatus("running");
    if (!this.loopPromise) this.loopPromise = this.loop();
  }

  pause(): void {
    if (this.status !== "running") return;
    this.status = "paused";
    this.opts.onStatus("paused");
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.status = "running";
    this.opts.onStatus("running");
  }

  cancel(): void {
    if (this.status === "cancelled" || this.status === "completed") return;
    const remaining = this.queue.size;
    this.queue.clear();
    this.counts.queued = 0;
    this.counts.cancelled += remaining;
    // total должен учитывать и running (не только завершённые)
    this.counts.total = this.counts.completed + this.counts.failed + this.counts.skipped + this.counts.cancelled + this.counts.running;
    this.status = "cancelled";
    this.opts.onStatus("cancelled");
    this.emitCounts();
  }

  getState(): JobStatus {
    return this.status;
  }

  getCounts(): TaskCounts {
    return { ...this.counts };
  }

  /** До ближайшего retry осталось ms (0 если есть готовая задача) */
  msUntilNextReady(): number {
    if (this.queue.isEmpty) return 0;
    const now = Date.now();
    const peek = this.queue.peek();
    if (!peek) return 0;
    // Находим минимальный retryAt среди всех задач
    let minWait = Infinity;
    let hasReady = false;
    for (const t of this.queue.byType("PAGE_DISCOVERY").concat(this.queue.byType("PAGE_SCAN"), this.queue.byType("IMAGE_METADATA"), this.queue.byType("IMAGE_DOWNLOAD"))) {
      const at = t.retryAt ?? 0;
      if (at <= now) { hasReady = true; break; }
      minWait = Math.min(minWait, at - now);
    }
    // Если есть готовая — 0
    if (hasReady) return 0;
    // Иначе ищем через pop логику
    const next = this.queue.peek();
    if (next && (next.retryAt ?? 0) > now) return (next.retryAt ?? 0) - now;
    if (minWait !== Infinity) return Math.max(0, minWait);
    return 0;
  }

  queuedByType(): Record<TaskType, number> {
    return {
      PAGE_DISCOVERY: this.queue.byType("PAGE_DISCOVERY").length,
      PAGE_SCAN: this.queue.byType("PAGE_SCAN").length,
      IMAGE_METADATA: this.queue.byType("IMAGE_METADATA").length,
      IMAGE_DOWNLOAD: this.queue.byType("IMAGE_DOWNLOAD").length,
    };
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.status === "cancelled") break;
      if (this.status === "paused") {
        await sleepMs(150);
        continue;
      }
      if (this.running >= this.opts.concurrency) {
        const now = Date.now();
        if (now - this.lastConcurrencyLog > 2000) {
          this.lastConcurrencyLog = now;
          this.opts.log?.("DEBUG", `⏳ Слоты заняты: ${this.running}/${this.opts.concurrency} в работе, очередь ${this.queue.size} ждёт слота (конкурентность)`);
        }
        await sleepMs(50);
        continue;
      }
      const task = this.queue.pop();
      if (!task) {
        if (this.running === 0 && this.queue.isEmpty) {
          this.status = "completed";
          this.opts.onStatus("completed");
          break;
        }
        // Если есть только отложенные retry — показываем сколько ждать
        if (!this.queue.isEmpty) {
          const wait = this.msUntilNextReady();
          if (wait > 100) {
            this.opts.log?.("DEBUG", `⏳ Очередь на паузе: все ${this.queue.size} задач отложены, ближайшая через ${Math.round(wait)}ms (retry backoff)`);
            await sleepMs(Math.min(wait, 1000));
            continue;
          }
        }
        await sleepMs(100);
        continue;
      }
      this.running++;
      this.counts.queued--;
      this.counts.running++;
      task.status = "RUNNING";
      this.emitCounts();
      void this.run(task).finally(() => {
        this.running--;
        this.counts.running--;
      });
    }
    this.loopPromise = null;
  }

  private async run(task: Task): Promise<void> {
    const timeout = this.opts.timeouts[task.type];
    const result = await this.withTimeout(task, timeout);
    if (this.status === "cancelled") return;

    if (result.ok) {
      task.status = result.skipped ? "SKIPPED" : "SUCCESS";
      if (result.skipped) this.counts.skipped++;
      else this.counts.completed++;
      this.opts.onTaskFinished?.(task);
    } else if (result.retryable && task.retryCount < this.opts.maxRetries) {
      task.status = "WAITING";
      task.retryCount++;
      task.error = result.error;
      this.opts.onRetry?.(task, result.error || "error");
      this.enqueueRetry(task);
    } else {
      task.status = "FAILED";
      task.error = result.error;
      this.counts.failed++;
      this.opts.onTaskFinished?.(task);
      this.opts.onFailure?.(task, result.error || "error");
    }
    this.emitCounts();
  }

  private async withTimeout(task: Task, timeoutMs: number): Promise<TaskResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(makeHttpError(`Timeout (${timeoutMs}ms): ${task.url}`, "TIMEOUT", true));
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.opts.handle(task), timeout]);
    } catch (e) {
      const err = e as { code?: string; retryable?: boolean; message: string };
      if (err.code === "NO_PERMISSION") {
        return { ok: false, retryable: false, error: err.message };
      }
      const retryable = err.retryable ?? (err.code === "TIMEOUT" || err.code === "NETWORK_ERROR");
      return { ok: false, retryable, error: formatError(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  private emitCounts(): void {
    this.opts.onCounts({ ...this.counts });
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatError(e: { code?: string; retryable?: boolean; message: string }): string {
  const code = e.code ? `${e.code}: ` : "";
  return `${code}${e.message}`;
}