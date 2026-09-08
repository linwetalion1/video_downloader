import { describe, expect, it } from "vitest";
import { sniffImageInfo } from "../src/images/metadata";

function u8(...values: number[] | [number[]]): Uint8Array {
  return new Uint8Array(Array.isArray(values[0]) ? values[0] : (values as number[]));
}

function png(width: number, height: number): Uint8Array {
  const b: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  b.push(0, 0, 0, 13); // IHDR length
  b.push(...[73, 72, 68, 82]); // "IHDR"
  b.push((width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff);
  b.push((height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff);
  b.push(8, 6, 0, 0, 0);
  return u8(b);
}

function gif(width: number, height: number): Uint8Array {
  const b = [..."GIF89a"].map((c) => c.charCodeAt(0));
  b.push(width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff);
  return u8(b);
}

function webpLossless(w: number, h: number): Uint8Array {
  const b = [..."RIFF"].map((c) => c.charCodeAt(0));
  b.push(0, 0, 0, 0);
  b.push(...[... "WEBPVP8L"].map((c) => c.charCodeAt(0)));
  b.push(0, 0, 0, 0, 0x2f);
  const v = (w - 1) | ((h - 1) << 14);
  b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  return u8(b);
}

function jpeg(width: number, height: number): Uint8Array {
  const b: number[] = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
  b.push(...[... "JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000"].map((c) => c.charCodeAt(0)));
  b.push(0xff, 0xc0, 0x00, 0x11, 0x08);
  b.push((height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff);
  return u8(b);
}

describe("sniffImageInfo", () => {
  it("PNG", () => {
    const info = sniffImageInfo(png(640, 480));
    expect(info.width).toBe(640);
    expect(info.height).toBe(480);
    expect(info.detectedMime).toBe("image/png");
    expect(info.kind).toBe("raster");
  });

  it("GIF", () => {
    const info = sniffImageInfo(gif(1200, 800));
    expect(info.width).toBe(1200);
    expect(info.height).toBe(800);
    expect(info.detectedMime).toBe("image/gif");
  });

  it("WebP (VP8L)", () => {
    const info = sniffImageInfo(webpLossless(300, 200));
    expect(info.width).toBe(300);
    expect(info.height).toBe(200);
    expect(info.detectedMime).toBe("image/webp");
  });

  it("JPEG", () => {
    const info = sniffImageInfo(jpeg(1920, 1080));
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.detectedMime).toBe("image/jpeg");
  });

  it("SVG — особая обработка (kind=svg, размер неизвестен)", () => {
    const svgBytes = u8([...`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect/></svg>`].map((c) => c.charCodeAt(0)));
    const info = sniffImageInfo(svgBytes);
    expect(info.kind).toBe("svg");
    expect(info.detectedMime).toBe("image/svg+xml");
    expect(info.width).toBe(100);
    expect(info.height).toBe(50);
  });

  it("SVG без размеров — undefined", () => {
    const svgBytes = u8([...`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`].map((c) => c.charCodeAt(0)));
    const info = sniffImageInfo(svgBytes);
    expect(info.width).toBeUndefined();
    expect(info.height).toBeUndefined();
  });

  it("мусор — unknown", () => {
    const info = sniffImageInfo(u8(1, 2, 3, 4, 5, 6, 7, 8, 9));
    expect(info.kind).toBe("unknown");
  });
});