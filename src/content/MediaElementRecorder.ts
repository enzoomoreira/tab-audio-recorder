import { createLogger } from '../shared/Logger';
import type { IRecorder, CaptureResult } from '../types';

const logger = createLogger('MediaElementRecorder');

const TAG = 'tab-audio-recorder';
const TAG_PAGE = 'tab-audio-recorder-page';

function postToPage(payload: Record<string, unknown>): void {
  window.postMessage({ source: TAG, ...payload }, window.location.origin);
}

function waitForReply<T>(type: string, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error(`Page hook did not respond within ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data as { source?: string; type?: string } | null;
      if (!data || data.source !== TAG_PAGE || data.type !== type) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(data as unknown as T);
    };

    window.addEventListener('message', handler);
  });
}

// ISOLATED-world driver for the MAIN-world MediaElementHook. The element (which
// may be detached from the DOM) lives in the page world and is unreachable from
// here, so detection and capture both happen in the hook; this class just speaks
// the postMessage protocol.
export class MediaElementRecorder implements IRecorder {
  private recording = false;
  private errorListener: ((event: MessageEvent) => void) | null = null;

  // Invoked if the page-world recorder errors spontaneously mid-capture.
  onError: ((reason: string) => void) | null = null;

  private installErrorListener(): void {
    const handler = (event: MessageEvent): void => {
      if (event.source !== window) return;
      const data = event.data as { source?: string; type?: string; error?: string } | null;
      if (!data || data.source !== TAG_PAGE || data.type !== 'EL_ERROR') return;
      this.recording = false;
      this.removeErrorListener();
      this.onError?.(data.error ?? 'Media element capture error');
    };
    this.errorListener = handler;
    window.addEventListener('message', handler);
  }

  private removeErrorListener(): void {
    if (this.errorListener) {
      window.removeEventListener('message', this.errorListener);
      this.errorListener = null;
    }
  }

  /** Whether the page has played any media element we could capture. */
  async probe(): Promise<boolean> {
    postToPage({ type: 'EL_PROBE' });
    try {
      const reply = await waitForReply<{ found: boolean }>('EL_PROBE_RESULT', 1000);
      return reply.found;
    } catch {
      return false;
    }
  }

  async start(bitrate: number): Promise<void> {
    postToPage({ type: 'EL_START', bitrate });
    const reply = await waitForReply<{ ok: boolean; error?: string }>('EL_STARTED');
    if (!reply.ok) throw new Error(reply.error ?? 'Failed to start media element capture');
    this.recording = true;
    this.installErrorListener();
    logger.info('Media element capture started, bitrate:', bitrate);
  }

  async stop(): Promise<CaptureResult> {
    if (!this.recording) throw new Error('Not recording');
    postToPage({ type: 'EL_STOP' });
    type StopReply =
      | {
          ok: true;
          blob: Blob;
          mimeType: string;
          durationMs: number;
          startedAt: number;
          endedAt: number;
        }
      | { ok: false; error: string };
    const reply = await waitForReply<StopReply>('EL_STOPPED');
    this.recording = false;
    this.removeErrorListener();
    if (!reply.ok) throw new Error(reply.error);
    logger.info('Media element capture stopped, blob:', reply.blob.size, 'bytes');
    return {
      blob: reply.blob,
      mimeType: reply.mimeType,
      durationMs: reply.durationMs,
      startedAt: reply.startedAt,
      endedAt: reply.endedAt,
    };
  }

  isRecording(): boolean {
    return this.recording;
  }
}
