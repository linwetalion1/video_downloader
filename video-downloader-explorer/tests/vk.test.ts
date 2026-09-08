import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { detectSocialVideos } from "../src/content/social-detector";
import { parseHls } from "../src/media/hls";

describe("VK Video and Live Stream Detection", () => {
  it("детектирует HLS трансляцию ВКонтакте (hls_live_playback, live)", () => {
    const dom = new JSDOM(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Прямой эфир турнира | ВКонтакте</title>
          <meta property="og:title" content="Турнир по киберспорту Финал">
          <meta property="og:image" content="https://sun9-1.userapi.com/thumb.jpg">
        </head>
        <body>
          <script>
            var playerParams = {
              "hls_live_playback": "https://vkvideo.ru/video_hls/live_12345/index.m3u8?extra=token123",
              "live": "https://vkvideo.ru/video_hls/live_12345/master.m3u8",
              "title": "Турнир по киберспорту Финал",
              "duration": 32400
            };
          </script>
        </body>
      </html>
    `, { url: "https://vk.com/video-12345_67890" });

    const results = detectSocialVideos("https://vk.com/video-12345_67890", dom.window.document);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const liveHls = results.find((r) => r.container === "hls");
    expect(liveHls).toBeDefined();
    expect(liveHls?.videoUrl).toContain("index.m3u8");
    expect(liveHls?.isManifest).toBe(true);
    expect(liveHls?.title).toBe("Турнир по киберспорту Финал");
    expect(liveHls?.thumbnailUrl).toBe("https://sun9-1.userapi.com/thumb.jpg");
    expect(liveHls?.durationSec).toBe(32400);
  });

  it("детектирует видео с vkvideo.ru через __NEXT_DATA__", () => {
    const dom = new JSDOM(`
      <!DOCTYPE html>
      <html>
        <head><title>Шоу выпуск 1</title></head>
        <body>
          <script id="__NEXT_DATA__" type="application/json">
            {
              "props": {
                "pageProps": {
                  "video": {
                    "title": "Эксклюзивное шоу",
                    "duration": 5400,
                    "thumb": "https://vkvideo.ru/thumb/999.jpg",
                    "files": {
                      "hls": "https://vkvideo.ru/master.m3u8",
                      "mp4_720": "https://vkuservideo.net/720.mp4",
                      "mp4_1080": "https://vkuservideo.net/1080.mp4"
                    }
                  }
                }
              }
            }
          </script>
        </body>
      </html>
    `, { url: "https://vkvideo.ru/video-1_2" });

    const w = dom.window as any;
    w.__NEXT_DATA__ = JSON.parse(dom.window.document.getElementById("__NEXT_DATA__")!.textContent!);

    const results = detectSocialVideos("https://vkvideo.ru/video-1_2", dom.window.document);
    expect(results.length).toBeGreaterThanOrEqual(3);

    const hls = results.find((r) => r.container === "hls");
    expect(hls).toBeDefined();
    expect(hls?.videoUrl).toBe("https://vkvideo.ru/master.m3u8");
    expect(hls?.title).toBe("Эксклюзивное шоу");

    const p1080 = results.find((r) => r.height === 1080);
    expect(p1080).toBeDefined();
    expect(p1080?.container).toBe("mp4");
  });

  it("корректно парсит многотысячные HLS-плейлисты для многочасовых стримов", () => {
    // Генерируем тестовый media m3u8 на 25 000 сегментов (~9 часов при 1.3с на сегмент)
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:2",
      "#EXT-X-MEDIA-SEQUENCE:0",
    ];
    for (let i = 0; i < 25000; i++) {
      lines.push("#EXTINF:1.3,", `seg_${i}.ts`);
    }
    lines.push("#EXT-X-ENDLIST");

    const parsed = parseHls(lines.join("\n"), "https://vkvideo.ru/stream/index.m3u8");
    expect(parsed.ok).toBe(true);
    expect(parsed.segments).toBeDefined();
    expect(parsed.segments?.length).toBe(25000);
    expect(parsed.isVOD).toBe(true);
  });
});
