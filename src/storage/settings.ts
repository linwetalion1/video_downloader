// Сохранение настроек и состояния через chrome.storage (ТЗ §39–40).
import { DEFAULTS, STORAGE_KEYS, STORAGE_LIMIT_HISTORY, STORAGE_LIMIT_LOGS } from "../shared/constants";
import type { HistoryEntry, JobView, Settings, UILogEntry } from "../shared/types";

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

export async function saveJobSnapshot(view: JobView | null): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.jobSnapshot]: view });
}

export async function loadJobSnapshot(): Promise<JobView | null> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.jobSnapshot);
    return (stored[STORAGE_KEYS.jobSnapshot] as JobView | undefined) ?? null;
  } catch {
    return null;
  }
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

export async function loadLogs(): Promise<UILogEntry[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.logs);
    return (stored[STORAGE_KEYS.logs] as UILogEntry[] | undefined) ?? [];
  } catch {
    return [];
  }
}

export async function appendLogs(entries: UILogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const logs = await loadLogs();
  logs.push(...entries);
  while (logs.length > STORAGE_LIMIT_LOGS) logs.shift();
  await chrome.storage.local.set({ [STORAGE_KEYS.logs]: logs });
}