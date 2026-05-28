// @vitest-environment node
// Orchestrator owns module-level state (tabStates, activeFrames, tabStreamURLs).
// Each test resets modules and re-imports for isolation.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

type SendMessage = (
  tabId: number,
  message: { type: string; payload?: Record<string, unknown> },
  options?: { frameId?: number },
) => Promise<{ ok?: boolean; found?: boolean; error?: string } | undefined>;

interface BrowserStubs {
  sendMessage: SendMessage;
  getAllFrames?: (q: { tabId: number }) => Promise<{ frameId: number }[]>;
}

async function loadOrchestrator(stubs: BrowserStubs) {
  vi.resetModules();
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
  (globalThis as { browser: unknown }).browser = {
    runtime: { getURL: (p: string) => p },
    tabs: {
      sendMessage: stubs.sendMessage,
      get: async () => ({ url: 'http://example.com', title: 'Test' }),
      onRemoved: { addListener: () => {} },
    },
    webNavigation: {
      getAllFrames: stubs.getAllFrames ?? (async () => [{ frameId: 0 }]),
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener: () => {} },
    },
    downloads: { download: async () => 1, onChanged: { addListener: () => {}, removeListener: () => {} } },
  };
  return await import('./Orchestrator');
}

describe('Orchestrator.startRecording', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('strategy 1 succeeds: CHECK_MEDIA found in top frame, START_CAPTURE ok', async () => {
    const calls: { type: string; frameId: number | undefined }[] = [];
    const orch = await loadOrchestrator({
      sendMessage: async (_t, msg, opts) => {
        calls.push({ type: msg.type, frameId: opts?.frameId });
        if (msg.type === 'CHECK_MEDIA') return { found: true };
        if (msg.type === 'START_CAPTURE') return { ok: true };
        return undefined;
      },
    });
    const result = await orch.startRecording(7);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.type)).toContain('START_CAPTURE');
    expect(orch.getTabState(7)).toBe('recording');
  });

  it('strategy 2 fallback: no media element, but a cached stream URL exists', async () => {
    const orch = await loadOrchestrator({
      sendMessage: async (_t, msg) => {
        if (msg.type === 'CHECK_MEDIA') return { found: false };
        if (msg.type === 'START_NETWORK_CAPTURE') return { ok: true };
        return undefined;
      },
    });
    orch.onMediaURLDetected(7, 0, 'https://radio.example/stream.mp3');
    const result = await orch.startRecording(7);
    expect(result.ok).toBe(true);
    expect(orch.getTabState(7)).toBe('recording');
  });

  it('strategy 3 fallback: no element, no stream URL, but Web Audio replies ok', async () => {
    const orch = await loadOrchestrator({
      sendMessage: async (_t, msg) => {
        if (msg.type === 'CHECK_MEDIA') return { found: false };
        if (msg.type === 'START_WEBAUDIO_CAPTURE') return { ok: true };
        return undefined;
      },
    });
    const result = await orch.startRecording(7);
    expect(result.ok).toBe(true);
    expect(orch.getTabState(7)).toBe('recording');
  });

  it('returns no-source error when all three strategies fail', async () => {
    const orch = await loadOrchestrator({
      sendMessage: async (_t, msg) => {
        if (msg.type === 'CHECK_MEDIA') return { found: false };
        if (msg.type === 'START_WEBAUDIO_CAPTURE') return { ok: false, error: 'no ctx' };
        return undefined;
      },
    });
    const result = await orch.startRecording(7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no audio source/i);
  });

  it('strategy 1 error from content script is propagated', async () => {
    const orch = await loadOrchestrator({
      sendMessage: async (_t, msg) => {
        if (msg.type === 'CHECK_MEDIA') return { found: true };
        if (msg.type === 'START_CAPTURE') return { ok: false, error: 'DRM/EME content cannot be captured (Firefox security policy)' };
        return undefined;
      },
    });
    const result = await orch.startRecording(7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/DRM/);
  });

  it('strategy 2 error is preserved when strategy 3 also has no contexts', async () => {
    const orch = await loadOrchestrator({
      sendMessage: async (_t, msg) => {
        if (msg.type === 'CHECK_MEDIA') return { found: false };
        if (msg.type === 'START_NETWORK_CAPTURE') return { ok: false, error: 'fetch refused' };
        if (msg.type === 'START_WEBAUDIO_CAPTURE') return { ok: false, error: 'no ctx' };
        return undefined;
      },
    });
    orch.onMediaURLDetected(7, 0, 'https://radio.example/stream.mp3');
    const result = await orch.startRecording(7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('fetch refused');
  });

  it('rejects double-start on same tab', async () => {
    const orch = await loadOrchestrator({
      sendMessage: async (_t, msg) => {
        if (msg.type === 'CHECK_MEDIA') return { found: true };
        if (msg.type === 'START_CAPTURE') return { ok: true };
        return undefined;
      },
    });
    await orch.startRecording(7);
    const second = await orch.startRecording(7);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already recording/i);
  });
});

describe('Orchestrator: frame routing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('iterates frames in ascending order and picks the first with media', async () => {
    const checkedFrames: number[] = [];
    const startedFrame: { id: number | undefined } = { id: undefined };
    const orch = await loadOrchestrator({
      getAllFrames: async () => [{ frameId: 0 }, { frameId: 12 }, { frameId: 34 }],
      sendMessage: async (_t, msg, opts) => {
        if (msg.type === 'CHECK_MEDIA') {
          checkedFrames.push(opts?.frameId ?? -1);
          return { found: opts?.frameId === 12 };
        }
        if (msg.type === 'START_CAPTURE') {
          startedFrame.id = opts?.frameId;
          return { ok: true };
        }
        return undefined;
      },
    });
    const result = await orch.startRecording(99);
    expect(result.ok).toBe(true);
    expect(checkedFrames).toEqual([0, 12]); // stops at first found
    expect(startedFrame.id).toBe(12);
  });

  it('top frame is preferred when it has a cached stream URL', async () => {
    const startedFrame: { id: number | undefined } = { id: undefined };
    const orch = await loadOrchestrator({
      getAllFrames: async () => [{ frameId: 0 }, { frameId: 5 }],
      sendMessage: async (_t, msg, opts) => {
        if (msg.type === 'CHECK_MEDIA') return { found: false };
        if (msg.type === 'START_NETWORK_CAPTURE') {
          startedFrame.id = opts?.frameId;
          return { ok: true };
        }
        return undefined;
      },
    });
    orch.onMediaURLDetected(99, 5, 'https://x/stream.mp3');
    orch.onMediaURLDetected(99, 0, 'https://x/stream.mp3');
    await orch.startRecording(99);
    expect(startedFrame.id).toBe(0);
  });
});

describe('Orchestrator.stopRecording', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('routes STOP_CAPTURE to the active frame', async () => {
    let stoppedFrame: number | undefined;
    const orch = await loadOrchestrator({
      getAllFrames: async () => [{ frameId: 0 }, { frameId: 9 }],
      sendMessage: async (_t, msg, opts) => {
        if (msg.type === 'CHECK_MEDIA') return { found: opts?.frameId === 9 };
        if (msg.type === 'START_CAPTURE') return { ok: true };
        if (msg.type === 'STOP_CAPTURE') {
          stoppedFrame = opts?.frameId;
          return { ok: true };
        }
        return undefined;
      },
    });
    await orch.startRecording(42);
    expect(orch.getTabState(42)).toBe('recording');
    const result = await orch.stopRecording(42);
    expect(result.ok).toBe(true);
    expect(stoppedFrame).toBe(9);
    expect(orch.getTabState(42)).toBe('processing');
  });

  it('refuses when tab is not recording', async () => {
    const orch = await loadOrchestrator({ sendMessage: async () => undefined });
    const result = await orch.stopRecording(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not recording/i);
  });
});

describe('Orchestrator.onTabRemoved', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('clears state when tab closes during recording', async () => {
    const orch = await loadOrchestrator({
      sendMessage: async (_t, msg) => {
        if (msg.type === 'CHECK_MEDIA') return { found: true };
        if (msg.type === 'START_CAPTURE') return { ok: true };
        return undefined;
      },
    });
    await orch.startRecording(1);
    expect(orch.getTabState(1)).toBe('recording');
    orch.onTabRemoved(1);
    expect(orch.getTabState(1)).toBe('idle');
  });
});
