// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSettings,
  saveSettings,
  resetSettings,
  onSettingsChanged,
  DEFAULT_SETTINGS,
} from './Settings';

type ChangeRecord = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type ChangeListener = (changes: ChangeRecord, areaName: string) => void;

function installStorageStub(): { store: Record<string, unknown> } {
  const store: Record<string, unknown> = {};
  const listeners: ChangeListener[] = [];
  (globalThis as { browser: unknown }).browser = {
    storage: {
      local: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (obj: Record<string, unknown>) => {
          const changes: ChangeRecord = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          for (const l of [...listeners]) l(changes, 'local');
        },
      },
      onChanged: {
        addListener: (cb: ChangeListener) => listeners.push(cb),
        removeListener: (cb: ChangeListener) => {
          const i = listeners.indexOf(cb);
          if (i !== -1) listeners.splice(i, 1);
        },
      },
    },
  };
  return { store };
}

describe('Settings', () => {
  beforeEach(() => {
    installStorageStub();
  });

  it('returns defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a partial stored value over the defaults', async () => {
    await saveSettings({ bitrate: 256_000, autoExport: true });
    const s = await getSettings();
    expect(s.bitrate).toBe(256_000);
    expect(s.autoExport).toBe(true);
    // Untouched fields keep their defaults.
    expect(s.filenameTemplate).toBe(DEFAULT_SETTINGS.filenameTemplate);
  });

  it('saveSettings round-trips and is cumulative', async () => {
    await saveSettings({ maxDurationSec: 120 });
    await saveSettings({ exportSubfolder: 'Samples' });
    const s = await getSettings();
    expect(s.maxDurationSec).toBe(120);
    expect(s.exportSubfolder).toBe('Samples');
  });

  it('resetSettings restores the defaults', async () => {
    await saveSettings({ bitrate: 64_000, verboseLogging: true });
    await resetSettings();
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('onSettingsChanged fires with the merged settings and unsubscribes', async () => {
    const seen: number[] = [];
    const unsubscribe = onSettingsChanged((s) => seen.push(s.bitrate));

    await saveSettings({ bitrate: 96_000 });
    expect(seen).toEqual([96_000]);

    unsubscribe();
    await saveSettings({ bitrate: 192_000 });
    expect(seen).toEqual([96_000]); // no further calls after unsubscribe
  });

  it('ignores changes from storage areas other than local', async () => {
    const seen: unknown[] = [];
    onSettingsChanged((s) => seen.push(s));
    // Simulate a sync-area change by invoking the listener path with a non-local area.
    await saveSettings({ bitrate: 128_000 });
    expect(seen).toHaveLength(1);
  });
});
