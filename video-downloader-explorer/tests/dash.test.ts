// Тесты DASH-парсера.
import { describe, it, expect } from "vitest";
import { parseDash } from "../src/media/dash";

describe("parseDash", () => {
  it("перечисляет сегменты по SegmentTimeline ($Number$)", () => {
    const xml = [
      "<MPD mediaPresentationDuration=\"PT12S\" type=\"static\"><Period>",
      "<AdaptationSet mimeType=\"video/mp4\">",
      "<Representation id=\"v1\" bandwidth=\"1000000\" width=\"1280\" height=\"720\">",
      "<SegmentTemplate timescale=\"1\" initialization=\"$RepresentationID$/init.mp4\" media=\"$RepresentationID$/seg-$Number$.m4s\" startNumber=\"1\">",
      "<SegmentTimeline><S d=\"4\" r=\"2\"/></SegmentTimeline>",
      "</SegmentTemplate>",
      "</Representation>",
      "</AdaptationSet></Period></MPD>",
    ].join("");
    const r = parseDash(xml, "https://x.com/manifest.mpd");
    expect(r.ok).toBe(true);
    expect(r.variants).toHaveLength(1);
    const segs = r.variants[0].segments!;
    // init + 3 медиа-сегмента (d=4, r=2 → 3 повтора)
    expect(segs).toHaveLength(4);
    expect(segs[0]).toEqual({ url: "https://x.com/v1/init.mp4", isInit: true });
    expect(segs[1].url).toBe("https://x.com/v1/seg-1.m4s");
    expect(segs[3].url).toBe("https://x.com/v1/seg-3.m4s");
  });

  it("перечисляет сегменты по duration/startNumber без timeline", () => {
    const xml = [
      "<MPD mediaPresentationDuration=\"PT10S\"><Period duration=\"PT10S\">",
      "<AdaptationSet contentType=\"video\">",
      "<Representation id=\"42\" bandwidth=\"500000\">",
      "<SegmentTemplate timescale=\"1\" duration=\"5\" startNumber=\"7\" initialization=\"init_$RepresentationID$.mp4\" media=\"chunk_$Number%04d$.m4s\"/>",
      "</Representation>",
      "</AdaptationSet></Period></MPD>",
    ].join("");
    const r = parseDash(xml, "https://x.com/m.mpd");
    const segs = r.variants[0].segments!;
    expect(segs).toHaveLength(3); // init + 10s / 5s = 2
    expect(segs[1].url).toBe("https://x.com/chunk_0007.m4s");
    expect(segs[2].url).toBe("https://x.com/chunk_0008.m4s");
  });

  it("самозакрывающийся Representation парсится", () => {
    const xml = [
      "<MPD><Period>",
      "<AdaptationSet mimeType=\"video/mp4\">",
      "<Representation id=\"a\" bandwidth=\"300000\"/>",
      "<Representation id=\"b\" bandwidth=\"900000\" width=\"640\" height=\"360\"/>",
      "</AdaptationSet></Period></MPD>",
    ].join("");
    const r = parseDash(xml, "https://x.com/m.mpd");
    expect(r.ok).toBe(true);
    expect(r.variants).toHaveLength(2);
    expect(r.variants[1].height).toBe(360);
  });

  it("Widevine ContentProtection → isDRM", () => {
    const xml = [
      "<MPD><Period><AdaptationSet>",
      "<ContentProtection schemeIdUri=\"urn:mpeg:dash:mp4protection:2011\" value=\"cenc\"/>",
      "<ContentProtection schemeIdUri=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"/>",
      "<Representation id=\"a\" bandwidth=\"1\"/>",
      "</AdaptationSet></Period></MPD>",
    ].join("");
    const r = parseDash(xml, "https://x.com/m.mpd");
    expect(r.isDRM).toBe(true);
  });

  it("$Time$ подставляется из таймлайна", () => {
    const xml = [
      "<MPD><Period><AdaptationSet mimeType=\"video/mp4\">",
      "<Representation id=\"v\" bandwidth=\"1\">",
      "<SegmentTemplate timescale=\"90000\" media=\"$Time$.m4s\" initialization=\"i.m4s\">",
      "<SegmentTimeline><S t=\"0\" d=\"90000\"/><S t=\"180000\" d=\"45000\"/></SegmentTimeline>",
      "</SegmentTemplate>",
      "</Representation></AdaptationSet></Period></MPD>",
    ].join("");
    const r = parseDash(xml, "https://x.com/m.mpd");
    const segs = r.variants[0].segments!;
    expect(segs.map((s) => s.url)).toEqual(["https://x.com/i.m4s", "https://x.com/0.m4s", "https://x.com/180000.m4s"]);
  });
});
