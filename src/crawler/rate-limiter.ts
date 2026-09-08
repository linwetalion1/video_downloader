// Ограничитель скорости с автоматическим backoff (ТЗ §34–35).
import { clamp, randomDelay, sleep } from "../shared/utils";

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
  private floorMs = 0;

  constructor(opts: RateLimiterOptions) {
    this.minMs = opts.minMs;
    this.maxMs = opts.maxMs;
    this.maxBackoffMs = opts.maxBackoffMs;
  }

  /** Минимальный пол дополнительной задержки (например от Crawl-delay). */
  setFloorMs(ms: number): void {
    this.floorMs = Math.max(this.floorMs, ms);
  }

  /** Случайная задержка вида min + random*(max-min), при бэк-оффе умноженная. */
  async wait(explicitMs?: number): Promise<void> {
    const delay = explicitMs ?? this.nextDelayMs();
    if (delay > 0) await sleep(delay);
  }

  nextDelayMs(): number {
    const base = Math.max(randomDelay(this.minMs, this.maxMs), this.floorMs);
    return clamp(base * this.backoffFactor, base, this.maxBackoffMs);
  }

  describe(): string {
    const base = `${this.minMs}-${this.maxMs}ms`;
    const floor = this.floorMs > 0 ? ` floor ${this.floorMs}ms` : "";
    const bf = this.backoffFactor !== 1 ? ` ×${this.backoffFactor.toFixed(2)}` : "";
    return `${base}${floor}${bf}`;
  }

  /** Сколько осталось ждать до следующего слота (для UI) */
  estimateRemainingMs(): number {
    // Для RateLimiter ожидание только внутри wait(), вне — 0. Для UI показываем nextDelay.
    return 0;
  }

  /** Обратная связь от ответов сервера. */
  reportStatus(status: number | undefined): void {
    if (status === 429 || status === 503) {
      // ТЗ §35: server ограничивает → увеличиваем задержку.
      this.backoffFactor = Math.min(this.backoffFactor * 2, this.maxBackoffMs / Math.max(this.minMs, 1));
    } else if (status === undefined) {
      // сетевая ошибка — мягкий backoff
      this.backoffFactor = Math.min(this.backoffFactor * 1.4, this.maxBackoffMs / Math.max(this.minMs, 1));
    } else if (status >= 200 && status < 400) {
      // нормализация: постепенное возвращение к обычному интервалу
      this.backoffFactor = Math.max(1, this.backoffFactor * 0.75);
    }
  }

  reset(): void {
    this.backoffFactor = 1;
    this.floorMs = 0;
  }

  get factor(): number {
    return this.backoffFactor;
  }
}