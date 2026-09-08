// Сохранение настроек и состояния через chrome.storage.
import { DEFAULTS, STORAGE_KEYS, STORAGE_LIMIT_HISTORY } from "../shared/constants";
import type { HistoryEntry, JobView, Settings } from "../shared/types";

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const raw = stored[STORAGE_KEYS.settings] as Partial<Settings> | undefined;
    return { ...structuredClone(DEFAULTS), ...(raw ?? {}) };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
}

/** Снапшоты задач хранятся ПО ВКЛАДКАМ: у каждой вкладки своё независимое
 *  состояние (результаты скана, выбор, загрузки). Ключ — String(tabId). */
export async function saveJobSnapshotFor(tabId: number, view: JobView | null): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.jobSnapshots);
    const map = (stored[STORAGE_KEYS.jobSnapshots] as Record<string, JobView> | undefined) ?? {};
    if (view) {
      if (view.candidates.length > 1000) view.logTail = view.logTail.slice(-100);
      map[String(tabId)] = view;
    } else {
      delete map[String(tabId)];
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.jobSnapshots]: map });
  } catch { /* ignore */ }
}

export async function loadJobSnapshotFor(tabId: number): Promise<JobView | null> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.jobSnapshots);
    const map = (stored[STORAGE_KEYS.jobSnapshots] as Record<string, JobView> | undefined) ?? {};
    return map[String(tabId)] ?? null;
  } catch {
    return null;
  }
}

export async function removeJobSnapshot(tabId: number): Promise<void> {
  await saveJobSnapshotFor(tabId, null);
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.history);
    return (stored[STORAGE_KEYS.history] as HistoryEntry[] | undefined) ?? [];
  } catch {
    return [];
  }
}

export async function addHistoryEntry(entry: HistoryEntry): Promise<HistoryEntry[]> {
  const history = await loadHistory();
  history.unshift(entry);
  while (history.length > STORAGE_LIMIT_HISTORY) history.pop();
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: history });
  return history;
}

export async function removeHistoryEntry(id: string): Promise<HistoryEntry[]> {
  const history = (await loadHistory()).filter((h) => h.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: history });
  return history;
}
