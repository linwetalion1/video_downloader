// Тесты утилит.
import { describe, it, expect } from "vitest";
import {
  canonicalUrl, variantGroupKey, applyFilenameTemplate, formatBytes,
  formatDuration, formatBitrate, normalizePlaybackUrl, looksLikeErrorPayload,
  sanitizeFilename, isMacOS, getModifierKeyLabel,
} from "../src/shared/utils";

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
  it("группирует варианты с разными токенами", () => {
    expect(variantGroupKey("https://x.com/v.mp4")).toBe("https://x.com/v.mp4");
    expect(variantGroupKey("https://x.com/v.mp4?token=1")).toBe("https://x.com/v.mp4");
    expect(variantGroupKey("https://cdn.yt/videoplayback?expires=1&sig=a&itag=18&id=x"))
      .toBe("https://cdn.yt/videoplayback?id=x&itag=18");
    expect(variantGroupKey("https://cdn.yt/videoplayback?expires=9&sig=z&itag=22&id=x"))
      .toBe("https://cdn.yt/videoplayback?id=x&itag=22");
  });
  it("разные itag = разные ключи (качество не теряется)", () => {
    const a = variantGroupKey("https://h.googlevideo.com/videoplayback?itag=137&clen=1000&id=q");
    const b = variantGroupKey("https://h.googlevideo.com/videoplayback?itag=136&clen=2000&id=q");
    expect(a).not.toBe(b);
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

describe("normalizePlaybackUrl", () => {
  it("снимает range/rn/rbuf у сегментных запросов плеера", () => {
    const u = "https://rr2---x.googlevideo.com/videoplayback?expire=1&itag=140&clen=5000&range=0-65535&rn=3&rbuf=11&sig=abc";
    const n = normalizePlaybackUrl(u);
    expect(n).toContain("itag=140");
    expect(n).toContain("clen=5000");
    expect(n).not.toContain("range=");
    expect(n).not.toContain("rn=");
    expect(n).not.toContain("rbuf=");
  });
  it("чужие URL не трогает", () => {
    const u = "https://cdn.site/v.mp4?range=1";
    expect(normalizePlaybackUrl(u)).toBe(u);
  });
});

describe("looksLikeErrorPayload", () => {
  it("распознаёт HTML и JSON-ошибки", () => {
    const enc = new TextEncoder();
    expect(looksLikeErrorPayload(enc.encode("<!DOCTYPE html><html><body>error</body>"))).toBe(true);
    expect(looksLikeErrorPayload(enc.encode('{"error":{"code":403}}}'))).toBe(true);
    expect(looksLikeErrorPayload(enc.encode('{"playabilityStatus":{"status":"LOGIN_REQUIRED"}}'))).toBe(true);
  });
  it("медиа-байты не считает ошибкой", () => {
    const enc = new TextEncoder();
    expect(looksLikeErrorPayload(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]))).toBe(false); // ftyp
    expect(looksLikeErrorPayload(enc.encode('{"ok":true}'))).toBe(false);
  });
});

describe("applyFilenameTemplate: схлопывание пустых плейсхолдеров", () => {
  it("пустое качество не оставляет хвостов", () => {
    expect(applyFilenameTemplate("{title}_{quality}.{ext}", { title: "video", ext: "mp4" }))
      .toBe("video.mp4");
    expect(applyFilenameTemplate("{title}_{quality}.{ext}", { title: "clip", quality: "720p", ext: "mp4" }))
      .toBe("clip_720p.mp4");
  });
  it("полностью пустой шаблон даёт фолбэк video", () => {
    expect(applyFilenameTemplate("{domain}_{quality}", {}))
      .toBe("video");
  });
  it("пустой title не создаёт скрытый dot-файл на macOS (.mp4 -> video.mp4)", () => {
    expect(applyFilenameTemplate("{title}.{ext}", { title: "", ext: "mp4" }))
      .toBe("video.mp4");
  });
});

describe("sanitizeFilename (macOS APFS/HFS+ & Windows)", () => {
  it("нормализует декомпозированный Unicode (NFD -> NFC) для macOS APFS/HFS+", () => {
    // Кириллица "й" в NFD: "и" (U+0438) + comb combining breve (U+0306)
    const nfdString = "\u0438\u0306";
    const sanitized = sanitizeFilename(nfdString);
    expect(sanitized).toBe("\u0439"); // "й" в NFC
    expect(sanitized.normalize("NFC")).toBe(sanitized);
  });

  it("удаляет двоеточия (зарезервированы в macOS Finder) и слэши", () => {
    expect(sanitizeFilename("stream: episode / 01")).toBe("stream episode 01");
    expect(sanitizeFilename("video:test?*<>|path\\")).toBe("videotestpath");
  });

  it("удаляет начальные точки (предотвращает скрытые файлы в macOS Finder)", () => {
    expect(sanitizeFilename(".hidden_stream.mp4")).toBe("hidden_stream.mp4");
    expect(sanitizeFilename("..test")).toBe("test");
  });

  it("удаляет хвостовые точки и пробелы", () => {
    expect(sanitizeFilename("stream. ")).toBe("stream");
    expect(sanitizeFilename("video...")).toBe("video");
  });

  it("удаляет emoji-суррогаты и zero-width символы, вызывающие сбои в Chrome", () => {
    expect(sanitizeFilename("стрим 🔴 live \u200B \uFEFF эфир")).toBe("стрим live эфир");
  });

  it("возвращает дефолтное имя video, если имя полностью состояло из запрещённых символов", () => {
    expect(sanitizeFilename(":::///???")).toBe("video");
    expect(sanitizeFilename("")).toBe("video");
  });
});

describe("platform helpers", () => {
  it("isMacOS и getModifierKeyLabel возвращают валидные значения", () => {
    expect(typeof isMacOS()).toBe("boolean");
    expect(["⌘", "Ctrl"]).toContain(getModifierKeyLabel());
  });
});

