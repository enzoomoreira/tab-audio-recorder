import type { TabRecordingState } from '../types';
import { createLogger } from './Logger';

const logger = createLogger('SessionState');
const KEY = 'recordingState';

// Serializable form of the Maps (storage holds JSON, so Maps become
// entry arrays and are rebuilt on hydrate).
interface Snapshot {
  tabStates: [number, TabRecordingState][];
  activeFrames: [number, number][];
  tabStreamURLs: [number, [number, string][]][];
  deadlines?: [number, number][];
  errors?: [number, string][];
  captures?: [number, [number, string][]][];
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
  private deadlines = new Map<number, number>();
  private errors = new Map<number, string>();
  private captures = new Map<number, Map<number, string>>();

  async hydrate(): Promise<void> {
    try {
      const result = await browser.storage.session.get(KEY);
      const snap = result[KEY] as Snapshot | undefined;
      if (!snap) return;
      this.tabStates = new Map(snap.tabStates);
      this.activeFrames = new Map(snap.activeFrames);
      this.tabStreamURLs = new Map(snap.tabStreamURLs.map(([tabId, e]) => [tabId, new Map(e)]));
      this.deadlines = new Map(snap.deadlines);
      this.errors = new Map(snap.errors);
      this.captures = new Map(snap.captures?.map(([tab, frames]) => [tab, new Map(frames)]));
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
      deadlines: [...this.deadlines],
      errors: [...this.errors],
      captures: [...this.captures].map(([tab, frames]) => [tab, [...frames]]),
    };
    void browser.storage.session.set({ [KEY]: snap }).catch((err: unknown) => {
      logger.warn('Could not persist session state:', err);
    });
  }

  state(tabId: number): TabRecordingState {
    return this.tabStates.get(tabId) ?? 'idle';
  }

  deadline(tabId: number): number | undefined {
    return this.deadlines.get(tabId);
  }

  setDeadline(tabId: number, deadline: number): void {
    this.deadlines.set(tabId, deadline);
    this.persist();
  }

  clearDeadline(tabId: number): void {
    this.deadlines.delete(tabId);
    this.persist();
  }

  error(tabId: number): string | undefined {
    return this.errors.get(tabId);
  }

  setError(tabId: number, error: string): void {
    this.errors.set(tabId, error);
    this.persist();
  }

  setState(tabId: number, state: TabRecordingState): void {
    this.tabStates.set(tabId, state);
    if (state !== 'idle') this.errors.delete(tabId);
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

  clearStreamURL(tabId: number, frameId: number): void {
    const perFrame = this.tabStreamURLs.get(tabId);
    if (!perFrame) return;
    perFrame.delete(frameId);
    if (perFrame.size === 0) this.tabStreamURLs.delete(tabId);
    this.persist();
  }

  clear(tabId: number): void {
    this.captures.delete(tabId);
    this.tabStates.delete(tabId);
    this.activeFrames.delete(tabId);
    this.tabStreamURLs.delete(tabId);
    this.deadlines.delete(tabId);
    this.errors.delete(tabId);
    this.persist();
  }

  /** Tabs currently in a given state -- used to re-arm watchdogs after hydrate. */
  tabsInState(state: TabRecordingState): number[] {
    return [...this.tabStates.entries()].filter(([, s]) => s === state).map(([tabId]) => tabId);
  }

  captureId(tabId: number, frameId: number): string | undefined {
    return this.captures.get(tabId)?.get(frameId);
  }

  captureFrames(tabId: number): [number, string][] {
    return [...(this.captures.get(tabId)?.entries() ?? [])];
  }

  captureIds(tabId?: number): string[] {
    if (tabId !== undefined) return [...(this.captures.get(tabId)?.values() ?? [])];
    return [...this.captures.values()].flatMap((frames) => [...frames.values()]);
  }

  setCapture(tabId: number, frameId: number, id: string): void {
    const frames = this.captures.get(tabId) ?? new Map<number, string>();
    frames.set(frameId, id);
    this.captures.set(tabId, frames);
    this.persist();
  }

  clearCapture(tabId: number, frameId: number): void {
    const frames = this.captures.get(tabId);
    frames?.delete(frameId);
    if (frames?.size === 0) this.captures.delete(tabId);
    this.persist();
  }
}
