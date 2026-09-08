// Парсер robots.txt (best-effort, ТЗ §36). Поддерживает правила "*", Allow/Disallow,
// wildcard "*", "$" и Crawl-delay.
import { httpFetch } from "./http";

export interface RobotsRule {
  kind: "allow" | "disallow";
  pattern: string;
}

export class RobotsTxt {
  private rules: RobotsRule[] = [];
  crawlDelay?: number;

  static parse(text: string): RobotsTxt {
    const rt = new RobotsTxt();
    let inStarGroup = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === "user-agent") {
        inStarGroup = value === "*";
      } else if (inStarGroup) {
        if (key === "allow") rt.rules.push({ kind: "allow", pattern: value });
        else if (key === "disallow") rt.rules.push({ kind: "disallow", pattern: value });
        else if (key === "crawl-delay") {
          const d = parseFloat(value);
          if (!isNaN(d) && d > 0) rt.crawlDelay = d;
        }
      }
    }
    return rt;
  }

  static async fetch(origin: string, opts: { timeoutMs: number; fetchLike?: typeof fetch }): Promise<RobotsTxt> {
    try {
      const res = await httpFetch({
        url: `${origin}/robots.txt`,
        method: "GET",
        timeoutMs: opts.timeoutMs,
        maxBytes: 512 * 1024,
        fetchLike: opts.fetchLike,
      });
      if (res.ok && res.bodyText) return RobotsTxt.parse(res.bodyText);
      return new RobotsTxt();
    } catch {
      // Ошибка robots.txt не должна блокировать обход: по умолчанию allow.
      return new RobotsTxt();
    }
  }

  /** Разрешён ли путь правилами (длиннейшее совпадение побеждает; allow при равенстве). */
  allows(u: string): boolean {
    if (this.rules.length === 0) return true;
    let path: string;
    try {
      const url = new URL(u);
      path = url.pathname + url.search;
    } catch {
      return true;
    }
    let best: { kind: RobotsRule["kind"]; len: number } | null = null;
    for (const r of this.rules) {
      if (r.pattern === "" || r.pattern === undefined) continue;
      const m = matchRule(r.pattern, path);
      if (m !== null && (!best || m > best.len || (m === best.len && r.kind === "allow"))) {
        best = { kind: r.kind, len: m };
      }
    }
    if (!best) return true;
    return best.kind === "allow";
  }
}

/** Возвращает длину совпадения либо null. */
function matchRule(pattern: string, path: string): number | null {
  const hasWildcard = pattern.includes("*");
  const hasDollar = pattern.endsWith("$");
  const p = hasDollar ? pattern.slice(0, -1) : pattern;

  if (!hasWildcard && !hasDollar) {
    return path.startsWith(p) ? p.length : null;
  }
  if (hasWildcard || hasDollar) {
    // конвертируем в regex: экранируем всё, кроме "*"
    const rx = new RegExp(
      "^" +
        p
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        (hasDollar && !hasWildcard ? "$" : ".*")
    );
    const m = rx.exec(path);
    if (m) return m[0].length;
  }
  return null;
}