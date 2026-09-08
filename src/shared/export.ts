import type { ImageCandidate } from "./types";

/** Экспорт списка изображений (ТЗ §52). */
export function buildCsv(candidates: ImageCandidate[]): string {
  const header = ["imageUrl", "sourcePageUrl", "width", "height", "fileSize", "mimeType", "depth", "status"];
  const esc = (v: string | number | undefined) => {
    const s = v === undefined || v === null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const c of candidates) {
    lines.push(
      [c.imageUrl, c.sourcePageUrl, c.width ?? "", c.height ?? "", c.fileSize ?? "", c.mimeType ?? "", c.depth, c.status].map(esc).join(",")
    );
  }
  return lines.join("\n");
}

export function buildJson(candidates: ImageCandidate[]): string {
  return JSON.stringify(
    candidates.map((c) => ({
      id: c.id,
      imageUrl: c.imageUrl,
      sourcePageUrl: c.sourcePageUrl,
      width: c.width ?? null,
      height: c.height ?? null,
      fileSize: c.fileSize ?? null,
      mimeType: c.mimeType ?? null,
      depth: c.depth,
      status: c.status,
      selected: c.selected,
    })),
    null,
    2
  );
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function buildDebugLog(logs: { time: number; level: string; message: string }[]): string {
  return logs
    .map((l) => `[${new Date(l.time).toISOString()}] [${l.level}] ${l.message}`)
    .join("\n");
}