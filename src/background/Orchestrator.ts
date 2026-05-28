import { IndexedDBRepository } from '../shared/Repository';
import { createLogger } from '../shared/Logger';
import { getSettings } from '../shared/Settings';
import { applyTemplate } from '../shared/FilenameTemplate';
import type {
  TabRecordingState,
  RecordingMetadata,
  Recording,
  CaptureResult,
  ActionResult,
} from '../types';

const logger = createLogger('Orchestrator');

export const repository = new IndexedDBRepository();

const tabStates = new Map<number, TabRecordingState>();

// One recording per tab, but the active source can be in any frame (top or iframe).
// activeFrames tracks which frameId is currently recording so STOP routes correctly.
const activeFrames = new Map<number, number>();

// Network stream URLs are keyed per-frame because the iframe that initiated the
// audio request is the one that must fetch the stream.
const tabStreamURLs = new Map<number, Map<number, string>>();

function generateId(): string {
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getTabState(tabId: number): TabRecordingState {
  return tabStates.get(tabId) ?? 'idle';
}

export function onTabRemoved(tabId: number): void {
  tabStates.delete(tabId);
  activeFrames.delete(tabId);
  tabStreamURLs.delete(tabId);
}

export function onMediaURLDetected(tabId: number, frameId: number, url: string): void {
  let perFrame = tabStreamURLs.get(tabId);
  if (!perFrame) {
    perFrame = new Map<number, string>();
    tabStreamURLs.set(tabId, perFrame);
  }
  perFrame.set(frameId, url);
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

async function findFrameWithMedia(tabId: number): Promise<number | null> {
  const frameIds = await listFrameIds(tabId);
  for (const frameId of frameIds) {
    try {
      const reply: { found: boolean } | undefined = await browser.tabs.sendMessage(
        tabId,
        { type: 'CHECK_MEDIA' },
        { frameId },
      );
      if (reply?.found) return frameId;
    } catch {
      // Frame may not have our content script (chrome://, about:, etc.).
    }
  }
  return null;
}

function findFrameWithStreamURL(tabId: number): { frameId: number; url: string } | null {
  const perFrame = tabStreamURLs.get(tabId);
  if (!perFrame) return null;
  // Prefer top frame (frameId 0) if it has a stream; else first available.
  const sorted = [...perFrame.entries()].sort(([a], [b]) => a - b);
  const first = sorted[0];
  return first ? { frameId: first[0], url: first[1] } : null;
}

export async function startRecording(tabId: number): Promise<ActionResult> {
  if (tabStates.get(tabId) === 'recording') {
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
      tabStates.set(tabId, 'recording');
      activeFrames.set(tabId, mediaFrameId);
      logger.info('Recording started (DOM) tab', tabId, 'frame', mediaFrameId, 'bitrate:', settings.bitrate);
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
      tabStates.set(tabId, 'recording');
      activeFrames.set(tabId, stream.frameId);
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
      tabStates.set(tabId, 'recording');
      activeFrames.set(tabId, frameId);
      logger.info('Recording started (Web Audio) tab', tabId, 'frame', frameId);
      return { ok: true };
    }
  }

  return {
    ok: false,
    error:
      strategy2Error ??
      'No audio source detected (no media element, no stream URL, no AudioContext). ' +
        'Make sure audio is playing before clicking Record.',
  };
}

export async function stopRecording(tabId: number): Promise<ActionResult> {
  if (tabStates.get(tabId) !== 'recording') {
    return { ok: false, error: 'Not recording this tab' };
  }

  const frameId = activeFrames.get(tabId);
  if (frameId === undefined) {
    tabStates.delete(tabId);
    return { ok: false, error: 'No active recording frame' };
  }

  tabStates.set(tabId, 'processing');

  const result: { ok: boolean; error?: string } | undefined = await browser.tabs
    .sendMessage(tabId, { type: 'STOP_CAPTURE' }, { frameId })
    .catch(() => undefined);

  if (!result?.ok) {
    tabStates.delete(tabId);
    activeFrames.delete(tabId);
    return { ok: false, error: result?.error ?? 'Failed to stop capture' };
  }

  return { ok: true };
}

export async function saveRecording(tabId: number, result: CaptureResult): Promise<void> {
  let url = 'unknown';
  let title = 'Unknown';
  let host = 'unknown';

  try {
    const tab = await browser.tabs.get(tabId);
    url = tab.url ?? 'unknown';
    title = tab.title ?? 'Unknown';
    host = new URL(url).hostname;
  } catch {
    logger.warn('Could not read tab metadata for', tabId);
  }

  const metadata: RecordingMetadata = {
    id: generateId(),
    sourceUrl: url,
    sourceHost: host,
    sourceTitle: title,
    mimeType: result.mimeType,
    durationMs: result.durationMs,
    sizeBytes: result.blob.size,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
  };

  const recording: Recording = { metadata, blob: result.blob };
  await repository.save(recording);
  tabStates.delete(tabId);
  activeFrames.delete(tabId);
  logger.info('Saved recording', metadata.id, 'from', host);

  const settings = await getSettings();

  if (settings.autoExport) {
    const exportResult = await exportRecording(recording);
    if (!exportResult.ok) {
      logger.warn('Auto-export failed for', metadata.id, ':', exportResult.error);
    }
  }

  if (settings.maxRecordings > 0) {
    await pruneOldRecordings(settings.maxRecordings);
  }
}

/**
 * Triggers a browser download of the recording using the user's template
 * and subfolder settings. The object URL is revoked once the download
 * reaches a terminal state.
 */
export async function exportRecording(recording: Recording): Promise<ActionResult> {
  const settings = await getSettings();
  const filename = applyTemplate(settings.filenameTemplate, recording.metadata);
  const path = settings.exportSubfolder.trim()
    ? `${settings.exportSubfolder.trim()}/${filename}`
    : filename;

  const url = URL.createObjectURL(recording.blob);

  try {
    const downloadId = await browser.downloads.download({
      url,
      filename: path,
      conflictAction: 'uniquify',
      saveAs: false,
    });

    if (downloadId == null) {
      URL.revokeObjectURL(url);
      return { ok: false, error: 'Download did not start' };
    }

    type DownloadDelta = Parameters<Parameters<typeof browser.downloads.onChanged.addListener>[0]>[0];
    const onChanged = (delta: DownloadDelta): void => {
      if (delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === 'complete' || state === 'interrupted') {
        URL.revokeObjectURL(url);
        browser.downloads.onChanged.removeListener(onChanged);
      }
    };
    browser.downloads.onChanged.addListener(onChanged);

    logger.info('Export queued', recording.metadata.id, '->', path);
    return { ok: true };
  } catch (err) {
    URL.revokeObjectURL(url);
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Export failed:', error);
    return { ok: false, error };
  }
}

export async function exportRecordingById(id: string): Promise<ActionResult> {
  const recording = await repository.getById(id);
  if (!recording) return { ok: false, error: 'Recording not found' };
  return exportRecording(recording);
}

async function pruneOldRecordings(maxKeep: number): Promise<void> {
  const all = await repository.list(undefined, { field: 'startedAt', direction: 'asc' });
  const excess = all.length - maxKeep;
  if (excess <= 0) return;
  const toDelete = all.slice(0, excess);
  logger.info(`Cleanup: deleting ${excess} oldest recordings (cap = ${maxKeep})`);
  await Promise.all(toDelete.map((m) => repository.deleteById(m.id)));
}
