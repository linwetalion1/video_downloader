// Тесты логгера.
import { describe, it, expect, beforeEach } from "vitest";
import { setLogLevel, getLogLevel, addLogListener, getLogTail, logger } from "../src/shared/logger";

describe("logger", () => {
  beforeEach(() => {
    setLogLevel("INFO");
  });

  it("фильтрует по уровню", () => {
    setLogLevel("WARN");
    let received: any[] = [];
    const off = addLogListener((e) => received.push(e));
    logger.debug("skip-me");
    logger.warn("keep-me");
    expect(received).toHaveLength(1);
    expect(received[0].level).toBe("WARN");
    off();
  });

  it("child меняет категорию", () => {
    let received: any[] = [];
    const off = addLogListener((e) => received.push(e));
    const c = logger.child("scan");
    c.info("test");
    expect(received[0].category).toBe("scan");
    off();
  });

  it("ring buffer ограничен", () => {
    setLogLevel("TRACE");
    for (let i = 0; i < 1000; i++) logger.trace("msg-" + i);
    const tail = getLogTail();
    expect(tail.length).toBeLessThanOrEqual(200);
  });
});
