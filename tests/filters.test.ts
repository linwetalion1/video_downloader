import { describe, expect, it } from "vitest";
import { countMatched, matchesFilters, sortCandidates } from "../src/images/filters";
import type { Filters, ImageCandidate } from "../src/shared/types";
import { DEFAULTS } from "../src/shared/constants";

function cand(over: Partial<ImageCandidate>): ImageCandidate {
  const w = over.width;
  const h = over.height;
  return {
    id: "x",
    imageUrl: "https://s.com/x.jpg",
    canonicalUrl: "https://s.com/x.jpg",
    variants: [],
    sourcePageUrl: "https://s.com/",
    sourceDomain: "s.com",
    depth: 0,
    sourceType: "img",
    selected: false,
    status: "ready",
    aspectRatio: w && h ? w / h : undefined,
    ...over,
  };
}

function filters(over: Partial<Filters>): Filters {
  return { ...DEFAULTS, ...over };
}

describe("filters", () => {
  const wide = cand({ width: 1600, height: 1200, fileSize: 500 * 1024, extension: "jpg" });
  const small = cand({ width: 100, height: 80, fileSize: 10 * 1024, extension: "jpg" });
  const unknown = cand({ extension: "jpg" });

  it("без фильтров — всё проходит", () => {
    expect(matchesFilters(wide, filters({}))).toBe(true);
    expect(matchesFilters(unknown, filters({}))).toBe(true);
  });

  it("ширина", () => {
    expect(matchesFilters(wide, filters({ minWidth: 1200 }))).toBe(true);
    expect(matchesFilters(small, filters({ minWidth: 1200 }))).toBe(false);
  });

  it("высота", () => {
    expect(matchesFilters(wide, filters({ minHeight: 1000 }))).toBe(true);
    expect(matchesFilters(small, filters({ minHeight: 1000 }))).toBe(false);
  });

  it("размер файла", () => {
    expect(matchesFilters(wide, filters({ minFileSizeKB: 300 }))).toBe(true);
    expect(matchesFilters(small, filters({ minFileSizeKB: 300 }))).toBe(false);
  });

  it("ширина + высота (AND)", () => {
    const f = filters({ minWidth: 1200, minHeight: 1000, filterMode: "AND" });
    expect(matchesFilters(wide, f)).toBe(true);
    expect(matchesFilters(cand({ width: 1600, height: 400 }), f)).toBe(false);
  });

  it("ширина + размер (AND)", () => {
    const f = filters({ minWidth: 1200, minFileSizeKB: 300, filterMode: "AND" });
    expect(matchesFilters(wide, f)).toBe(true);
    expect(matchesFilters(cand({ width: 1600, height: 1200, fileSize: 50 * 1024 }), f)).toBe(false);
  });

  it("высота + размер (AND)", () => {
    const f = filters({ minHeight: 1000, minFileSizeKB: 300, filterMode: "AND" });
    expect(matchesFilters(wide, f)).toBe(true);
  });

  it("все три (AND)", () => {
    const f = filters({ minWidth: 1200, minHeight: 1000, minFileSizeKB: 100, filterMode: "AND" });
    expect(matchesFilters(wide, f)).toBe(true);
  });

  it("OR: достаточно одного условия", () => {
    const f = filters({ minWidth: 1200, minHeight: 1000, minFileSizeKB: 300, filterMode: "OR" });
    expect(matchesFilters(cand({ width: 1500, height: 300, fileSize: 10 }), f)).toBe(true);
    expect(matchesFilters(small, f)).toBe(false);
  });

  it("неизвестные размеры не считаются соответствующими", () => {
    expect(matchesFilters(unknown, filters({ minWidth: 1200, filterMode: "AND" }))).toBe(false);
    // OR, единственное условие (ширина) не может быть оценено → тоже false
    expect(matchesFilters(unknown, filters({ minWidth: 1200, filterMode: "OR" }))).toBe(false);
    expect(matchesFilters(unknown, filters({}))).toBe(true); // без фильтров — проходит
  });

  it("OR: неизвестная ширина, но известный размер — проходит по размеру", () => {
    const f = filters({ minWidth: 1200, minFileSizeKB: 300, filterMode: "OR" });
    expect(matchesFilters(cand({ fileSize: 500 * 1024 }), f)).toBe(true);
  });

  it("исключение форматов", () => {
    const svg = cand({ extension: "svg", mimeType: "image/svg+xml" });
    expect(matchesFilters(svg, filters({ excludeSVG: true }))).toBe(false);
    expect(matchesFilters(svg, filters({ excludeFormats: ["svg"] }))).toBe(false);
    expect(matchesFilters(svg, filters({ includeFormats: ["jpg"] }))).toBe(false);
    expect(matchesFilters(wide, filters({ includeFormats: ["jpg"] }))).toBe(true);
  });

  it("исключение иконок и tracking-pixel", () => {
    expect(matchesFilters(cand({ width: 16, height: 16 }), filters({ excludeTiny: true }))).toBe(false);
    expect(matchesFilters(cand({ width: 1, height: 1 }), filters({ excludeTrackingPixels: true }))).toBe(false);
    expect(matchesFilters(cand({ width: 32, height: 32 }), filters({ excludeTiny: true }))).toBe(true);
  });

  it("соотношение сторон", () => {
    const square = cand({ width: 1000, height: 1000 });
    expect(matchesFilters(square, filters({ minAspect: 1.0, maxAspect: 1.5 }))).toBe(true);
    expect(matchesFilters(cand({ width: 2000, height: 1000 }), filters({ maxAspect: 1.5 }))).toBe(false);
  });

  it("countMatched", () => {
    expect(countMatched([wide, small, unknown], filters({ minWidth: 1200 }))).toBe(1);
  });
});

describe("sortCandidates", () => {
  const a = cand({ id: "a", width: 100, height: 100, fileSize: 50 * 1024, depth: 0, selected: false });
  const b = cand({ id: "b", width: 200, height: 100, fileSize: 500 * 1024, depth: 2, selected: true });
  const c = cand({ id: "c", width: 150, height: 300, fileSize: 150 * 1024, depth: 1, selected: false });

  it("сортировка по ширине", () => {
    expect(sortCandidates([a, b, c], "width", "asc").map((x) => x.id)).toEqual(["a", "c", "b"]);
    expect(sortCandidates([a, b, c], "width", "desc").map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("сортировка по размеру файла", () => {
    expect(sortCandidates([a, b, c], "fileSize", "desc").map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("сначала выбранные", () => {
    expect(sortCandidates([a, b, c], "selected", "desc").map((x) => x.id)).toEqual(["b", "a", "c"]);
  });
});