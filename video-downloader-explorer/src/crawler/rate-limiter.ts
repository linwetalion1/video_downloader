// Rate limiter с backoff. Логирует каждое изменение фактора.
import { clamp, randomDelay, sleep } from "../shared/utils";
import { downloadLog } from "../shared/logger";

export interface RateLimiterOptions {
  minMs: number;
  maxMs: number;
  maxBackoffMs: number;
}

export class RateLimiter {
  private minMs: number;
  private maxMs: number;
  private readonly maxBackoffMs: number;
  private backoffFactor = 1;

  constructor(opts: RateLimiterOptions) {
    this.minMs = opts.minMs;
    this.maxMs = opts.maxMs;
    this.maxBackoffMs = opts.maxBackoffMs;
  }

  nextDelayMs(): number {
    const base = randomDelay(this.minMs, this.maxMs);
    return clamp(base * this.backoffFactor, base, this.maxBackoffMs);
  }

  async wait(): Promise<number> {
    const ms = this.nextDelayMs();
    if (ms > 0) await sleep(ms);
    return ms;
  }

  describe(): string {
    return `${this.minMs}-${this.maxMs}ms ×${this.backoffFactor.toFixed(2)}`;
  }

  reportStatus(status: number | undefined, url?: string): void {
    if (status === 429 || status === 503) {
      const prev = this.backoffFactor;
      this.backoffFactor = Math.min(this.backoffFactor * 2, this.maxBackoffMs / Math.max(this.minMs, 1));
      if (this.backoffFactor !== prev) {
        downloadLog.warn(`Backoff ↑ ${prev.toFixed(2)}× → ${this.backoffFactor.toFixed(2)}× (HTTP ${status}${url ? " на " + url : ""})`);
      }
    } else if (status === undefined) {
      const prev = this.backoffFactor;
      this.backoffFactor = Math.min(this.backoffFactor * 1.4, this.maxBackoffMs / Math.max(this.minMs, 1));
      if (this.backoffFactor !== prev && prev > 1) {
        downloadLog.warn(`Backoff ↑ ${prev.toFixed(2)}× → ${this.backoffFactor.toFixed(2)}× (сетевая ошибка)`);
      }
    } else if (status >= 200 && status < 400) {
      if (this.backoffFactor > 1) {
        this.backoffFactor = Math.max(1, this.backoffFactor * 0.75);
      }
    }
  }

  reset(): void {
    if (this.backoffFactor !== 1) downloadLog.info(`Backoff reset → 1.00×`);
    this.backoffFactor = 1;
  }

  get factor(): number { return this.backoffFactor; }
}
