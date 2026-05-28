import { IndexedDBRepository } from '../shared/Repository';
import { createLogger } from '../shared/Logger';
import type { TabRecordingState, RecordingMetadata, CaptureResult, ActionResult } from '../types';

const logger = createLogger('Orchestrator');

export const repository = new IndexedDBRepository();

const tabStates = new Map<number, TabRecordingState>();

function generateId(): string {
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getTabState(tabId: number): TabRecordingState {
  return tabStates.get(tabId) ?? 'idle';
}

export function onTabRemoved(tabId: number): void {
  tabStates.delete(tabId);
}

export async function startRecording(tabId: number): Promise<ActionResult> {
  if (tabStates.get(tabId) === 'recording') {
    return { ok: false, error: 'Already recording this tab' };
  }

  let checkResult: { found: boolean } | undefined;
  try {
    checkResult = await browser.tabs.sendMessage(tabId, { type: 'CHECK_MEDIA' });
  } catch {
    return { ok: false, error: 'Cannot communicate with page (try reloading the tab)' };
  }

  if (!checkResult?.found) {
    return { ok: false, error: 'No audio or video element found on this page' };
  }

  let startResult: { ok: boolean; error?: string } | undefined;
  try {
    startResult = await browser.tabs.sendMessage(tabId, { type: 'START_CAPTURE' });
  } catch {
    return { ok: false, error: 'Failed to start capture' };
  }

  if (!startResult?.ok) {
    return { ok: false, error: startResult?.error ?? 'Failed to start capture' };
  }

  tabStates.set(tabId, 'recording');
  logger.info('Recording started on tab', tabId);
  return { ok: true };
}

export async function stopRecording(tabId: number): Promise<ActionResult> {
  if (tabStates.get(tabId) !== 'recording') {
    return { ok: false, error: 'Not recording this tab' };
  }

  tabStates.set(tabId, 'processing');

  let stopResult: { ok: boolean; error?: string } | undefined;
  try {
    stopResult = await browser.tabs.sendMessage(tabId, { type: 'STOP_CAPTURE' });
  } catch {
    tabStates.delete(tabId);
    return { ok: false, error: 'Failed to communicate with page' };
  }

  if (!stopResult?.ok) {
    tabStates.delete(tabId);
    return { ok: false, error: stopResult?.error ?? 'Failed to stop capture' };
  }

  // State transitions to 'idle' once RECORDING_COMPLETE arrives from content script
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
