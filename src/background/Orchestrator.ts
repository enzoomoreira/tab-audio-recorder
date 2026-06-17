import { createLogger } from '../shared/Logger';
import { getSettings } from '../shared/Settings';
import { SessionState } from '../shared/SessionState';
import { updateBadge } from './badge';
import { saveCapture } from './RecordingsService';
import type { TabRecordingState, CaptureResult, ActionResult } from '../types';

const logger = createLogger('Orchestrator');

// Per-tab recording state, persisted to storage.session so it survives a
// background suspension (Firefox MV3 background is non-persistent).
const session = new SessionState();

// Safety net: if a tab enters 'processing' (stop acknowledged) but the
// RECORDING_COMPLETE message never arrives, reset it so the UI can't stay stuck.
// Timers are not persisted; hydrate() re-arms them.
const PROCESSING_TIMEOUT_MS = 30_000;
const processingTimers = new Map<number, ReturnType<typeof setTimeout>>();

// Optional cap on recording length (memory guard). Auto-stops via the normal
// STOP path, so it works uniformly across every capture strategy.
const maxDurationTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function getTabState(tabId: number): TabRecordingState {
  return session.state(tabId);
}

/** Restore state after a background wake and re-arm watchdogs for stuck tabs. */
export async function hydrate(): Promise<void> {
  await session.hydrate();
  for (const tabId of session.tabsInState('processing')) {
    armProcessingWatchdog(tabId);
  }
}

/** Drop all per-tab state and cancel any pending timers. */
export function clearTab(tabId: number): void {
  session.clear(tabId);
  clearProcessingWatchdog(tabId);
  clearMaxDuration(tabId);
  updateBadge(tabId, 'idle');
}

function armMaxDuration(tabId: number, seconds: number): void {
  clearMaxDuration(tabId);
  const timer = setTimeout(() => {
    maxDurationTimers.delete(tabId);
    if (session.state(tabId) === 'recording') {
      logger.info('Max duration reached for tab', tabId, '- auto-stopping');
      void stopRecording(tabId);
    }
  }, seconds * 1000);
  maxDurationTimers.set(tabId, timer);
}

function clearMaxDuration(tabId: number): void {
  const timer = maxDurationTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    maxDurationTimers.delete(tabId);
  }
}

function armProcessingWatchdog(tabId: number): void {
  clearProcessingWatchdog(tabId);
  const timer = setTimeout(() => {
    processingTimers.delete(tabId);
    if (session.state(tabId) === 'processing') {
      logger.warn('Processing watchdog fired for tab', tabId, '- resetting to idle');
      clearTab(tabId);
    }
  }, PROCESSING_TIMEOUT_MS);
  processingTimers.set(tabId, timer);
}

function clearProcessingWatchdog(tabId: number): void {
  const timer = processingTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    processingTimers.delete(tabId);
  }
}

export function onMediaURLDetected(tabId: number, frameId: number, url: string): void {
  session.addStreamURL(tabId, frameId, url);
  logger.debug('Stream URL cached for tab', tabId, 'frame', frameId, url);
}

async function listFrameIds(tabId: number): Promise<number[]> {
  try {
    const frames = await browser.webNavigation.getAllFrames({ tabId });
    if (!frames) return [0];
    // Top frame (frameId 0) first so we prefer it when multiple frames have media.
    return frames.map((f) => f.frameId).sort((a, b) => a - b);
  } catch {
    return [0];
  }
}

// Returns the first frame with a media element that is *currently playing*.
// Gating on `playing` (not merely "ever played") means a paused element left
// over from earlier playback no longer makes Strategy 1 capture silence -- the
// toggle falls through and arms instead.
async function findFrameWithMedia(tabId: number): Promise<number | null> {
  const frameIds = await listFrameIds(tabId);
  for (const frameId of frameIds) {
    try {
      const reply: { found: boolean; playing: boolean } | undefined =
        await browser.tabs.sendMessage(tabId, { type: 'CHECK_MEDIA' }, { frameId });
      if (reply?.playing) return frameId;
    } catch {
      // Frame may not have our content script (chrome://, about:, etc.).
    }
  }
  return null;
}

function findFrameWithStreamURL(tabId: number): { frameId: number; url: string } | null {
  const perFrame = session.streamURLs(tabId);
  if (!perFrame) return null;
  // Prefer top frame (frameId 0) if it has a stream; else first available.
  const sorted = [...perFrame.entries()].sort(([a], [b]) => a - b);
  const first = sorted[0];
  return first ? { frameId: first[0], url: first[1] } : null;
}

function markRecording(tabId: number, frameId: number, maxDurationSec: number): void {
  session.setActiveFrame(tabId, frameId);
  session.setState(tabId, 'recording');
  updateBadge(tabId, 'recording');
  if (maxDurationSec > 0) armMaxDuration(tabId, maxDurationSec);
}

export async function startRecording(tabId: number): Promise<ActionResult> {
  if (session.state(tabId) === 'recording') {
    return { ok: false, error: 'Already recording this tab' };
  }

  const settings = await getSettings();

  // --- Strategy 1: DOM element (captureStream) ---
  let mediaFrameId: number | null;
  try {
    mediaFrameId = await findFrameWithMedia(tabId);
  } catch {
    return { ok: false, error: 'Cannot communicate with page (try reloading the tab)' };
  }

  if (mediaFrameId !== null) {
    const result: { ok: boolean; error?: string } | undefined = await browser.tabs
      .sendMessage(
        tabId,
        { type: 'START_CAPTURE', payload: { bitrate: settings.bitrate } },
        { frameId: mediaFrameId },
      )
      .catch(() => undefined);

    if (result?.ok) {
      markRecording(tabId, mediaFrameId, settings.maxDurationSec);
      logger.info(
        'Recording started (DOM) tab',
        tabId,
        'frame',
        mediaFrameId,
        'bitrate:',
        settings.bitrate,
      );
      return { ok: true };
    }
    if (result && !result.ok) {
      return { ok: false, error: result.error ?? 'Failed to start DOM capture' };
    }
  }

  // --- Strategy 2: Network stream (fetch) ---
  let strategy2Error: string | undefined;
  const stream = findFrameWithStreamURL(tabId);
  if (stream) {
    const netResult: { ok: boolean; error?: string } | undefined = await browser.tabs
      .sendMessage(
        tabId,
        { type: 'START_NETWORK_CAPTURE', payload: { url: stream.url } },
        { frameId: stream.frameId },
      )
      .catch(() => undefined);

    if (netResult?.ok) {
      markRecording(tabId, stream.frameId, settings.maxDurationSec);
      logger.info(
        'Recording started (network fetch) tab',
        tabId,
        'frame',
        stream.frameId,
        'url:',
        stream.url,
      );
      return { ok: true };
    }
    strategy2Error = netResult?.error ?? 'Network capture failed';
  }

  // --- Strategy 3: Web Audio API hook ---
  const frameIds = await listFrameIds(tabId);
  for (const frameId of frameIds) {
    const reply: { ok: boolean; error?: string } | undefined = await browser.tabs
      .sendMessage(
        tabId,
        { type: 'START_WEBAUDIO_CAPTURE', payload: { bitrate: settings.bitrate } },
        { frameId },
      )
      .catch(() => undefined);
    if (reply?.ok) {
      markRecording(tabId, frameId, settings.maxDurationSec);
      logger.info('Recording started (Web Audio) tab', tabId, 'frame', frameId);
      return { ok: true };
    }
  }

  // A real stream-capture failure (a source existed but failed) is surfaced as-is
  // and is NOT armable. Only a clean "nothing is playing" outcome is armable, so
  // the toggle can arm and wait for the next playback.
  if (strategy2Error) {
    return { ok: false, error: strategy2Error };
  }
  return {
    ok: false,
    armable: true,
    error:
      'No audio source detected (no media element, no stream URL, no AudioContext). ' +
      'Make sure audio is playing before clicking Record.',
  };
}

export async function stopRecording(tabId: number): Promise<ActionResult> {
  if (session.state(tabId) !== 'recording') {
    return { ok: false, error: 'Not recording this tab' };
  }

  const frameId = session.activeFrame(tabId);
  if (frameId === undefined) {
    clearTab(tabId);
    return { ok: false, error: 'No active recording frame' };
  }

  session.setState(tabId, 'processing');

  const result: { ok: boolean; error?: string } | undefined = await browser.tabs
    .sendMessage(tabId, { type: 'STOP_CAPTURE' }, { frameId })
    .catch(() => undefined);

  if (!result?.ok) {
    clearTab(tabId);
    return { ok: false, error: result?.error ?? 'Failed to stop capture' };
  }

  // Stop acknowledged; the recording is now being assembled and will arrive via
  // RECORDING_COMPLETE. Guard against that message never landing.
  armProcessingWatchdog(tabId);
  return { ok: true };
}

async function broadcastDisarm(tabId: number): Promise<void> {
  const frameIds = await listFrameIds(tabId);
  for (const frameId of frameIds) {
    await browser.tabs
      .sendMessage(tabId, { type: 'DISARM_CAPTURE' }, { frameId })
      .catch(() => undefined);
  }
}

/**
 * Arms the tab: every frame's element hook is told to auto-capture the next
 * media element that plays. Capture itself starts in the page (zero round-trip),
 * and the winning frame reports back via `onArmedStarted`.
 */
export async function armRecording(tabId: number): Promise<ActionResult> {
  const state = session.state(tabId);
  if (state === 'recording') return { ok: false, error: 'Already recording this tab' };
  if (state === 'armed') return { ok: true };
  if (state === 'processing') return { ok: false, error: 'Tab is busy finishing a recording' };

  const settings = await getSettings();
  const frameIds = await listFrameIds(tabId);
  let delivered = 0;
  for (const frameId of frameIds) {
    const reply: { ok?: boolean } | undefined = await browser.tabs
      .sendMessage(
        tabId,
        { type: 'ARM_CAPTURE', payload: { bitrate: settings.bitrate } },
        { frameId },
      )
      .catch(() => undefined);
    if (reply?.ok) delivered++;
  }

  if (delivered === 0) {
    return {
      ok: false,
      error: 'Cannot arm: no capturable frame on this page (try reloading the tab)',
    };
  }

  session.setState(tabId, 'armed');
  updateBadge(tabId, 'armed');
  logger.info('Armed tab', tabId, 'across', delivered, 'frame(s)');
  return { ok: true };
}

/** Cancels a pending arm and returns the tab to idle. */
export async function disarmRecording(tabId: number): Promise<ActionResult> {
  if (session.state(tabId) !== 'armed') return { ok: false, error: 'Not armed' };
  await broadcastDisarm(tabId);
  clearTab(tabId);
  logger.info('Disarmed tab', tabId);
  return { ok: true };
}

/**
 * Single entry point shared by the popup button and the hotkey:
 * recording -> stop, armed -> disarm, idle -> start now if audio is playing,
 * otherwise arm and wait for the next playback.
 */
export async function toggleRecording(tabId: number): Promise<ActionResult> {
  const state = session.state(tabId);
  if (state === 'recording') return stopRecording(tabId);
  if (state === 'armed') return disarmRecording(tabId);
  if (state === 'processing') return { ok: false, error: 'Tab is busy finishing a recording' };

  const result = await startRecording(tabId);
  if (result.ok) return result;
  if (result.armable) return armRecording(tabId);
  return result;
}

/**
 * A frame's element hook auto-started capture after the tab was armed. Promote
 * the tab to 'recording' and disarm the other frames so a second concurrent
 * play() can't start a duplicate. If the tab is no longer armed (another frame
 * already won, or it was disarmed), tell this frame to discard its capture.
 */
export async function onArmedStarted(tabId: number, frameId: number): Promise<void> {
  if (session.state(tabId) !== 'armed') {
    await browser.tabs
      .sendMessage(tabId, { type: 'ABORT_CAPTURE' }, { frameId })
      .catch(() => undefined);
    return;
  }

  const settings = await getSettings();
  markRecording(tabId, frameId, settings.maxDurationSec);
  logger.info('Armed capture started on tab', tabId, 'frame', frameId);

  const frameIds = await listFrameIds(tabId);
  for (const other of frameIds) {
    if (other === frameId) continue;
    await browser.tabs
      .sendMessage(tabId, { type: 'DISARM_CAPTURE' }, { frameId: other })
      .catch(() => undefined);
  }
}

/**
 * Persist a finished capture and release the tab. Delegates the storage/export
 * work to RecordingsService; this wrapper owns only the tab lifecycle -- it
 * cancels the processing watchdog up front and always clears the tab, even on a
 * save failure, so a tab can never stay stuck in 'processing'.
 */
export async function saveRecording(tabId: number, result: CaptureResult): Promise<void> {
  clearProcessingWatchdog(tabId);
  try {
    await saveCapture(tabId, result);
  } finally {
    clearTab(tabId);
  }
}
