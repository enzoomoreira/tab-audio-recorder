// @vitest-environment node
// RecordingsService owns the IndexedDB layer (a module-level singleton) and the
// export pipeline. Each test resets modules and re-imports for isolation.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Settings } from '../shared/Settings';
import type { CaptureResult } from '../types';

type DownloadFn = (opts: {
  url: string;
  filename: string;
  conflictAction?: string;
}) => Promise<number | undefined>;

interface ServiceStubs {
  settings?: Partial<Settings>;
  download?: DownloadFn;
}

// The export pipeline decodes the blob through Web Audio before re-encoding.
// Node has no AudioContext, so stand in a decoder that yields a short mono buffer.
class FakeAudioContext {
  sampleRate: number;
  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 48000;
  }
  decodeAudioData(): Promise<{
    numberOfChannels: number;
    sampleRate: number;
    length: number;
    getChannelData: () => Float32Array;
  }> {
    const length = 4608;
    return Promise.resolve({
      numberOfChannels: 1,
      sampleRate: this.sampleRate,
      length,
      getChannelData: () => new Float32Array(length),
    });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function loadService(stubs: ServiceStubs = {}) {
  vi.resetModules();
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  (globalThis as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  // Node lacks object-URL APIs that the export pipeline uses.
  (
    globalThis as { URL: { createObjectURL: unknown; revokeObjectURL: unknown } }
  ).URL.createObjectURL = () => 'blob:fake';
  (
    globalThis as { URL: { createObjectURL: unknown; revokeObjectURL: unknown } }
  ).URL.revokeObjectURL = () => undefined;
  (globalThis as { browser: unknown }).browser = {
    tabs: {
      get: async () => ({ url: 'http://example.com', title: 'Test' }),
    },
    storage: {
      local: {
        get: async () => (stubs.settings ? { settings: stubs.settings } : {}),
        set: async () => undefined,
      },
    },
    downloads: {
      download: stubs.download ?? (async () => 1),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
  return await import('./RecordingsService');
}

function captureResult(overrides: Partial<CaptureResult> = {}): CaptureResult {
  const startedAt = Date.UTC(2026, 0, 1);
  return {
    blob: new Blob(['audio-bytes'], { type: 'audio/webm' }),
    mimeType: 'audio/webm',
    durationMs: 1000,
    startedAt,
    endedAt: startedAt + 1000,
    ...overrides,
  };
}

describe('RecordingsService.saveCapture', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('persists the recording with tab metadata', async () => {
    const svc = await loadService();
    await svc.saveCapture(7, captureResult());
    const list = await svc.listRecordings();
    expect(list).toHaveLength(1);
    expect(list[0]?.sourceHost).toBe('example.com');
  });

  it('auto-exports through the downloads API when enabled', async () => {
    const downloads: { filename: string; conflictAction?: string }[] = [];
    const svc = await loadService({
      settings: { autoExport: true },
      download: async (opts) => {
        downloads.push(opts);
        return 1;
      },
    });
    await svc.saveCapture(7, captureResult());
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.filename).toMatch(/example\.com/);
    // Default format is WAV: the captured WebM is converted on export.
    expect(downloads[0]?.filename).toMatch(/\.wav$/);
    expect(downloads[0]?.conflictAction).toBe('uniquify');
  });

  it('honors the MP3 export format setting', async () => {
    const downloads: { filename: string }[] = [];
    const svc = await loadService({
      settings: { autoExport: true, exportFormat: 'mp3' },
      download: async (opts) => {
        downloads.push(opts);
        return 1;
      },
    });
    await svc.saveCapture(7, captureResult());
    expect(downloads[0]?.filename).toMatch(/\.mp3$/);
  });

  it('does not export when autoExport is off', async () => {
    const downloads: unknown[] = [];
    const svc = await loadService({
      download: async (opts) => {
        downloads.push(opts);
        return 1;
      },
    });
    await svc.saveCapture(7, captureResult());
    expect(downloads).toHaveLength(0);
  });

  it('prunes oldest recordings beyond maxRecordings', async () => {
    const svc = await loadService({ settings: { maxRecordings: 2 } });
    await svc.saveCapture(1, captureResult({ startedAt: 100, endedAt: 200 }));
    await svc.saveCapture(2, captureResult({ startedAt: 300, endedAt: 400 }));
    await svc.saveCapture(3, captureResult({ startedAt: 500, endedAt: 600 }));
    const list = await svc.listRecordings();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.startedAt)).not.toContain(100);
  });
});

describe('RecordingsService.exportRecordingById', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('exports an existing recording and errors on a missing id', async () => {
    const downloads: unknown[] = [];
    const svc = await loadService({
      download: async (opts) => {
        downloads.push(opts);
        return 1;
      },
    });
    await svc.saveCapture(7, captureResult());
    const [m] = await svc.listRecordings();
    const ok = await svc.exportRecordingById(m!.id);
    expect(ok.ok).toBe(true);
    expect(downloads).toHaveLength(1);

    const missing = await svc.exportRecordingById('does-not-exist');
    expect(missing.ok).toBe(false);
  });
});
