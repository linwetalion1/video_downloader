// Тесты HLS-парсера.
import { describe, it, expect } from "vitest";
import { parseHls, rewriteAudioFragmentTrackId } from "../src/media/hls";

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

  it("связывает audioUrl из EXT-X-MEDIA:TYPE=AUDIO с видео-вариантами (YouTube demuxed HLS)", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio-group\",NAME=\"English\",DEFAULT=YES,URI=\"audio_128k.m3u8\"",
      "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO=\"audio-group\"",
      "video_1080p.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO=\"audio-group\"",
      "video_720p.m3u8",
    ].join("\n");
    const r = parseHls(text, "https://googlevideo.com/manifest/hls_variant/master.m3u8");
    expect(r.ok).toBe(true);
    expect(r.isMaster).toBe(true);
    expect(r.variants).toHaveLength(2);
    expect(r.variants[0].audioUrl).toBe("https://googlevideo.com/manifest/hls_variant/audio_128k.m3u8");
    expect(r.variants[1].audioUrl).toBe("https://googlevideo.com/manifest/hls_variant/audio_128k.m3u8");
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

  it("KEY METHOD=NONE сбрасывает шифрование (ротация ключей)", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-KEY:METHOD=AES-128,URI=\"https://x.com/key\"",
      "#EXTINF:5,",
      "a.ts",
      "#EXT-X-KEY:METHOD=NONE",
      "#EXTINF:5,",
      "b.ts",
    ].join("\n");
    const r = parseHls(text, "https://x.com/v.m3u8");
    expect(r.isEncrypted).toBe(true);
    expect(r.segments![0].key?.method).toBe("AES-128");
    expect(r.segments![1].key ?? null).toBeNull();
  });

  it("BYTERANGE без @O продолжает с конца предыдущего сегмента", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-BYTERANGE:1000@0",
      "video.mp4",
      "#EXT-X-BYTERANGE:500",
      "video.mp4",
      "#EXT-X-BYTERANGE:700@5000",
      "video.mp4",
    ].join("\n");
    const r = parseHls(text, "https://x.com/v.m3u8");
    expect(r.segments![0].byteRange).toEqual({ start: 0, length: 1000 });
    expect(r.segments![1].byteRange).toEqual({ start: 1000, length: 500 });
    expect(r.segments![2].byteRange).toEqual({ start: 5000, length: 700 });
  });

  it("EXT-X-MAP → fMP4 и init-сегмент", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-MAP:URI=\"init.mp4\"",
      "#EXTINF:4,",
      "seg.m4s",
    ].join("\n");
    const r = parseHls(text, "https://x.com/v.m3u8");
    expect(r.isFmp4).toBe(true);
    expect(r.segments).toHaveLength(2);
    expect(r.segments![0].isInit).toBe(true);
    expect(r.segments![0].url).toBe("https://x.com/init.mp4");
  });

  it("SESSION-KEY AES-128 на master помечает encrypted", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"https://x.com/key\",IV=0x1234",
      "#EXT-X-STREAM-INF:BANDWIDTH=800000",
      "v.m3u8",
    ].join("\n");
    const r = parseHls(text, "https://x.com/master.m3u8");
    expect(r.isEncrypted).toBe(true);
    expect(r.isDRM).toBe(false);
  });
});

describe("fMP4 audio track rewrite", () => {
  it("перезаписывает track_ID на 2 в tfhd аудио-фрагмента", () => {
    const tfhd = new Uint8Array([
      0, 0, 0, 16, // size
      116, 102, 104, 100, // "tfhd"
      0, 0, 0, 0, // version/flags
      0, 0, 0, 1, // track_id = 1
    ]);
    const traf = new Uint8Array(8 + tfhd.length);
    traf.set([0, 0, 0, traf.length, 116, 114, 97, 102], 0); // "traf"
    traf.set(tfhd, 8);

    const moof = new Uint8Array(8 + traf.length);
    moof.set([0, 0, 0, moof.length, 109, 111, 111, 102], 0); // "moof"
    moof.set(traf, 8);

    rewriteAudioFragmentTrackId(moof);

    const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength);
    expect(view.getUint32(28)).toBe(2);
  });
});
