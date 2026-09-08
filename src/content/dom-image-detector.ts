// Детектор изображений в DOM. Работает и в контент-скрипте (live:true),
// и в service worker над DOMParser-документом (live:false).
//
// Глубокий обход: проникает в открытые shadow roots (важно для SPA/Web Components,
// например Google Labs), считает статистику для отладки.
import type { RawHit, RawVariant, SourceType } from "../shared/types";
import {
  IMAGE_EXT_SET,
  extensionFromUrl,
  isHttpUrl,
  normalizeUrl,
  parseSrcset,
  variantGroupKey,
  expandThumbUrl,
  pickPrimaryVariant,
} from "../shared/utils";

export interface DetectOptions {
  baseUrl: string;
  live: boolean;
}

/** Счётчик диагностики детектора. */
export interface DetectStatsAcc {
  imgElements: number;
  canvasElements: number;
  shadowRootsOpened: number;
  sourceTypeCounts: Partial<Record<SourceType, number>>;
}

const LAZY_ATTRS = [
  "data-src", "data-lazy-src", "data-lazy", "data-original", "data-original-src",
  "data-url", "data-image", "data-img", "data-photo-src", "data-echo", "data-src-large",
];

const OG_ATTRS: Array<[string, string]> = [
  ["property", "og:image"],
  ["property", "og:image:secure_url"],
  ["property", "og:image:url"],
  ["name", "twitter:image"],
  ["name", "twitter:image:src"],
  ["itemprop", "image"],
];

const BACKGROUND_STYLE_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/g;

function isUsableUrl(u: string): boolean {
  return isHttpUrl(u);
}

function pushVariant(list: RawVariant[], url: string, type: SourceType, w?: number, h?: number): void {
  if (!url) return;
  list.push({ url, width: w, height: h, sourceType: type });
}

function extractBackgroundUrls(style: string, baseUrl: string): string[] {
  const urls: string[] = [];
  BACKGROUND_STYLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BACKGROUND_STYLE_RE.exec(style)) !== null) {
    const u = m[2];
    if (!u || u.startsWith("data:")) continue;
    if (u.startsWith("var(") || u.includes("var(")) continue;
    const abs = normalizeUrl(u, baseUrl);
    if (abs && isUsableUrl(abs)) urls.push(abs);
  }
  return urls;
}

/**
 * Глубокий обход DOM с проникновением в открытые shadow roots.
 * Один проход по всем элементам (без повторных визитов).
 */
export function deepQueryAll(root: Document | Element, selector: string, stats?: DetectStatsAcc): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();
  const visitedRoots = new Set<Document | Element | ShadowRoot>();
  const visit = (r: Document | Element | ShadowRoot) => {
    if (visitedRoots.has(r)) return;
    visitedRoots.add(r);
    if ((r as Element).nodeType === 1) {
      try {
        if ((r as Element).matches?.(selector) && !seen.has(r as Element)) {
          seen.add(r as Element);
          out.push(r as Element);
        }
      } catch { /* ignore */ }
    }
    const direct = r.querySelectorAll(selector);
    for (let i = 0; i < direct.length; i++) {
      const el = direct[i];
      if (!seen.has(el)) {
        seen.add(el);
        out.push(el);
        if (stats) {
          const tag = (el as Element).tagName;
          if (tag === "IMG") stats.imgElements++;
          else if (tag === "CANVAS") stats.canvasElements++;
        }
      }
    }
    const all = r.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const isNew = !seen.has(el);
      if (isNew) {
        seen.add(el);
        if (stats) {
          const tag = el.tagName;
          if (tag === "IMG") stats.imgElements++;
          else if (tag === "CANVAS") stats.canvasElements++;
        }
      }
      // Shadow roots проверяем у всех элементов, даже если элемент уже был в out
      let sr: ShadowRoot | null = null;
      try {
        sr = (el as HTMLElement).shadowRoot;
      } catch {
        sr = null;
      }
      if (sr && !visitedRoots.has(sr)) {
        if (stats) stats.shadowRootsOpened++;
        visit(sr);
      }
    }
    // Если сам корень — элемент-хост с shadow root (monitorForImages: mutation — хост),
    // его shadow нужно обойти отдельно, т.к. querySelectorAll не проникает в него.
    if ((r as Node).nodeType === 1) {
      try {
        const rootSr = (r as HTMLElement).shadowRoot as ShadowRoot | null | undefined;
        if (rootSr && !visitedRoots.has(rootSr)) {
          if (stats) stats.shadowRootsOpened++;
          visit(rootSr);
        }
      } catch {
        // ignore
      }
    }
  };
  visit(root);
  return out;
}

/** Детектор над произвольным корнем (Document или Element — например, узел из MutationObserver). */
export function detectImagesInRoot(root: Document | Element, opts: DetectOptions, stats: DetectStatsAcc = emptyStats()): RawHit[] {
  const hits = new Map<string, RawHit>();
  const baseUrl = opts.baseUrl;
  const isDoc = root.nodeType === 9;

  const bump = (type: SourceType) => {
    stats.sourceTypeCounts[type] = (stats.sourceTypeCounts[type] ?? 0) + 1;
  };

  const push = (variants: RawVariant[], sourceType: SourceType, extra: Partial<RawHit> = {}) => {
    if (variants.length === 0) return;
    const key = variantGroupKey(variants[0].url);
    const existing = hits.get(key);
    if (existing) {
      const known = new Set(existing.variants.map((v) => variantGroupKey(v.url)));
      for (const v of variants) {
        const vk = variantGroupKey(v.url);
        if (!known.has(vk)) {
          existing.variants.push(v);
          known.add(vk);
        }
      }
      const best = pickPrimaryVariant(existing.variants);
      if (best && existing.variants[0] !== best) {
        existing.variants = [best, ...existing.variants.filter((v) => v !== best)];
      }
      if (!existing.naturalWidth && extra.naturalWidth) {
        existing.naturalWidth = extra.naturalWidth;
        existing.naturalHeight = extra.naturalHeight;
      }
      if (!existing.alt && extra.alt) existing.alt = extra.alt;
      if (!existing.title && extra.title) existing.title = extra.title;
      return;
    }
    const ordered = pickPrimaryVariant(variants);
    const rest = variants.filter((v) => v !== ordered);
    hits.set(variantGroupKey(ordered.url), {
      variants: [ordered, ...rest],
      ...extra,
    } as RawHit);
    bump(sourceType);
  };

  const normalize = (u: string): string | null => {
    const abs = normalizeUrl(u, baseUrl);
    return abs && isUsableUrl(abs) ? abs : null;
  };

  const handleImg = (img: HTMLImageElement) => {
    const list: RawVariant[] = [];
    const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
    for (const it of parseSrcset(srcset, baseUrl)) {
      const full = expandThumbUrl(it.url);
      if (full) pushVariant(list, full, "srcset", it.width, it.height);
      pushVariant(list, it.url, "srcset", it.width, it.height);
    }
    const src = img.getAttribute("src");
    const cur = opts.live ? img.currentSrc : undefined;
    if (cur && cur !== src && (cur.startsWith("http") || cur.startsWith("//"))) {
      const a = normalize(cur);
      if (a) {
        const full = expandThumbUrl(a);
        if (full) pushVariant(list, full, "img");
        pushVariant(list, a, "img");
      }
    }
    if (src) {
      const a = normalize(src);
      if (a) {
        const full = expandThumbUrl(a);
        if (full) pushVariant(list, full, "img");
        pushVariant(list, a, "img");
      }
    }

    for (const attr of LAZY_ATTRS) {
      const v = img.getAttribute(attr);
      if (!v) continue;
      const t = v.trim();
      if (!t) continue;
      if (/\s/.test(t) && !t.startsWith("data:")) {
        for (const it of parseSrcset(t, baseUrl)) {
          const full = expandThumbUrl(it.url);
          if (full) pushVariant(list, full, "lazy", it.width, it.height);
          pushVariant(list, it.url, "lazy", it.width, it.height);
        }
      } else {
        const a = normalize(t);
        if (a) {
          const full = expandThumbUrl(a);
          if (full) pushVariant(list, full, "lazy");
          pushVariant(list, a, "lazy");
        }
      }
    }
    if (list.length === 0) return;
    const extra: Partial<RawHit> = {};
    if (opts.live && img.complete && img.naturalWidth > 0) {
      extra.naturalWidth = img.naturalWidth;
      extra.naturalHeight = img.naturalHeight;
    }
    extra.alt = img.getAttribute("alt") || undefined;
    extra.title = img.getAttribute("title") || undefined;
    const primary = pickPrimaryVariant(list);
    push(list, primary.sourceType, extra);
  };

  // <img> (включая вложенные в <picture> и shadow root)
  for (const img of deepQueryAll(root, "img", stats)) handleImg(img as HTMLImageElement);

  // <picture> <source srcset>
  for (const src of deepQueryAll(root, "picture > source[srcset]")) {
    const list: RawVariant[] = [];
    const ss = src.getAttribute("srcset") || src.getAttribute("data-srcset") || "";
    for (const it of parseSrcset(ss, baseUrl)) {
      const full = expandThumbUrl(it.url);
      if (full) pushVariant(list, full, "picture", it.width, it.height);
      pushVariant(list, it.url, "picture", it.width, it.height);
    }
    push(list, "picture");
  }

  // standalone <source srcset> (нестандартная разметка)
  for (const src of deepQueryAll(root, "source[srcset]")) {
    const list: RawVariant[] = [];
    const ss = src.getAttribute("srcset") || "";
    for (const it of parseSrcset(ss, baseUrl)) {
      const full = expandThumbUrl(it.url);
      if (full) pushVariant(list, full, "picture", it.width, it.height);
      pushVariant(list, it.url, "picture", it.width, it.height);
    }
    push(list, "picture");
  }

  // meta: og:image / twitter:image / schema.org (включая head в document)
  for (const [kind, value] of OG_ATTRS) {
    for (const meta of deepQueryAll(root, `meta[${kind}="${value}"]`)) {
      const content = meta.getAttribute("content");
      if (!content) continue;
      const abs = normalizeUrl(content, baseUrl);
      if (abs && isUsableUrl(abs)) push([{ url: abs, sourceType: "meta" }], "meta");
    }
  }

  // link rel=image_src
  for (const link of deepQueryAll(root, 'link[rel~="image_src"][href]')) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const abs = normalizeUrl(href, baseUrl);
    if (abs && isUsableUrl(abs)) push([{ url: abs, sourceType: "link" }], "link");
  }

  // <a href="...jpg"> — прямые ссылки на файлы изображений
  for (const a of deepQueryAll(root, "a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const abs = normalizeUrl(href, baseUrl);
    if (!abs || !isUsableUrl(abs)) continue;
    const ext = extensionFromUrl(abs);
    if (ext && IMAGE_EXT_SET.has(ext)) {
      push([{ url: abs, sourceType: "link" }], "link");
    }
  }

  // input[type=image]
  for (const inp of deepQueryAll(root, 'input[type="image"][src]')) {
    const src = inp.getAttribute("src");
    if (!src) continue;
    const a = normalize(src);
    if (a) push([{ url: a, sourceType: "other" }], "other");
  }

  // background-image из inline-стилей (работает и в SW, и в shadow root)
  for (const el of deepQueryAll(root, '[style*="background"]')) {
    const urls = extractBackgroundUrls(el.getAttribute("style") || "", baseUrl);
    if (urls.length > 0) push(urls.map((u) => ({ url: u, sourceType: "background" as SourceType })), "background");
  }

  // body: computed background (только live, только для Document)
  if (opts.live && isDoc) {
    try {
      const body = (root as Document).body;
      if (body) {
        const comp = getComputedStyle(body).backgroundImage;
        const urls = extractBackgroundUrls(comp, baseUrl);
        if (urls.length > 0) push(urls.map((u) => ({ url: u, sourceType: "background" as SourceType })), "background");
      }
    } catch {
      // ignore
    }
  }

  return [...hits.values()];
}

function emptyStats(): DetectStatsAcc {
  return { imgElements: 0, canvasElements: 0, shadowRootsOpened: 0, sourceTypeCounts: {} };
}

/** Список кандидатов на странице (документ целиком). */
export function detectImages(doc: Document, opts: DetectOptions): RawHit[] {
  return detectImagesInRoot(doc, opts);
}

/** Детальная версия для сканера: hits + статистика (отладка). */
export function detectImagesDetailed(doc: Document, opts: DetectOptions): { hits: RawHit[]; stats: DetectStatsAcc } {
  const stats = emptyStats();
  const hits = detectImagesInRoot(doc, opts, stats);
  return { hits, stats };
}

/** Определение изображений в поддереве (для MutationObserver) — без клонирования. */
export function detectImagesInNode(node: Node, opts: DetectOptions): RawHit[] {
  if (node.nodeType === 1) {
    return detectImagesInRoot(node as Element, opts);
  }
  return [];
}