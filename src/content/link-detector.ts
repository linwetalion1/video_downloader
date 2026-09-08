// Извлечение ссылок для обхода (ТЗ §8). Глубокий обход — включая shadow roots.
import { isHtmlPageUrl, isHttpUrl, normalizeUrl } from "../shared/utils";
import { deepQueryAll } from "./dom-image-detector";

const SKIP_FRAGMENT_URLS = [
  "#", "javascript:", "mailto:", "tel:", "sms:", "data:", "blob:", "file:",
  "ftp:", "chrome:", "about:", "edge:", "vbscript:",
];

/** Извлекает абсолютные http(s)-ссылки, которые потенциально являются HTML-страницами. */
export function extractLinks(doc: Document, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const a of deepQueryAll(doc, "a[href]")) {
    const href = (a.getAttribute("href") || "").trim();
    if (!href || href === "#") continue;
    const lower = href.toLowerCase();
    if (SKIP_FRAGMENT_URLS.some((p) => lower.startsWith(p))) continue;

    const abs = normalizeUrl(href, baseUrl);
    if (!abs || !isHttpUrl(abs)) continue;
    if (!isHtmlPageUrl(abs)) continue;

    // Очевидные action/logout/delete URL (ТЗ §8)
    if (/(logout|log-out|signout|sign-out|delete|remove|destroy|purge|abort|cancel)\b/i.test(new URL(abs).pathname)) continue;
    // Страницы авторизации
    if (/(login|login\.php|signin|auth|authenticate|password-reset|recover)/i.test(new URL(abs).pathname)) continue;

    out.add(abs);
  }
  return [...out];
}