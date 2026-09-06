import { IndexedDBRepository } from '../shared/Repository';
import { createLogger } from '../shared/Logger';
import { getSettings } from '../shared/Settings';
import { applyTemplate } from '../shared/FilenameTemplate';
import { encodeForExport } from '../shared/AudioEncoder';
import type {
  RecordingMetadata,
  Recording,
  CaptureResult,
  ActionResult,
  RecordingFilter,
  SortOptions,
} from '../types';

const logger = createLogger('RecordingsService');

// The IndexedDB layer is owned here, not leaked to the message router. Callers go
// through the functions below, so persistence stays a single concern.
const repository = new IndexedDBRepository();

export async function recoverCaptures(activeIds: string[]): Promise<void> {
  await repository.interruptAllExcept(activeIds);
}

export async function interruptCapture(id: string): Promise<void> {
  await repository.interrupt(id);
}

export async function discardCapture(id: string): Promise<void> {
  await repository.discard(id);
}

export async function appendCapture(
  tabId: number,
  frameId: number,
  payload: { captureId: string; sequence: number; blob: Blob; endedAt: number; startedAt: number },
): Promise<ActionResult> {
  try {
    await repository.append(
      payload.captureId,
      tabId,
      frameId,
      payload.sequence,
      payload.blob,
      payload.endedAt,
      payload.startedAt,
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `Could not save audio chunk: ${error instanceof Error ? error.message : String(error)}. Previously saved audio remains in Recordings.`,
    };
  }
}

// --- Query passthroughs used by the background message router ---

export function listRecordings(
  filter?: RecordingFilter,
  sort?: SortOptions,
): Promise<RecordingMetadata[]> {
  return repository.list(filter, sort);
}

export async function deleteRecording(id: string): Promise<void> {
  const metadata = await repository.getMetadataById(id);
  if (metadata?.status === 'recording') throw new Error('Stop the recording before deleting it.');
  await repository.deleteById(id);
}

export async function getBlob(id: string): Promise<Blob | null> {
  const metadata = await repository.getMetadataById(id);
  if (metadata?.status === 'recording') throw new Error('Stop the recording before playing it.');
  return repository.getBlobById(id);
}

export function getCaptureMetadata(id: string): Promise<RecordingMetadata | null> {
  return repository.getMetadataById(id);
}

/** Allocate the recording before capture; the first chunk sets its actual start time. */
export async function beginCapture(tabId: number, frameId: number): Promise<string> {
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
    id: `rec_${crypto.randomUUID()}`,
    sourceUrl: url,
    sourceHost: host,
    sourceTitle: title,
    mimeType: '',
    durationMs: 0,
    sizeBytes: 0,
    startedAt: Date.now(),
    endedAt: Date.now(),
    status: 'recording',
    nextSequence: 0,
    ownerTabId: tabId,
    ownerFrameId: frameId,
  };
  await repository.begin(metadata);
  return metadata.id;
}

/** Commit completion without assembling or decoding the saved audio. */
export async function saveCapture(
  tabId: number,
  frameId: number,
  result: CaptureResult,
): Promise<ActionResult> {
  try {
    await repository.finalize(result.captureId, tabId, frameId, result.chunkCount, result.endedAt);
    logger.info('Saved recording', result.captureId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const error = `Could not finish recording: ${msg}. Previously saved audio remains in Recordings.`;
    logger.error(error);
    return { ok: false, error };
  }

  try {
    const settings = await getSettings();

    if (settings.autoExport) {
      const exportResult = await exportRecordingById(result.captureId);
      if (!exportResult.ok) {
        return {
          ok: false,
          error: `Recording saved in Recordings, but auto-export failed: ${exportResult.error}`,
        };
      }
    }

    if (settings.maxRecordings > 0) {
      await pruneOldRecordings(settings.maxRecordings);
    }
  } catch (err) {
    logger.error('Recording saved, but post-save processing failed:', err);
  }
  return { ok: true };
}

/**
 * Exports original bytes or converts to WAV/MP3, then waits for the browser to
 * confirm the file download. Persisted recordings remain available on failure.
 */
export async function exportRecording(recording: Recording): Promise<ActionResult> {
  const settings = await getSettings();
  const format = recording.metadata.status === 'interrupted' ? 'original' : settings.exportFormat;

  let encoded;
  try {
    encoded = await encodeForExport(recording.blob, format, {
      mp3Kbps: Math.round(settings.bitrate / 1000),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Encoding failed:', error);
    return {
      ok: false,
      error: `Could not export ${format.toUpperCase()}: ${error}`,
    };
  }

  const filename = applyTemplate(settings.filenameTemplate, recording.metadata, encoded.extension);
  const path = settings.exportSubfolder.trim()
    ? `${settings.exportSubfolder.trim()}/${filename}`
    : filename;

  const url = URL.createObjectURL(encoded.blob);
  let downloadId: number | undefined;
  const earlyCompletions = new Map<number, ActionResult>();
  type DownloadDelta = Parameters<Parameters<typeof browser.downloads.onChanged.addListener>[0]>[0];
  let settle!: (result: ActionResult) => void;
  const completed = new Promise<ActionResult>((resolve) => {
    settle = resolve;
  });
  const cleanup = (): void => {
    URL.revokeObjectURL(url);
    browser.downloads.onChanged.removeListener(onChanged);
    browser.runtime.onSuspend.removeListener(onSuspend);
  };
  const onChanged = (delta: DownloadDelta): void => {
    const state = delta.state?.current;
    if (state !== 'complete' && state !== 'interrupted') return;
    const result: ActionResult =
      state === 'complete'
        ? { ok: true }
        : {
            ok: false,
            error: `Download interrupted: ${delta.error?.current ?? 'cancelled or failed'}. The recording remains saved in Recordings.`,
          };
    if (downloadId === undefined) earlyCompletions.set(delta.id, result);
    else if (delta.id === downloadId) settle(result);
  };
  const onSuspend = (): void => {
    settle({
      ok: false,
      error:
        'Download completion could not be confirmed. Check Firefox Downloads; the recording remains saved in Recordings.',
    });
  };
  browser.downloads.onChanged.addListener(onChanged);
  browser.runtime.onSuspend.addListener(onSuspend);

  try {
    downloadId = await browser.downloads.download({
      url,
      filename: path,
      conflictAction: 'uniquify',
      saveAs: false,
    });

    if (downloadId == null) {
      return { ok: false, error: 'Download did not start' };
    }

    const earlyResult = earlyCompletions.get(downloadId);
    if (earlyResult) settle(earlyResult);
    earlyCompletions.clear();

    const result = await completed;
    if (result.ok) logger.info('Download completed', recording.metadata.id, '->', path);
    else logger.warn('Download failed', recording.metadata.id, result.error);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Export failed:', error);
    return { ok: false, error: `${error}. The recording remains saved in Recordings.` };
  } finally {
    cleanup();
  }
}

export async function exportRecordingById(id: string): Promise<ActionResult> {
  const metadata = await repository.getMetadataById(id);
  if (metadata?.status === 'recording')
    return { ok: false, error: 'Stop the recording before exporting it.' };
  const recording = await repository.getById(id);
  if (!recording) return { ok: false, error: 'Recording not found' };
  return exportRecording(recording);
}

async function pruneOldRecordings(maxKeep: number): Promise<void> {
  const all = await repository.list(undefined, { field: 'startedAt', direction: 'asc' });
  const completed = all.filter(
    (recording) => recording.status === undefined || recording.status === 'complete',
  );
  const excess = completed.length - maxKeep;
  if (excess <= 0) return;
  const toDelete = completed.slice(0, excess);
  logger.info(`Cleanup: deleting ${excess} oldest recordings (cap = ${maxKeep})`);
  await Promise.all(toDelete.map((m) => repository.deleteById(m.id)));
}
