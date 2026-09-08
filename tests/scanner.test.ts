import { describe, expect, it } from "vitest";
import { detectImages } from "../src/content/dom-image-detector";
import { extractLinks } from "../src/content/link-detector";

const BASE = "https://site.com/gallery/";

function doc(html: string): Document {
  const d = document.implementation.createHTMLDocument("test");
  d.body.innerHTML = html;
  return d;
}

describe("dom-image-detector", () => {
  it("находит обычные <img>", () => {
    const hits = detectImages(doc('<img src="a.jpg"> <img src="/b.png">'), { baseUrl: BASE, live: false });
    expect(hits.map((h) => h.variants[0].url).sort()).toEqual([
      "https://site.com/b.png",
      "https://site.com/gallery/a.jpg",
    ]);
  });

  it("находит srcset и объединяет варианты одного изображения", () => {
    const hits = detectImages(doc('<img src="a.jpg" srcset="a.jpg?w=800 800w, a.jpg?w=1600 1600w">'), {
      baseUrl: BASE,
      live: false,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].variants.length).toBeGreaterThanOrEqual(3);
    expect(hits[0].variants.some((v) => v.width === 800)).toBe(true);
  });

  it("находит <picture> source srcset", () => {
    const hits = detectImages(
      doc('<picture><source srcset="p.webp 1x, p@2x.webp 2x"><img src="p.jpg"></picture>'),
      { baseUrl: BASE, live: false }
    );
    const urls = hits.flatMap((h) => h.variants.map((v) => v.url));
    expect(urls).toContain("https://site.com/gallery/p.webp");
    expect(urls).toContain("https://site.com/gallery/p@2x.webp");
    expect(urls).toContain("https://site.com/gallery/p.jpg");
  });

  it("находит lazy-load атрибуты", () => {
    const hits = detectImages(
      doc('<img data-src="lazy1.jpg"> <img data-lazy-src="lazy2.jpg"> <img data-original="orig.jpg"> <img data-lazy="lazy3.webp">'),
      { baseUrl: BASE, live: false }
    );
    const urls = hits.map((h) => h.variants[0].url).sort();
    expect(urls).toContain("https://site.com/gallery/lazy1.jpg");
    expect(urls).toContain("https://site.com/gallery/lazy2.jpg");
    expect(urls).toContain("https://site.com/gallery/orig.jpg");
    expect(urls).toContain("https://site.com/gallery/lazy3.webp");
  });

  it("находит background-image из inline-стиля", () => {
    const hits = detectImages(doc('<div style="background-image:url(bg1.jpg)"></div><div style="background: #fff url(\'bg2.png\')"></div>'), {
      baseUrl: BASE,
      live: false,
    });
    const urls = hits.map((h) => h.variants[0].url).sort();
    expect(urls).toEqual(["https://site.com/gallery/bg1.jpg", "https://site.com/gallery/bg2.png"]);
  });

  it("находит meta og:image и twitter:image", () => {
    const d = document.implementation.createHTMLDocument("t");
    const m1 = d.createElement("meta");
    m1.setAttribute("property", "og:image");
    m1.setAttribute("content", "https://cdn.site.com/cover.jpg");
    d.head.appendChild(m1);
    const m2 = d.createElement("meta");
    m2.setAttribute("name", "twitter:image");
    m2.setAttribute("content", "/twitter-cover.jpg");
    d.head.appendChild(m2);
    const hits = detectImages(d, { baseUrl: BASE, live: false });
    const urls = hits.map((h) => h.variants[0].url).sort();
    expect(urls).toEqual(["https://cdn.site.com/cover.jpg", "https://site.com/twitter-cover.jpg"]);
  });

  it("находит прямые ссылки на изображения (<a href>)", () => {
    const hits = detectImages(doc('<a href="photo1.jpg">x</a><a href="/files/photo2.webp">y</a><a href="page.html">z</a>'), {
      baseUrl: BASE,
      live: false,
    });
    const urls = hits.map((h) => h.variants[0].url).sort();
    expect(urls).toEqual(["https://site.com/files/photo2.webp", "https://site.com/gallery/photo1.jpg"]);
  });

  it("разрешает относительные URL", () => {
    const hits = detectImages(doc('<img src="../up.jpg">'), { baseUrl: BASE, live: false });
    expect(hits[0].variants[0].url).toBe("https://site.com/up.jpg");
  });

  it("дедуплицирует одинаковые URL в пределах страницы", () => {
    const hits = detectImages(doc('<img src="a.jpg"><img src="a.jpg#frag"><img src="a.jpg?w=900">'), {
      baseUrl: BASE,
      live: false,
    });
    expect(hits).toHaveLength(1);
  });

  it("объединяет thumb_ и полный URL, качает полный", () => {
    const hits = detectImages(
      doc('<img src="/media/r/100/thumb_abc.jpeg"><img src="/media/r/100/abc.jpeg">'),
      { baseUrl: "https://chatpic.org/r/100", live: false }
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].variants[0].url).toBe("https://chatpic.org/media/r/100/abc.jpeg");
    expect(hits[0].variants.some((v) => v.url.includes("thumb_"))).toBe(true);
  });

  it("не собирает data:/blob: URL", () => {
    const hits = detectImages(doc('<img src="data:image/png;base64,AAAA">'), { baseUrl: BASE, live: false });
    expect(hits).toHaveLength(0);
  });

  it("проникает в открытые shadow roots (SPA/Web Components)", () => {
    const d = doc('<div id="host"></div>');
    const host = d.getElementById("host") as HTMLElement;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = '<img src="shadow1.jpg"><a href="https://site.com/page.html">l</a><div style="background-image:url(bg-shadow.png)"></div>';
    const hits = detectImages(d, { baseUrl: BASE, live: false });
    const urls = hits.map((h) => h.variants[0].url).sort();
    expect(urls).toEqual([
      "https://site.com/gallery/bg-shadow.png",
      "https://site.com/gallery/shadow1.jpg",
    ]);
  });

  it("не дублирует currentSrc === src", () => {
    const hits = detectImages(doc('<img src="same.jpg">'), { baseUrl: BASE, live: false });
    expect(hits[0].variants.filter((v) => v.url.endsWith("same.jpg"))).toHaveLength(1);
  });
});

describe("link-detector", () => {
  it("возвращает только http(s)-ссылки на HTML-страницы", () => {
    const d = doc(`
      <a href="page1.html">1</a>
      <a href="https://site.com/page2">2</a>
      <a href="mailto:a@b.c">m</a>
      <a href="javascript:void(0)">j</a>
      <a href="tel:123">t</a>
      <a href="/download.zip">z</a>
      <a href="/img.png">i</a>
      <a href="#frag">f</a>
      <a href="https://other.com/page3">3</a>
      <a href="/logout">l</a>
      <a href="/login">auth</a>
    `);
    const links = extractLinks(d, BASE).sort();
    expect(links).toEqual([
      "https://other.com/page3",
      "https://site.com/gallery/page1.html",
      "https://site.com/page2",
    ]);
  });
});