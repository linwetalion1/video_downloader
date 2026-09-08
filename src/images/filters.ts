// Фильтр-движок (ТЗ §4, §24). Чистые функции: работают локально и мгновенно.
import { TINY_ICON_PX, TRACKING_PIXEL_PX } from "../shared/constants";
import type { Filters, ImageCandidate, SortDir, SortKey } from "../shared/types";

interface Condition {
  key: string;
  /** true если входные данные позволяют оценить условие. */
  known: (c: ImageCandidate) => boolean;
  passes: (c: ImageCandidate) => boolean;
}

function dimW(c: ImageCandidate): number | undefined {
  return c.width ?? c.naturalWidth;
}
function dimH(c: ImageCandidate): number | undefined {
  return c.height ?? c.naturalHeight;
}

function buildConditions(f: Filters): Condition[] {
  const conds: Condition[] = [];
  if (f.minWidth > 0) {
    conds.push({
      key: "width",
      known: (c) => dimW(c) !== undefined,
      passes: (c) => (dimW(c) ?? 0) >= f.minWidth,
    });
  }
  if (f.minHeight > 0) {
    conds.push({
      key: "height",
      known: (c) => dimH(c) !== undefined,
      passes: (c) => (dimH(c) ?? 0) >= f.minHeight,
    });
  }
  if (f.minFileSizeKB > 0) {
    conds.push({
      key: "fileSize",
      known: (c) => c.fileSize !== undefined,
      passes: (c) => (c.fileSize ?? 0) >= f.minFileSizeKB * 1024,
    });
  }
  if (f.minAspect > 0) {
    conds.push({
      key: "aspectMin",
      known: (c) => c.aspectRatio !== undefined,
      passes: (c) => (c.aspectRatio ?? 0) >= f.minAspect,
    });
  }
  if (f.maxAspect > 0) {
    conds.push({
      key: "aspectMax",
      known: (c) => c.aspectRatio !== undefined,
      passes: (c) => (c.aspectRatio ?? Infinity) <= f.maxAspect,
    });
  }
  if (f.includeFormats && f.includeFormats.length > 0) {
    const set = new Set(f.includeFormats);
    conds.push({
      key: "includeFormats",
      known: () => true,
      passes: (c) => set.has(c.extension || ""),
    });
  }
  if (f.excludeFormats.length > 0) {
    const set = new Set(f.excludeFormats);
    conds.push({
      key: "excludeFormats",
      known: () => true,
      passes: (c) => !set.has(c.extension || ""),
    });
  }
  if (f.excludeSVG) {
    conds.push({
      key: "excludeSVG",
      known: () => true,
      passes: (c) => c.extension !== "svg" && !(c.mimeType || "").includes("svg"),
    });
  }
  if (f.excludeTiny) {
    conds.push({
      key: "excludeTiny",
      known: (c) => dimW(c) !== undefined && dimH(c) !== undefined,
      passes: (c) => !((dimW(c) ?? 0) <= TINY_ICON_PX && (dimH(c) ?? 0) <= TINY_ICON_PX),
    });
  }
  if (f.excludeTrackingPixels) {
    conds.push({
      key: "excludeTracking",
      known: (c) => dimW(c) !== undefined && dimH(c) !== undefined,
      passes: (c) => !((dimW(c) ?? 0) <= TRACKING_PIXEL_PX && (dimH(c) ?? 0) <= TRACKING_PIXEL_PX),
    });
  }
  return conds;
}

/**
 * Соответствие фильтрам. Неизвестные значения НЕ считаются выполненными
 * (ТЗ §29: SVG/неизвестный размер не должен ошибочно соответствовать).
 */
export function matchesFilters(c: ImageCandidate, f: Filters): boolean {
  const conds = buildConditions(f);
  if (conds.length === 0) return true;
  if (f.filterMode === "AND") {
    return conds.every((cond) => cond.known(c) && cond.passes(c));
  }
  return conds.some((cond) => cond.known(c) && cond.passes(c));
}

export function countMatched(candidates: ImageCandidate[], f: Filters): number {
  let n = 0;
  for (const c of candidates) if (matchesFilters(c, f)) n++;
  return n;
}

// ─── Сортировка (ТЗ §25) ──────────────────────────────────────────────────

function valueOf(c: ImageCandidate, key: SortKey): number | string {
  switch (key) {
    case "fileSize": return c.fileSize ?? -1;
    case "width": return c.width ?? c.naturalWidth ?? -1;
    case "height": return c.height ?? c.naturalHeight ?? -1;
    case "resolution": return (c.width ?? c.naturalWidth ?? 0) * (c.height ?? c.naturalHeight ?? 0);
    case "name": return (c.title || c.alt || basename(c.imageUrl)).toLowerCase();
    case "url": return c.imageUrl;
    case "depth": return c.depth;
    case "page": return c.sourcePageUrl;
    case "selected": return c.selected ? 1 : 0;
  }
}

function basename(url: string): string {
  try {
    const p = new URL(url).pathname;
    const parts = p.split("/").filter(Boolean);
    return parts[parts.length - 1] || p;
  } catch {
    return url;
  }
}

export function sortCandidates(list: ImageCandidate[], key: SortKey, dir: SortDir): ImageCandidate[] {
  const sorted = [...list];
  sorted.sort((a, b) => {
    const va = valueOf(a, key);
    const vb = valueOf(b, key);
    let cmp: number;
    if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb), "ru");
    if (key === "selected") {
      // «Сначала выбранные» — только по убыванию
      cmp = (vb as number) - (va as number);
    } else if (dir === "desc") {
      cmp = -cmp;
    }
    return cmp;
  });
  return sorted;
}

// ─── Выбор (ТЗ §6) ────────────────────────────────────────────────────────

export type Selector = (c: ImageCandidate) => boolean;

export const selectAll: Selector = () => true;
export const selectNone: Selector = () => false;
export const selectInverted = (c: ImageCandidate) => !c.selected;
export const selectByDepth = (depth: number): Selector => (c) => c.depth === depth;
export const selectByDomain = (domain: string): Selector => (c) => c.sourceDomain === domain;
export const selectByFormat = (ext: string): Selector => (c) => c.extension === ext;
export const selectByMinSize = (bytes: number): Selector => (c) => (c.fileSize ?? 0) >= bytes;

export function applySelection(candidates: ImageCandidate[], selector: Selector): string[] {
  const changed: string[] = [];
  for (const c of candidates) {
    const next = selector(c);
    if (c.selected !== next) {
      c.selected = next;
      changed.push(c.id);
    }
  }
  return changed;
}