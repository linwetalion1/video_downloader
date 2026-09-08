// Мониторинг динамически добавляемых изображений через MutationObserver (ТЗ §18).
import type { RawHit } from "../shared/types";
import { detectImagesInNode } from "./dom-image-detector";

export interface MonitorOptions {
  baseUrl: string;
  windowMs: number;
}

/** Наблюдает за DOM до истечения windowMs и сообщает о новых кандидатах батчами. */
export function monitorForImages(
  doc: Document,
  opts: MonitorOptions,
  onBatch: (hits: RawHit[], links: string[]) => void
): Promise<{ hits: RawHit[]; links: string[] }> {
  return new Promise((resolve) => {
    const allHits: RawHit[] = [];
    const allLinks = new Set<string>();
    const seen = new Set<string>();

    const collectFrom = (node: Node) => {
      const hits = detectImagesInNode(node, { baseUrl: opts.baseUrl, live: true });
      for (const h of hits) {
        const key = h.variants[0]?.url;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        allHits.push(h);
      }
      // ссылки в поддереве
      if (node.nodeType === Node.ELEMENT_NODE) {
        (node as Element).querySelectorAll?.("a[href]").forEach((a) => {
          const href = a.getAttribute("href");
          if (href && href.startsWith("http")) allLinks.add(href);
        });
      }
    };

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve({ hits: allHits, links: [...allLinks] });
    };

    const observer = new MutationObserver((mutations) => {
      let dirty = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            collectFrom(node);
            dirty = true;
          }
        }
      }
      if (dirty) onBatch(allHits, [...allLinks]);
    });

    observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
    setTimeout(finish, Math.max(500, opts.windowMs));
  });
}