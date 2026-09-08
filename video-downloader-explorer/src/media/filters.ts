// Фильтры видео-кандидатов (ТЗ §16). Чистые функции, моментальная локальная фильтрация.
import { KNOWN_DOMAINS_HEAVY_DRM } from "../shared/constants";
import type { Container, Filters, SortDir, SortKey, VideoCandidate } from "../shared/types";

interface Condition {
  key: string;
  known: (c: VideoCandidate) => boolean;
  passes: (c: VideoCandidate) => boolean;
}

function buildConditions(f: Filters): Condition[] {
  const conds: Condition[] = [];
  // UI может успеть отрендерить кандидатов ДО прихода настроек от SW —
  // поэтому все поля фильтров читаются защищённо.
  if (!f || typeof f !== "object") return conds;

  if (f.minWidth > 0) {
    conds.push({ key: "minWidth", known: (c) => c.width !== undefined, passes: (c) => (c.width ?? 0) >= f.minWidth });
  }
  if (f.minHeight > 0) {
    conds.push({ key: "minHeight", known: (c) => c.height !== undefined, passes: (c) => (c.height ?? 0) >= f.minHeight });
  }
  if (f.minDurationSec > 0) {
    conds.push({ key: "minDur", known: (c) => c.durationSec !== undefined, passes: (c) => (c.durationSec ?? 0) >= f.minDurationSec });
  }
  if (f.maxDurationSec > 0) {
    conds.push({ key: "maxDur", known: (c) => c.durationSec !== undefined, passes: (c) => (c.durationSec ?? Infinity) <= f.maxDurationSec });
  }
  if (f.minBitrateKbps > 0) {
    conds.push({ key: "minBitrate", known: (c) => c.bitrateKbps !== undefined, passes: (c) => (c.bitrateKbps ?? 0) >= f.minBitrateKbps });
  }
  if (f.minFileSizeMB > 0) {
    conds.push({ key: "minSize", known: (c) => c.fileSize !== undefined, passes: (c) => (c.fileSize ?? 0) >= f.minFileSizeMB * 1024 * 1024 });
  }
  const include = Array.isArray(f.includeContainers) ? f.includeContainers : [];
  if (include.length > 0) {
    const set = new Set(include);
    conds.push({ key: "includeContainers", known: () => true, passes: (c) => set.has(c.container) });
  }
  const exclude = Array.isArray(f.excludeContainers) ? f.excludeContainers : [];
  if (exclude.length > 0) {
    const set = new Set(exclude);
    conds.push({ key: "excludeContainers", known: () => true, passes: (c) => !set.has(c.container) });
  }
  if (f.excludeManifests) {
    conds.push({ key: "excludeManifests", known: () => true, passes: (c) => !c.isManifest });
  }
  if (f.excludeDRM) {
    conds.push({ key: "excludeDRM", known: () => true, passes: (c) => !c.isDRM });
  }
  if (f.excludeBlobs) {
    conds.push({ key: "excludeBlobs", known: () => true, passes: (c) => !c.isBlob });
  }
  if (f.excludeIframes) {
    conds.push({ key: "excludeIframes", known: () => true, passes: (c) => c.sourceType !== "iframe-player" });
  }
  if (f.excludeAds) {
    conds.push({ key: "excludeAds", known: () => true, passes: (c) => !looksLikeAd(c) });
  }

  return conds;
}

function looksLikeAd(c: VideoCandidate): boolean {
  const url = c.videoUrl.toLowerCase();
  if (/ads?\.|doubleclick|googlesyndication|adservice|adnxs|adsrv|tribalfusion|outbrain/i.test(url)) return true;
  if (/youtube\.com\/s\/search\/audio\//i.test(url) || /failure\.mp3|no_input\.mp3|open\.mp3|success\.mp3/i.test(url)) return true;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (KNOWN_DOMAINS_HEAVY_DRM.has(host)) return true;
  } catch { /* blob:/data: — не реклама */ }
  return false;
}

export function matchesFilters(c: VideoCandidate, f: Filters): boolean {
  // Отсеиваем мёртвые кандидаты (пустые 0-байтные заглушки и 403-ошибки без формата)
  if (c.container === "unknown" && (!c.fileSize || c.fileSize === 0) && !c.isManifest && !c.isBlob && !c.isLive) {
    return false;
  }
  // Отсеиваем UI звуковые эффекты
  if (/youtube\.com\/s\/search\/audio\//i.test(c.videoUrl) || /failure\.mp3|no_input\.mp3|open\.mp3|success\.mp3/i.test(c.videoUrl)) {
    return false;
  }

  const conds = buildConditions(f);
  if (conds.length === 0) return true;
  if (f.filterMode === "AND") return conds.every((cond) => cond.known(c) && cond.passes(c));
  return conds.some((cond) => cond.known(c) && cond.passes(c));
}

export function countMatched(candidates: VideoCandidate[], f: Filters): number {
  let n = 0;
  for (const c of candidates) if (matchesFilters(c, f)) n++;
  return n;
}

function valueOf(c: VideoCandidate, key: SortKey): number | string {
  switch (key) {
    case "duration": return c.durationSec ?? -1;
    case "width": return c.width ?? -1;
    case "height": return c.height ?? -1;
    case "fileSize": return c.fileSize ?? -1;
    case "bitrate": return c.bitrateKbps ?? -1;
    case "name": return (c.title || basename(c.videoUrl)).toLowerCase();
    case "url": return c.videoUrl;
    case "sourceType": return c.sourceType;
    case "container": return c.container;
    case "selected": return c.selected ? 1 : 0;
    case "status": return c.status;
  }
}

function basename(url: string): string {
  try {
    const p = new URL(url).pathname;
    const parts = p.split("/").filter(Boolean);
    return parts[parts.length - 1] || p;
  } catch { return url; }
}

export function sortCandidates(list: VideoCandidate[], key: SortKey, dir: SortDir): VideoCandidate[] {
  const sorted = [...list];
  sorted.sort((a, b) => {
    const va = valueOf(a, key);
    const vb = valueOf(b, key);
    let cmp: number;
    if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb), "ru");
    if (key === "selected") cmp = (vb as number) - (va as number);
    else if (dir === "desc") cmp = -cmp;
    return cmp;
  });
  return sorted;
}

export type Selector = (c: VideoCandidate) => boolean;
export const selectAll: Selector = () => true;
export const selectNone: Selector = () => false;
export const selectInverted: Selector = (c) => !c.selected;
export const selectByContainer = (c2: Container): Selector => (c) => c.container === c2;
export const selectByStatus = (status: VideoCandidate["status"]): Selector => (c) => c.status === status;

export function applySelection(list: VideoCandidate[], sel: Selector): string[] {
  const changed: string[] = [];
  for (const c of list) {
    const next = sel(c);
    if (c.selected !== next) {
      c.selected = next;
      changed.push(c.id);
    }
  }
  return changed;
}
