// Оркестратор сканирования страницы: базовое детектирование (включая shadow roots) +
// lazy-load пролистывание + окно MutationObserver (ТЗ §17–18, §23).
import type { RawHit, ScanResult, ScanStats } from "../shared/types";
import { detectImagesDetailed, deepQueryAll } from "./dom-image-detector";
import { extractLinks } from "./link-detector";
import { monitorForImages } from "./mutation-monitor";
import { expandThumbUrl, pickPrimaryVariant, sleep, variantGroupKey } from "../shared/utils";

export interface ScanOptions {
  baseUrl: string;
  autoScroll?: boolean;
  monitorMs?: number;
}

export async function scanPage(doc: Document, opts: ScanOptions): Promise<ScanResult> {
  const t0 = performance.now();
  const hits = new Map<string, RawHit>();
  const links = new Set<string>();
  let imgElements = 0;
  let canvasElements = 0;
  let shadowRootsOpened = 0;
  let sourceTypeCounts: ScanStats["sourceTypeCounts"] = {};
  let autoScrollSteps = 0;
  let mutationHits = 0;

  const mergeHits = (list: RawHit[]) => {
    for (const h of list) {
      if (!h.variants[0]?.url) continue;
      const primary = pickPrimaryVariant(h.variants);
      const ordered: RawHit = { ...h, variants: [primary, ...h.variants.filter((v) => v !== primary)] };
      const key = variantGroupKey(primary.url);
      const existing = hits.get(key);
      if (existing) {
        const known = new Set(existing.variants.map((v) => variantGroupKey(v.url)));
        for (const v of ordered.variants) {
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
        continue;
      }
      hits.set(key, ordered);
    }
  };

  const ingestMediaUrls = (html: string) => {
    const re = /\/media\/r\/[^"'\s<>]+?\.(?:jpe?g|png|gif|webp|avif)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      try {
        const abs = new URL(m[0], opts.baseUrl).href;
        const full = expandThumbUrl(abs);
        const variants = full
          ? [{ url: full, sourceType: "img" as const }, { url: abs, sourceType: "img" as const }]
          : [{ url: abs, sourceType: "img" as const }];
        mergeHits([{ variants }]);
      } catch { /* ignore */ }
    }
  };
  const mergeLinks = (list: string[]) => {
    for (const l of list) {
      if (l.startsWith("http")) links.add(l);
    }
  };

  const first = detectImagesDetailed(doc, { baseUrl: opts.baseUrl, live: true });
  mergeHits(first.hits);
  imgElements = first.stats.imgElements;
  canvasElements = first.stats.canvasElements;
  shadowRootsOpened = first.stats.shadowRootsOpened;
  sourceTypeCounts = first.stats.sourceTypeCounts;
  mergeLinks(extractLinks(doc, opts.baseUrl));
  try {
    ingestMediaUrls(doc.documentElement.outerHTML || "");
  } catch { /* ignore */ }

  // Lazy loading: пролистываем страницу вниз и скроллящиеся контейнеры (чат/галерея SPA)
  if (opts.autoScroll) {
    const scrollTargets = (): Element[] => {
      const els = new Set<Element>();
      // окно
      els.add(doc.documentElement as unknown as Element);
      // контейнеры chatpic и generic overflow:auto/scroll
      for (const sel of [".gallery", ".gallery.desktop", "#messages-wrapper", ".chat-wrapper", ".pictures-wrapper", "[style*=\"overflow-y\"]", "[style*=\"overflow:\"]"]) {
        try { doc.querySelectorAll(sel).forEach((e) => els.add(e)); } catch { /* ignore */ }
      }
      // все элементы с overflow auto/scroll (fallback)
      doc.querySelectorAll("*").forEach((el) => {
        try {
          const cs = getComputedStyle(el as Element);
          if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflow)) {
            const h = (el as HTMLElement).scrollHeight;
            const ch = (el as HTMLElement).clientHeight;
            if (h > ch + 50) els.add(el);
          }
        } catch { /* ignore */ }
      });
      return [...els];
    };
    const docEl = doc.documentElement;
    const total = Math.max(docEl?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
    const steps = Math.min(20, Math.max(4, Math.ceil(total / 2200)));
    for (let i = 0; i < steps; i++) {
      window.scrollBy(0, 2200);
      for (const el of scrollTargets()) {
        try {
          if (el === doc.documentElement) continue;
          (el as HTMLElement).scrollTop = (el as HTMLElement).scrollTop + 1800;
          el.scrollBy?.(0, 1800);
        } catch { /* ignore */ }
      }
      await sleep(260);
      autoScrollSteps++;
      const next = detectImagesDetailed(doc, { baseUrl: opts.baseUrl, live: true });
      mergeHits(next.hits);
      mergeLinks(extractLinks(doc, opts.baseUrl));
      try { ingestMediaUrls(doc.documentElement.outerHTML || ""); } catch { /* ignore */ }
    }
    // возврат наверх, чтобы не оставлять страницу прокрученной
    try { window.scrollTo(0, 0); } catch { /* ignore */ }
    for (const el of scrollTargets()) {
      try { if (el !== doc.documentElement) (el as HTMLElement).scrollTop = 0; } catch { /* ignore */ }
    }
  }

  // Динамический контент (ТЗ §18).
  if (opts.monitorMs && opts.monitorMs > 0) {
    const mon = await monitorForImages(
      doc,
      { baseUrl: opts.baseUrl, windowMs: opts.monitorMs },
      (batchHits, batchLinks) => {
        mergeHits(batchHits);
        mergeLinks(batchLinks);
      }
    );
    mergeHits(mon.hits);
    mergeLinks(mon.links);
    mutationHits = mon.hits.length;
  }

  const stats: ScanStats = {
    imgElements,
    canvasElements,
    shadowRootsOpened,
    sourceTypeCounts,
    links: links.size,
    autoScrollSteps,
    mutationHits,
    scanTimeMs: performance.now() - t0,
  };

  return {
    hits: [...hits.values()],
    links: [...links],
    pageMeta: { title: doc.title || opts.baseUrl, url: opts.baseUrl },
    scanTimeMs: stats.scanTimeMs,
    stats,
  };
}

/** Счётчик элементов для диагностики страницы. */
export function countElements(doc: Document): { nodes: number; anchors: number } {
  const all = deepQueryAll(doc, "*");
  return { nodes: all.length, anchors: deepQueryAll(doc, "a[href]").length };
}