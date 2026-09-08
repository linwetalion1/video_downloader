import { describe, expect, it } from "vitest";
import { Deduplicator } from "../src/crawler/deduplicator";
import { TaskQueue } from "../src/crawler/queue";
import { RateLimiter } from "../src/crawler/rate-limiter";
import { RobotsTxt } from "../src/crawler/robots";
import { canonicalUrl, parseSrcset, variantGroupKey } from "../src/shared/utils";
import type { Task } from "../src/shared/types";

describe("Deduplicator", () => {
  it("дедупликация страниц по canonical URL (hash, трекинг-параметры)", () => {
    const d = new Deduplicator();
    expect(d.markPageQueued("https://site.com/a?utm_source=x#top"));
    expect(d.isPageQueued("https://site.com/a")).toBe(true);
    expect(d.isPageQueued("https://site.com/A")).toBe(false);
  });

  it("pageKey убирает hash", () => {
    expect(canonicalUrl("https://site.com/page#section")).toBe("https://site.com/page");
  });

  it("регистрация изображений по группе вариантов", () => {
    const d = new Deduplicator();
    expect(d.registerImage("https://site.com/a.jpg")).toBe(true);
    expect(d.registerImage("https://site.com/a.jpg?w=1600")).toBe(false);
    expect(d.registerImage("https://site.com/a.jpg?id=2")).toBe(true); // другой id — другое изображение
  });

  it("visited/queued страницы не сканируются повторно", () => {
    const d = new Deduplicator();
    d.markPageQueued("https://s.com/p");
    expect(d.isPageQueued("https://s.com/p")).toBe(true);
    expect(d.markPageVisited("https://s.com/p")).toBe(true);
    expect(d.isPageQueued("https://s.com/p")).toBe(false);
    expect(d.markPageVisited("https://s.com/p")).toBe(false);
  });
});

describe("variantGroupKey", () => {
  it("объединяет resize-параметры", () => {
    expect(variantGroupKey("https://s.com/a.jpg")).toBe(variantGroupKey("https://s.com/a.jpg?w=800&h=600&q=80"));
    expect(variantGroupKey("https://s.com/a.jpg?id=1")).not.toBe(variantGroupKey("https://s.com/a.jpg?id=2"));
  });
});

describe("parseSrcset", () => {
  it("разбирает дескрипторы w/h/x", () => {
    const items = parseSrcset("a.jpg 800w, b.jpg 2x, c.jpg", "https://s.com/");
    expect(items).toHaveLength(3);
    expect(items[0].width).toBe(800);
    expect(items[1].density).toBe(2);
    expect(items[2].width).toBeUndefined();
    expect(items[0].url).toBe("https://s.com/a.jpg");
  });
});

describe("TaskQueue", () => {
  function t(partial: Partial<Task> & { id: string; url: string }): Task {
    return {
      type: "PAGE_SCAN",
      priority: 100,
      depth: 0,
      createdAt: 1,
      status: "QUEUED",
      retryCount: 0,
      ...partial,
    };
  }

  it("приоритеты: выше раньше; при равенстве — раньше созданный", () => {
    const q = new TaskQueue();
    q.push(t({ id: "1", url: "a", priority: 10, createdAt: 5 }));
    q.push(t({ id: "2", url: "b", priority: 50, createdAt: 1 }));
    q.push(t({ id: "3", url: "c", priority: 50, createdAt: 2 }));
    expect(q.pop()!.id).toBe("2");
    expect(q.pop()!.id).toBe("3");
    expect(q.pop()!.id).toBe("1");
    expect(q.pop()).toBeUndefined();
  });

  it("retryAt откладывает задачу", () => {
    const q = new TaskQueue();
    q.push(t({ id: "1", url: "slow", priority: 100, retryAt: Date.now() + 60_000 }));
    expect(q.pop(Date.now())).toBeUndefined();
    expect(q.pop(Date.now() + 61_000)?.id).toBe("1");
  });

  it("removeById / clear", () => {
    const q = new TaskQueue();
    q.push(t({ id: "a", url: "x" }));
    expect(q.removeById("a")).toBe(true);
    expect(q.isEmpty).toBe(true);
    q.push(t({ id: "b", url: "y" }));
    q.clear();
    expect(q.size).toBe(0);
  });
});

describe("RateLimiter", () => {
  it("задержка внутри [min, max]", async () => {
    const rl = new RateLimiter({ minMs: 5, maxMs: 15, maxBackoffMs: 1000 });
    const t0 = Date.now();
    await rl.wait();
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(4);
    expect(dt).toBeLessThanOrEqual(60); // допуск на накладные расходы CI
  });

  it("backoff удваивается на 429 и возвращается на успехе", () => {
    const rl = new RateLimiter({ minMs: 10, maxMs: 10, maxBackoffMs: 1000 });
    rl.reportStatus(429);
    expect(rl.factor).toBe(2);
    rl.reportStatus(429);
    expect(rl.factor).toBe(4);
    rl.reportStatus(200);
    expect(rl.factor).toBe(3); // 4 * 0.75
    for (let i = 0; i < 5; i++) rl.reportStatus(200);
    expect(rl.factor).toBe(1);
  });
});

describe("RobotsTxt", () => {
  it("парсит Disallow/Allow и выбирает длиннейшее совпадение", () => {
    const rt = RobotsTxt.parse(`
      User-agent: *
      Disallow: /private
      Allow: /private/public
      Disallow: /api/*
      Crawl-delay: 2
    `);
    expect(rt.allows("https://s.com/public")).toBe(true);
    expect(rt.allows("https://s.com/private/secret")).toBe(false);
    expect(rt.allows("https://s.com/private/public/photo.jpg")).toBe(true);
    expect(rt.allows("https://s.com/api/v1/foo")).toBe(false);
    expect(rt.crawlDelay).toBe(2);
  });

  it("без правил — всё разрешено", () => {
    const rt = RobotsTxt.parse("");
    expect(rt.allows("https://s.com/anything")).toBe(true);
  });

  it("поддерживает wildcard с *", () => {
    const rt = RobotsTxt.parse("User-agent: *\nDisallow: /*/temp\n");
    expect(rt.allows("https://s.com/x/temp/1")).toBe(false);
    expect(rt.allows("https://s.com/x/other")).toBe(true);
  });
});