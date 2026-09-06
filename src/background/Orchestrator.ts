import { createLogger } from '../shared/Logger';
import { getSettings } from '../shared/Settings';
import { SessionState } from '../shared/SessionState';
import { updateBadge } from './badge';
import {
  saveCapture,
  beginCapture,
  appendCapture,
  interruptCapture,
  discardCapture,
  recoverCaptures,
  getCaptureMetadata,
} from './RecordingsService';
import type {
  TabRecordingState,
  CaptureResult,
  ActionResult,
  BgToContentMessage,
  ContentToBgMessage,
} from '../types';

const logger = createLogger('Orchestrator');

// Per-tab recording state, persisted to storage.session so it survives a
// background suspension (Firefox MV3 background is non-persistent).
const session = new SessionState();

// Safety net: if a tab enters 'processing' (stop acknowledged) but the
// RECORDING_COMPLETE message never arrives, reset it so the UI can't stay stuck.
// Timers are not persisted; hydrate() re-arms them.
const PROCESSING_TIMEOUT_MS = 30_000;
const processingTimers = new Map<number, ReturnType<typeof setTimeout>>();

// Optional cap on recording length and storage use. Auto-stops via the normal
// STOP path, so it works uniformly across every capture strategy.
const maxDurationTimers = new Map<number, ReturnType<typeof setTimeout>>();
const ALARM_PREFIX = 'recording-deadline:';
const toggling = new Set<number>();
const saving = new Map<number, symbol>();
const attempts = new Map<number, symbol>();

export function getTabState(tabId: number): TabRecordingState {
  return session.state(tabId);
}

export function getTabError(tabId: number): string | undefined {
  return session.error(tabId);
}

export async function getTabProgress(
  tabId: number,
): Promise<{ savedDurationMs: number; savedBytes: number } | null> {
  const frame = session.activeFrame(tabId);
  const id = frame === undefined ? undefined : session.captureId(tabId, frame);
  if (!id) return null;
  const metadata = await getCaptureMetadata(id);
  return metadata ? { savedDurationMs: metadata.durationMs, savedBytes: metadata.sizeBytes } : null;
}

export function failTab(tabId: number, error: string): void {
  clearTab(tabId);
  session.setError(tabId, error);
}

export async function onRecordingError(
  tabId: number,
  frameId: number,
  error: string,
  captureId: string,
): Promise<void> {
  if (session.captureId(tabId, frameId) !== captureId) return;
  const activeFrame = session.activeFrame(tabId);
  if (activeFrame !== undefined && activeFrame !== frameId) return;
  const wasArmed = session.state(tabId) === 'armed';
  const captures = session.captureFrames(tabId);
  failTab(tabId, error);
  if (wasArmed) await broadcastDisarm(tabId, captures);
}

export function onFrameNavigated(tabId: number, frameId: number): void {
  if (frameId === 0 || session.activeFrame(tabId) === frameId) {
    clearTab(tabId);
  } else {
    session.clearStreamURL(tabId, frameId);
  }
}

/** Restore state after a background wake and re-arm watchdogs for stuck tabs. */
export async function hydrate(): Promise<void> {
  await session.hydrate();
  await recoverCaptures(session.captureIds()).catch((err: unknown) =>
    logger.error('Could not recover interrupted recordings', err),
  );
  for (const tabId of session.tabsInState('processing')) {
    armProcessingWatchdog(tabId);
  }
  for (const tabId of session.tabsInState('recording')) {
    const deadline = session.deadline(tabId);
    if (deadline !== undefined) armMaxDuration(tabId, (deadline - Date.now()) / 1000);
  }
}

export async function onDeadlineAlarm(name: string): Promise<void> {
  if (!name.startsWith(ALARM_PREFIX)) return;
  const tabId = Number(name.slice(ALARM_PREFIX.length));
  const deadline = session.deadline(tabId);
  if (deadline === undefined || deadline > Date.now()) return;
  if (session.state(tabId) === 'recording') await stopRecording(tabId);
  else if (session.state(tabId) === 'processing') {
    failTab(tabId, 'Timed out waiting for the recording to finish.');
  }
}

/** Drop all per-tab state and cancel any pending timers. */
export function clearTab(tabId: number): void {
  attempts.delete(tabId);
  for (const id of session.captureIds(tabId)) {
    void interruptCapture(id).catch((err: unknown) =>
      logger.error('Could not preserve interrupted capture', err),
    );
  }
  saving.delete(tabId);
  session.clear(tabId);
  clearProcessingWatchdog(tabId);
  clearMaxDuration(tabId);
  void browser.alarms.clear(`${ALARM_PREFIX}${tabId}`);
  updateBadge(tabId, 'idle');
}

function armMaxDuration(tabId: number, seconds: number): void {
  clearMaxDuration(tabId);
  const deadline = Date.now() + Math.max(0, seconds * 1000);
  session.setDeadline(tabId, deadline);
  void browser.alarms.create(`${ALARM_PREFIX}${tabId}`, { when: deadline });
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
  const deadline = session.deadline(tabId) ?? Date.now() + PROCESSING_TIMEOUT_MS;
  session.setDeadline(tabId, deadline);
  void browser.alarms.create(`${ALARM_PREFIX}${tabId}`, { when: deadline });
  const timer = setTimeout(
    () => {
      processingTimers.delete(tabId);
      if (session.state(tabId) === 'processing') {
        logger.warn('Processing watchdog fired for tab', tabId, '- resetting to idle');
        failTab(tabId, 'Timed out waiting for the recording to finish.');
      }
    },
    Math.max(0, deadline - Date.now()),
  );
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

type CaptureStart = Extract<
  BgToContentMessage,
  { type: 'START_CAPTURE' | 'START_NETWORK_CAPTURE' | 'START_WEBAUDIO_CAPTURE' | 'ARM_CAPTURE' }
>;

/** Allocate storage before the page starts producing audio, including armed frames. */
async function startInFrame(
  tabId: number,
  frameId: number,
  type: CaptureStart['type'],
  payload: { bitrate?: number; url?: string },
  attempt: symbol,
): Promise<ActionResult | undefined> {
  if (attempts.get(tabId) !== attempt)
    return { ok: false, error: 'Recording cancelled because the tab changed.' };
  const id = await beginCapture(tabId, frameId);
  if (attempts.get(tabId) !== attempt) {
    await discardCapture(id);
    return { ok: false, error: 'Recording cancelled because the tab changed.' };
  }
  session.setCapture(tabId, frameId, id);
  const result: ActionResult | undefined = await browser.tabs
    .sendMessage(tabId, { type, payload: { ...payload, captureId: id } }, { frameId })
    .catch(() => undefined);
  if (session.captureId(tabId, frameId) !== id) {
    await interruptCapture(id);
    return { ok: false, error: 'Recording session ended before capture started.' };
  }
  if (!result?.ok) {
    if (session.captureId(tabId, frameId) === id) session.clearCapture(tabId, frameId);
    await interruptCapture(id);
  }
  return result;
}

export async function receiveChunk(
  tabId: number,
  frameId: number,
  payload: Extract<ContentToBgMessage, { type: 'CAPTURE_CHUNK' }>['payload'],
): Promise<ActionResult> {
  if (session.captureId(tabId, frameId) !== payload.captureId) {
    return { ok: false, error: 'This recording session is no longer active.' };
  }
  return appendCapture(tabId, frameId, payload);
}

export async function startRecording(tabId: number): Promise<ActionResult> {
  if (session.state(tabId) === 'recording') {
    return { ok: false, error: 'Already recording this tab' };
  }
  if (session.state(tabId) !== 'idle') {
    return { ok: false, error: 'Tab is busy recording or finishing a recording' };
  }

  const attempt = Symbol();
  attempts.set(tabId, attempt);
  const settings = await getSettings();

  // --- Strategy 1: DOM element (captureStream) ---
  let mediaFrameId: number | null;
  try {
    mediaFrameId = await findFrameWithMedia(tabId);
  } catch {
    return { ok: false, error: 'Cannot communicate with page (try reloading the tab)' };
  }

  if (mediaFrameId !== null) {
    const result = await startInFrame(
      tabId,
      mediaFrameId,
      'START_CAPTURE',
      { bitrate: settings.bitrate },
      attempt,
    );

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
    const netResult = await startInFrame(
      tabId,
      stream.frameId,
      'START_NETWORK_CAPTURE',
      { url: stream.url },
      attempt,
    );

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
    const reply = await startInFrame(
      tabId,
      frameId,
      'START_WEBAUDIO_CAPTURE',
      { bitrate: settings.bitrate },
      attempt,
    );
    if (reply?.ok) {
      markRecording(tabId, frameId, settings.maxDurationSec);
      logger.info('Recording started (Web Audio) tab', tabId, 'frame', frameId);
      return { ok: true };
    }
  }

  // A real stream-capture failure (a source existed but failed) is surfaced as-is
  // and is NOT armable. Only a clean "nothing is playing" outcome is armable, so
  // the toggle can arm and wait for the next playback.
  if (attempts.get(tabId) !== attempt) {
    return { ok: false, error: 'Recording cancelled because the tab changed.' };
  }
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
  const captureId = frameId === undefined ? undefined : session.captureId(tabId, frameId);
  if (frameId === undefined || !captureId) {
    clearTab(tabId);
    return { ok: false, error: 'No active recording frame' };
  }

  session.setState(tabId, 'processing');
  clearMaxDuration(tabId);
  session.setDeadline(tabId, Date.now() + PROCESSING_TIMEOUT_MS);
  armProcessingWatchdog(tabId);

  const result: { ok: boolean; error?: string } | undefined = await browser.tabs
    .sendMessage(tabId, { type: 'STOP_CAPTURE', payload: { captureId } }, { frameId })
    .catch(() => undefined);

  if (!result?.ok) {
    if (session.captureId(tabId, frameId) === captureId)
      failTab(tabId, result?.error ?? 'Failed to stop capture');
    return { ok: false, error: result?.error ?? 'Failed to stop capture' };
  }

  // All chunks have committed; RECORDING_COMPLETE finalizes session metadata.
  return { ok: true };
}

async function broadcastDisarm(tabId: number, captures: [number, string][]): Promise<void> {
  for (const [frameId, captureId] of captures) {
    await browser.tabs
      .sendMessage(tabId, { type: 'DISARM_CAPTURE', payload: { captureId } }, { frameId })
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

  const attempt = Symbol();
  attempts.set(tabId, attempt);
  const settings = await getSettings();
  const frameIds = await listFrameIds(tabId);
  if (attempts.get(tabId) !== attempt)
    return { ok: false, error: 'Recording cancelled because the tab changed.' };
  session.setState(tabId, 'armed');
  updateBadge(tabId, 'armed');
  let delivered = 0;
  for (const frameId of frameIds) {
    if (session.state(tabId) !== 'armed') break;
    const reply = await startInFrame(
      tabId,
      frameId,
      'ARM_CAPTURE',
      { bitrate: settings.bitrate },
      attempt,
    );
    if (reply?.ok) delivered++;
  }

  if (delivered === 0) {
    if (session.state(tabId) === 'recording') return { ok: true };
    clearTab(tabId);
    return {
      ok: false,
      error: 'Cannot arm: no capturable frame on this page (try reloading the tab)',
    };
  }

  logger.info('Armed tab', tabId, 'across', delivered, 'frame(s)');
  return { ok: true };
}

/** Cancels a pending arm and returns the tab to idle. */
export async function disarmRecording(tabId: number): Promise<ActionResult> {
  if (session.state(tabId) !== 'armed') return { ok: false, error: 'Not armed' };
  const captures = session.captureFrames(tabId);
  clearTab(tabId);
  await broadcastDisarm(tabId, captures);
  logger.info('Disarmed tab', tabId);
  return { ok: true };
}

/**
 * Single entry point shared by the popup button and the hotkey:
 * recording -> stop, armed -> disarm, idle -> start now if audio is playing,
 * otherwise arm and wait for the next playback.
 */
export async function toggleRecording(tabId: number): Promise<ActionResult> {
  if (toggling.has(tabId)) return { ok: false, error: 'A recording action is already in progress' };
  toggling.add(tabId);
  try {
    return await toggleOnce(tabId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failTab(tabId, reason);
    return { ok: false, error: reason };
  } finally {
    toggling.delete(tabId);
  }
}

async function toggleOnce(tabId: number): Promise<ActionResult> {
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
export async function onArmedStarted(
  tabId: number,
  frameId: number,
  captureId: string,
): Promise<void> {
  if (session.captureId(tabId, frameId) !== captureId) return;
  if (session.state(tabId) !== 'armed') {
    session.clearCapture(tabId, frameId);
    await browser.tabs
      .sendMessage(tabId, { type: 'ABORT_CAPTURE', payload: { captureId } }, { frameId })
      .catch(() => undefined);
    await discardCapture(captureId);
    return;
  }

  // Claim the winning frame before yielding: two play events may arrive together.
  markRecording(tabId, frameId, 0);
  const settings = await getSettings();
  if (session.state(tabId) !== 'recording' || session.activeFrame(tabId) !== frameId) return;
  if (settings.maxDurationSec > 0) armMaxDuration(tabId, settings.maxDurationSec);
  logger.info('Armed capture started on tab', tabId, 'frame', frameId);

  const frameIds = await listFrameIds(tabId);
  for (const other of frameIds) {
    if (other === frameId) continue;
    if (session.captureId(tabId, frameId) !== captureId) return;
    const id = session.captureId(tabId, other);
    if (!id) continue;
    session.clearCapture(tabId, other);
    await browser.tabs
      .sendMessage(
        tabId,
        { type: 'DISARM_CAPTURE', payload: { captureId: id } },
        { frameId: other },
      )
      .catch(() => undefined);
    if (id) await discardCapture(id);
  }
}

/**
 * Persist a finished capture and release the tab. Delegates the storage/export
 * work to RecordingsService; this wrapper owns only the tab lifecycle -- it
 * cancels the processing watchdog up front and releases this save's tab state,
 * including on failure, unless navigation already invalidated its ownership.
 */
export async function saveRecording(
  tabId: number,
  frameId: number,
  result: CaptureResult,
): Promise<void> {
  if (
    session.captureId(tabId, frameId) !== result.captureId ||
    session.activeFrame(tabId) !== frameId
  )
    return;
  const saveToken = Symbol();
  saving.set(tabId, saveToken);
  clearProcessingWatchdog(tabId);
  clearMaxDuration(tabId);
  void browser.alarms.clear(`${ALARM_PREFIX}${tabId}`);
  session.setState(tabId, 'processing');
  session.clearDeadline(tabId);
  let failure: string | undefined;
  try {
    const saved = await saveCapture(tabId, frameId, result);
    if (!saved.ok) failure = saved.error ?? 'Failed to save recording';
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // A navigation may have released this tab and started another capture
    // while its previous recording was still being exported.
    if (saving.get(tabId) === saveToken) {
      clearTab(tabId);
      if (failure) session.setError(tabId, failure);
    }
  }
}
