// Дедупликация (ТЗ §9): canonical URL страниц, групп изображений и fingerprint.
import { canonicalUrl, variantGroupKey } from "../shared/utils";

export class Deduplicator {
  private visitedPages = new Set<string>();
  private queuedPages = new Set<string>();
  private visitedImages = new Set<string>();
  private fingerprints = new Map<string, string>();

  /** Канонический ключ страницы. */
  pageKey(url: string): string {
    return canonicalUrl(url);
  }

  isPageVisited(url: string): boolean {
    return this.visitedPages.has(this.pageKey(url));
  }

  isPageQueued(url: string): boolean {
    return this.queuedPages.has(this.pageKey(url));
  }

  markPageQueued(url: string): void {
    this.queuedPages.add(this.pageKey(url));
  }

  markPageVisited(url: string): boolean {
    const k = this.pageKey(url);
    if (this.visitedPages.has(k)) return false;
    this.visitedPages.add(k);
    this.queuedPages.delete(k);
    return true;
  }

  /** Регистрирует URL изображения. true — новое. */
  registerImage(imageUrl: string): boolean {
    const k = variantGroupKey(imageUrl);
    if (this.visitedImages.has(k)) return false;
    this.visitedImages.add(k);
    return true;
  }

  hasImage(imageUrl: string): boolean {
    return this.visitedImages.has(variantGroupKey(imageUrl));
  }

  /** Fingerprint: изображения с одинаковым контентом считаются одним. */
  registerFingerprint(fp: string): boolean {
    // Используем полный fingerprint как ключ — усечение до 16 символов давало коллизии.
    if (this.fingerprints.has(fp)) return false;
    this.fingerprints.set(fp, fp);
    return true;
  }

  get visitedPagesCount(): number {
    return this.visitedPages.size;
  }

  get queuedPagesCount(): number {
    return this.queuedPages.size;
  }
}