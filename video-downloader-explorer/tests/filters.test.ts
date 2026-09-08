// Тесты фильтров.
import { describe, it, expect } from "vitest";
import { matchesFilters, countMatched, sortCandidates } from "../src/media/filters";
import { DEFAULTS } from "../src/shared/constants";
import type { VideoCandidate } from "../src/shared/types";

function cand(overrides: Partial<VideoCandidate> = {}): VideoCandidate {
  return {
    id: "test-" + Math.random(),
    videoUrl: "https://example.com/v.mp4",
    canonicalUrl: "https://example.com/v.mp4",
    alternatives: [],
    sourceType: "video", sourcePageUrl: "https://example.com/page", sourceDomain: "example.com",
    container: "mp4", mimeType: "video/mp4", extension: "mp4",
    isManifest: false, isDRM: false, isBlob: false,
    title: "Test", durationSec: 60, width: 1280, height: 720, fileSize: 10_000_000, bitrateKbps: 1000,
    status: "ready", selected: false, phase: "done", progress: 0,
    depth: 0, retryCount: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

describe("matchesFilters", () => {
  it("пустые фильтры = true", () => {
    expect(matchesFilters(cand(), { ...DEFAULTS })).toBe(true);
  });
  it("minWidth", () => {
    expect(matchesFilters(cand({ width: 1920 }), { ...DEFAULTS, minWidth: 1280 })).toBe(true);
    expect(matchesFilters(cand({ width: 800 }), { ...DEFAULTS, minWidth: 1280 })).toBe(false);
  });
  it("minDurationSec", () => {
    expect(matchesFilters(cand({ durationSec: 30 }), { ...DEFAULTS, minDurationSec: 60 })).toBe(false);
    expect(matchesFilters(cand({ durationSec: 120 }), { ...DEFAULTS, minDurationSec: 60 })).toBe(true);
  });
  it("maxDurationSec", () => {
    expect(matchesFilters(cand({ durationSec: 600 }), { ...DEFAULTS, maxDurationSec: 300 })).toBe(false);
  });
  it("excludeDRM", () => {
    expect(matchesFilters(cand({ isDRM: true }), { ...DEFAULTS, excludeDRM: true })).toBe(false);
  });
  it("excludeManifests", () => {
    expect(matchesFilters(cand({ isManifest: true }), { ...DEFAULTS, excludeManifests: true })).toBe(false);
  });
  it("excludeContainers", () => {
    expect(matchesFilters(cand({ container: "mp4" }), { ...DEFAULTS, excludeContainers: ["mp4"] })).toBe(false);
  });
  it("отсеивает мёртвые стабы (unknown container, 0 байт)", () => {
    expect(matchesFilters(cand({ container: "unknown", fileSize: 0, isManifest: false, isBlob: false, isLive: false }), { ...DEFAULTS })).toBe(false);
    expect(matchesFilters(cand({ container: "unknown", fileSize: undefined, isManifest: false, isBlob: false, isLive: false }), { ...DEFAULTS })).toBe(false);
    // Но если live или manifest — пропускает
    expect(matchesFilters(cand({ container: "unknown", isLive: true }), { ...DEFAULTS })).toBe(true);
  });
  it("отсеивает UI звуки поиска YouTube", () => {
    expect(matchesFilters(cand({ videoUrl: "https://www.youtube.com/s/search/audio/failure.mp3" }), { ...DEFAULTS })).toBe(false);
    expect(matchesFilters(cand({ videoUrl: "https://example.com/sound/open.mp3" }), { ...DEFAULTS })).toBe(false);
  });
});

describe("countMatched", () => {
  it("считает корректно", () => {
    const list = [cand({ width: 1920 }), cand({ width: 800 }), cand({ width: 2560 })];
    expect(countMatched(list, { ...DEFAULTS, minWidth: 1280 })).toBe(2);
  });
});

describe("sortCandidates", () => {
  it("по длительности desc", () => {
    const list = [cand({ id: "a", durationSec: 60 }), cand({ id: "b", durationSec: 300 })];
    const sorted = sortCandidates(list, "duration", "desc");
    expect(sorted[0].id).toBe("b");
  });
  it("по размеру asc", () => {
    const list = [cand({ id: "a", fileSize: 1000 }), cand({ id: "b", fileSize: 100 })];
    const sorted = sortCandidates(list, "fileSize", "asc");
    expect(sorted[0].id).toBe("b");
  });
});
