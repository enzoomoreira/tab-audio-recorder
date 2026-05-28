import { IndexedDBRepository } from '../shared/Repository';
import { createLogger } from '../shared/Logger';
import type { TabRecordingState, RecordingMetadata, CaptureResult, ActionResult } from '../types';

const logger = createLogger('Orchestrator');

export const repository = new IndexedDBRepository();

const tabStates = new Map<number, TabRecordingState>();

// URLs of media streams detected via webRequest, keyed by tabId.
// Populated by onMediaURLDetected() called from the webRequest listener in index.ts.
const tabStreamURLs = new Map<number, string>();

function generateId(): string {
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getTabState(tabId: number): TabRecordingState {
  return tabStates.get(tabId) ?? 'idle';
}

export function onTabRemoved(tabId: number): void {
  tabStates.delete(tabId);
  tabStreamURLs.delete(tabId);
}

export function onMediaURLDetected(tabId: number, url: string): void {
  tabStreamURLs.set(tabId, url);
  logger.debug('Stream URL cached for tab', tabId, url);
}

export async function startRecording(tabId: number): Promise<ActionResult> {
  if (tabStates.get(tabId) === 'recording') {
    return { ok: false, error: 'Already recording this tab' };
  }

  // --- Strategy 1: DOM element (captureStream) ---
  let checkResult: { found: boolean } | undefined;
  try {
    checkResult = await browser.tabs.sendMessage(tabId, { type: 'CHECK_MEDIA' });
  } catch {
    return { ok: false, error: 'Cannot communicate with page (try reloading the tab)' };
  }

  if (checkResult?.found) {
    const result: { ok: boolean; error?: string } | undefined = await browser.tabs
      .sendMessage(tabId, { type: 'START_CAPTURE' })
      .catch(() => undefined);

    if (result?.ok) {
      tabStates.set(tabId, 'recording');
      logger.info('Recording started (DOM) on tab', tabId);
      return { ok: true };
    }

    if (result && !result.ok) {
      return { ok: false, error: result.error ?? 'Failed to start DOM capture' };
    }
  }

  // --- Strategy 2: Network stream (fetch) ---
  const streamURL = tabStreamURLs.get(tabId);
  if (!streamURL) {
    return {
      ok: false,
      error:
        'No audio element found and no stream detected yet. ' +
        'Make sure audio is playing before clicking Record.',
    };
  }

  const netResult: { ok: boolean; error?: string } | undefined = await browser.tabs
    .sendMessage(tabId, { type: 'START_NETWORK_CAPTURE', payload: { url: streamURL } })
    .catch(() => undefined);

  if (netResult?.ok) {
    tabStates.set(tabId, 'recording');
    logger.info('Recording started (network fetch) on tab', tabId, 'url:', streamURL);
    return { ok: true };
  }

  return {
    ok: false,
    error: netResult?.error ?? 'Failed to start network capture',
  };
}

export async function stopRecording(tabId: number): Promise<ActionResult> {
  if (tabStates.get(tabId) !== 'recording') {
    return { ok: false, error: 'Not recording this tab' };
  }

  tabStates.set(tabId, 'processing');

  const result: { ok: boolean; error?: string } | undefined = await browser.tabs
    .sendMessage(tabId, { type: 'STOP_CAPTURE' })
    .catch(() => undefined);

  if (!result?.ok) {
    tabStates.delete(tabId);
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

  await repository.save({ metadata, blob: result.blob });
  tabStates.delete(tabId);
  logger.info('Saved recording', metadata.id, 'from', host);
}
