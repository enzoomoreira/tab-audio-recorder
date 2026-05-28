import type { SortField, SortDirection } from '../types';

export interface Settings {
  // Recording
  bitrate: number;

  // Export
  exportSubfolder: string;
  autoExport: boolean;
  filenameTemplate: string;

  // Manager
  defaultSortField: SortField;
  defaultSortDirection: SortDirection;

  // Storage
  maxRecordings: number;

  // Advanced
  verboseLogging: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  bitrate: 128_000,
  exportSubfolder: 'TabRecordings',
  autoExport: false,
  filenameTemplate: '{host}_{date}_{time}',
  defaultSortField: 'startedAt',
  defaultSortDirection: 'desc',
  maxRecordings: 0,
  verboseLogging: false,
};

export const BITRATE_OPTIONS = [64_000, 96_000, 128_000, 192_000, 256_000] as const;

const STORAGE_KEY = 'settings';

function merge(partial: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(partial ?? {}) };
}

export async function getSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return merge(result[STORAGE_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(partial: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await browser.storage.local.set({ [STORAGE_KEY]: next });
}

export async function resetSettings(): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
}

export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const handler = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const change = changes[STORAGE_KEY];
    if (!change) return;
    callback(merge(change.newValue as Partial<Settings> | undefined));
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}
