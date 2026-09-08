// Тесты утилит.
import { describe, it, expect } from "vitest";
import { canonicalUrl, variantGroupKey, applyFilenameTemplate, formatBytes, formatDuration, formatBitrate } from "../src/shared/utils";

describe("canonicalUrl", () => {
  it("вырезает utm", () => {
    expect(canonicalUrl("https://x.com/p?utm_source=foo&a=1")).toBe("https://x.com/p?a=1");
  });
  it("вырекает hash", () => {
    expect(canonicalUrl("https://x.com/p#frag")).toBe("https://x.com/p");
  });
  it("blob: остаётся", () => {
    expect(canonicalUrl("blob:https://x.com/abc")).toBe("blob:https://x.com/abc");
  });
});

describe("variantGroupKey", () => {
  it("группирует варианты с разными query", () => {
    expect(variantGroupKey("https://x.com/v.mp4")).toBe("https://x.com/v.mp4");
    expect(variantGroupKey("https://x.com/v.mp4?token=1")).toBe("https://x.com/v.mp4");
  });
});

describe("applyFilenameTemplate", () => {
  it("подставляет плейсхолдеры", () => {
    expect(applyFilenameTemplate("{title}_{width}x{height}.{ext}", { title: "video", width: 1920, height: 1080, ext: "mp4" })).toBe("video_1920x1080.mp4");
  });
});

describe("formatBytes", () => {
  it("форматирует", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});

describe("formatDuration", () => {
  it("форматирует", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3661)).toBe("1:01:01");
  });
});

describe("formatBitrate", () => {
  it("форматирует", () => {
    expect(formatBitrate(500)).toBe("500 Кбит/с");
    expect(formatBitrate(2000)).toBe("2.0 Мбит/с");
  });
});
