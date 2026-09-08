// Fingerprint изображений (ТЗ §9.3): хеш начала файла + mime.
// Используется как вторичный уровень дедупликации (разные URL — одинаковый контент).
import { sha1Hex } from "../shared/utils";

export async function computeFingerprint(bytes: Uint8Array, mime?: string): Promise<string> {
  const sample = bytes.subarray(0, 4096);
  const h = await sha1Hex(sample);
  return `${mime ?? "unknown"}|${h}`;
}