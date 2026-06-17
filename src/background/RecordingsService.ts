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

function generateId(): string {
  return `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Query passthroughs used by the background message router ---

export function listRecordings(
  filter?: RecordingFilter,
  sort?: SortOptions,
): Promise<RecordingMetadata[]> {
  return repository.list(filter, sort);
}

export function deleteRecording(id: string): Promise<void> {
  return repository.deleteById(id);
}

export function getBlob(id: string): Promise<Blob | null> {
  return repository.getBlobById(id);
}

/**
 * Persist a finished capture: build metadata from the tab, write it to
 * IndexedDB, then honor the auto-export and retention-cap settings. Tab
 * lifecycle (watchdogs, releasing the tab) is the caller's concern; this never
 * throws -- a storage failure is logged so the caller can always release the tab.
 */
export async function saveCapture(tabId: number, result: CaptureResult): Promise<void> {
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

  try {
    await repository.save(recording);
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
  } catch (err) {
    const quota = err instanceof DOMException && err.name === 'QuotaExceededError';
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      quota
        ? `Save failed: storage quota exceeded (${(metadata.sizeBytes / 1024 / 1024).toFixed(1)} MB). Delete old recordings or lower the bitrate.`
        : `Save failed for tab ${tabId}: ${msg}`,
    );
  }
}

/**
 * Decodes the recording, re-encodes it to the user's chosen export format
 * (WAV/MP3), and triggers a browser download using the template and subfolder
 * settings. The object URL is revoked once the download reaches a terminal
 * state.
 */
export async function exportRecording(recording: Recording): Promise<ActionResult> {
  const settings = await getSettings();

  let encoded;
  try {
    encoded = await encodeForExport(recording.blob, settings.exportFormat, {
      mp3Kbps: Math.round(settings.bitrate / 1000),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Encoding failed:', error);
    return {
      ok: false,
      error: `Could not encode to ${settings.exportFormat.toUpperCase()}: ${error}`,
    };
  }

  const filename = applyTemplate(settings.filenameTemplate, recording.metadata, encoded.extension);
  const path = settings.exportSubfolder.trim()
    ? `${settings.exportSubfolder.trim()}/${filename}`
    : filename;

  const url = URL.createObjectURL(encoded.blob);

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

    type DownloadDelta = Parameters<
      Parameters<typeof browser.downloads.onChanged.addListener>[0]
    >[0];
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
