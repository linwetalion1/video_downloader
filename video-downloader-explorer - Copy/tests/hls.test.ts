// Тесты HLS-парсера.
import { describe, it, expect } from "vitest";
import { parseHls } from "../src/media/hls";

describe("parseHls master", () => {
  it("извлекает варианты", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\"",
      "1080.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720",
      "720.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360",
      "360.m3u8",
    ].join("\n");
    const r = parseHls(text, "https://x.com/master.m3u8");
    expect(r.ok).toBe(true);
    expect(r.isMaster).toBe(true);
    expect(r.variants).toHaveLength(3);
    expect(r.variants[0].height).toBe(1080);
    expect(r.variants[2].height).toBe(360);
  });
});

describe("parseHls media", () => {
  it("извлекает сегменты", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:6",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXTINF:6.0,",
      "seg0.ts",
      "#EXTINF:6.0,",
      "seg1.ts",
      "#EXTINF:5.5,",
      "seg2.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const r = parseHls(text, "https://x.com/v.m3u8");
    expect(r.ok).toBe(true);
    expect(r.isMaster).toBe(false);
    expect(r.segments).toHaveLength(3);
    expect(r.segments![0].url).toBe("https://x.com/seg0.ts");
    expect(r.isVOD).toBe(true);
  });

  it("AES-128 = encrypted", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"https://x.com/key\"",
      "#EXTINF:5,",
      "seg.ts",
    ].join("\n");
    const r = parseHls(text, "https://x.com/v.m3u8");
    expect(r.isEncrypted).toBe(true);
    expect(r.keyUri).toBe("https://x.com/key");
  });

  it("SAMPLE-AES = DRM", () => {
    const text = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"https://x.com/key\"\n#EXTINF:5,\nseg.ts";
    const r = parseHls(text, "https://x.com/v.m3u8");
    expect(r.isDRM).toBe(true);
  });
});
