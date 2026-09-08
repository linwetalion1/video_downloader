// Тесты определения формата.
import { describe, it, expect } from "vitest";
import { detectFormat } from "../src/media/formats";

describe("detectFormat", () => {
  it("MP4 (ftyp isom)", () => {
    const bytes = new Uint8Array([
      0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, // size + ftyp
      0x69, 0x73, 0x6F, 0x6D, // isom
      0, 0, 0, 0,
    ]);
    const r = detectFormat(bytes, "https://x.com/a.mp4");
    expect(r.container).toBe("mp4");
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("WebM (EBML)", () => {
    const bytes = new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const r = detectFormat(bytes, "https://x.com/a.webm");
    expect(r.container).toBe("webm");
  });

  it("HLS m3u8", () => {
    const text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nhttps://x.com/v.m3u8";
    const r = detectFormat(new TextEncoder().encode(text), "https://x.com/master.m3u8");
    expect(r.container).toBe("hls");
    expect(r.isManifest).toBe(true);
  });

  it("HLS с SAMPLE-AES = DRM", () => {
    const text = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"https://x.com/key\"\n#EXTINF:5,\nseg.ts";
    const r = detectFormat(new TextEncoder().encode(text), "https://x.com/m.m3u8");
    expect(r.isDRM).toBe(true);
  });

  it("DASH mpd", () => {
    const xml = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"/>';
    const r = detectFormat(new TextEncoder().encode(xml), "https://x.com/m.mpd");
    expect(r.container).toBe("dash");
    expect(r.isManifest).toBe(true);
  });

  it("FLV", () => {
    const bytes = new Uint8Array([0x46, 0x4C, 0x56, 0x01, 0, 0, 0, 0, 9, 0, 0, 0, 0]);
    const r = detectFormat(bytes, "https://x.com/v.flv");
    expect(r.container).toBe("flv");
  });

  it("MPEG-TS sync 0x47", () => {
    const bytes = new Uint8Array(400);
    bytes[0] = 0x47; bytes[188] = 0x47;
    const r = detectFormat(bytes, "https://x.com/v.ts");
    expect(r.container).toBe("ts");
  });

  it("Fallback на hint (mp4)", () => {
    const r = detectFormat(new Uint8Array(0), "https://x.com/v.mp4", "video/mp4");
    expect(r.container).toBe("mp4");
  });
});

import { collectFromElement } from "../src/content/video-scanner";

describe("WebRTC detection", () => {
  it("детектирует WebRTC поток через video.srcObject", () => {
    const mockVideo = {
      tagName: "VIDEO",
      querySelectorAll: () => [],
      getAttribute: (attr: string) => (attr === "aria-label" ? "Live cam model" : null),
      currentSrc: "",
      srcObject: { id: "webrtc-track-12345" },
      videoWidth: 1920,
      videoHeight: 1080,
      poster: "https://example.com/poster.jpg",
    } as unknown as HTMLVideoElement;

    const seen: string[] = [];
    const candidates = collectFromElement(mockVideo, "https://cam-site.com/model1", seen);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceType).toBe("webrtc");
    expect(candidates[0].container).toBe("webm");
    expect(candidates[0].isLive).toBe(true);
    expect(candidates[0].width).toBe(1920);
    expect(candidates[0].height).toBe(1080);
    expect(candidates[0].videoUrl).toContain("webrtc:");
  });

  it("игнорирует video без src и без srcObject", () => {
    const mockVideo = {
      tagName: "VIDEO",
      querySelectorAll: () => [],
      getAttribute: () => null,
      currentSrc: "",
      srcObject: null,
    } as unknown as HTMLVideoElement;

    const seen: string[] = [];
    const candidates = collectFromElement(mockVideo, "https://example.com", seen);
    expect(candidates).toHaveLength(0);
  });
});
