// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionState } from './SessionState';

function installSessionStub(): { store: Record<string, unknown> } {
  const store: Record<string, unknown> = {};
  (globalThis as { browser: unknown }).browser = {
    storage: {
      session: {
        get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
        set: async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        },
      },
    },
  };
  return { store };
}

describe('SessionState', () => {
  beforeEach(() => {
    installSessionStub();
  });

  it('defaults unknown tabs to idle', () => {
    expect(new SessionState().state(99)).toBe('idle');
  });

  it('write-through persists and a fresh instance rehydrates it', async () => {
    const a = new SessionState();
    a.setActiveFrame(7, 3);
    a.setState(7, 'recording');
    a.addStreamURL(7, 3, 'https://x/stream.mp3');

    const b = new SessionState();
    await b.hydrate();
    expect(b.state(7)).toBe('recording');
    expect(b.activeFrame(7)).toBe(3);
    expect(b.streamURLs(7)?.get(3)).toBe('https://x/stream.mp3');
  });

  it('clear removes all per-tab state', async () => {
    const a = new SessionState();
    a.setState(1, 'recording');
    a.setActiveFrame(1, 0);
    a.clear(1);

    const b = new SessionState();
    await b.hydrate();
    expect(b.state(1)).toBe('idle');
    expect(b.activeFrame(1)).toBeUndefined();
  });

  it('tabsInState lists tabs by state', () => {
    const s = new SessionState();
    s.setState(1, 'recording');
    s.setState(2, 'processing');
    s.setState(3, 'recording');
    expect(s.tabsInState('recording').sort()).toEqual([1, 3]);
    expect(s.tabsInState('processing')).toEqual([2]);
  });

  it('hydrate is a no-op when nothing is stored', async () => {
    const s = new SessionState();
    await s.hydrate();
    expect(s.state(1)).toBe('idle');
  });
});
