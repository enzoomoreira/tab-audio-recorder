import type { TabRecordingState } from '../types';
import { createLogger } from './Logger';

const logger = createLogger('SessionState');
const KEY = 'recordingState';

// Serializable form of the three Maps (storage holds JSON, so Maps become
// entry arrays and are rebuilt on hydrate).
interface Snapshot {
  tabStates: [number, TabRecordingState][];
  activeFrames: [number, number][];
  tabStreamURLs: [number, [number, string][]][];
}

/**
 * Per-tab recording state with write-through persistence to
 * `browser.storage.session`. The Firefox MV3 background is non-persistent and
 * may be suspended mid-recording; persisting here lets `hydrate()` rebuild the
 * routing tables on the next wake so STOP still reaches the right frame.
 *
 * storage.session is in-memory and cleared on browser restart, which matches
 * the lifetime of an in-flight recording.
 */
export class SessionState {
  private tabStates = new Map<number, TabRecordingState>();
  private activeFrames = new Map<number, number>();
  private tabStreamURLs = new Map<number, Map<number, string>>();

  async hydrate(): Promise<void> {
    try {
      const result = await browser.storage.session.get(KEY);
      const snap = result[KEY] as Snapshot | undefined;
      if (!snap) return;
      this.tabStates = new Map(snap.tabStates);
      this.activeFrames = new Map(snap.activeFrames);
      this.tabStreamURLs = new Map(snap.tabStreamURLs.map(([tabId, e]) => [tabId, new Map(e)]));
      logger.info('Rehydrated state for', this.tabStates.size, 'tab(s)');
    } catch (err) {
      logger.warn('Could not hydrate session state:', err);
    }
  }

  private persist(): void {
    const snap: Snapshot = {
      tabStates: [...this.tabStates],
      activeFrames: [...this.activeFrames],
      tabStreamURLs: [...this.tabStreamURLs].map(([tabId, e]) => [tabId, [...e]]),
    };
    void browser.storage.session.set({ [KEY]: snap }).catch((err: unknown) => {
      logger.warn('Could not persist session state:', err);
    });
  }

  state(tabId: number): TabRecordingState {
    return this.tabStates.get(tabId) ?? 'idle';
  }

  setState(tabId: number, state: TabRecordingState): void {
    this.tabStates.set(tabId, state);
    this.persist();
  }

  activeFrame(tabId: number): number | undefined {
    return this.activeFrames.get(tabId);
  }

  setActiveFrame(tabId: number, frameId: number): void {
    this.activeFrames.set(tabId, frameId);
    this.persist();
  }

  addStreamURL(tabId: number, frameId: number, url: string): void {
    let perFrame = this.tabStreamURLs.get(tabId);
    if (!perFrame) {
      perFrame = new Map<number, string>();
      this.tabStreamURLs.set(tabId, perFrame);
    }
    perFrame.set(frameId, url);
    this.persist();
  }

  streamURLs(tabId: number): ReadonlyMap<number, string> | undefined {
    return this.tabStreamURLs.get(tabId);
  }

  clear(tabId: number): void {
    this.tabStates.delete(tabId);
    this.activeFrames.delete(tabId);
    this.tabStreamURLs.delete(tabId);
    this.persist();
  }

  /** Tabs currently in a given state -- used to re-arm watchdogs after hydrate. */
  tabsInState(state: TabRecordingState): number[] {
    return [...this.tabStates.entries()].filter(([, s]) => s === state).map(([tabId]) => tabId);
  }
}
