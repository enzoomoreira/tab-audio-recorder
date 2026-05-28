import { createLogger } from '../shared/Logger';
import type { IRecorder, CaptureResult } from '../types';

const logger = createLogger('WebAudioRecorder');

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

export class WebAudioRecorder implements IRecorder {
  private recording = false;

  async probe(): Promise<boolean> {
    postToPage({ type: 'PROBE' });
    try {
      const reply = await waitForReply<{ hasContexts: boolean }>('PROBE_RESULT', 1000);
      return reply.hasContexts;
    } catch {
      return false;
    }
  }

  async start(bitrate: number): Promise<void> {
    postToPage({ type: 'START', bitrate });
    const reply = await waitForReply<{ ok: boolean; error?: string }>('STARTED');
    if (!reply.ok) throw new Error(reply.error ?? 'Failed to start Web Audio capture');
    this.recording = true;
    logger.info('Web Audio capture started, bitrate:', bitrate);
  }

  async stop(): Promise<CaptureResult> {
    if (!this.recording) throw new Error('Not recording');
    postToPage({ type: 'STOP' });
    type StopReply =
      | { ok: true; blob: Blob; mimeType: string; durationMs: number; startedAt: number; endedAt: number }
      | { ok: false; error: string };
    const reply = await waitForReply<StopReply>('STOPPED');
    this.recording = false;
    if (!reply.ok) throw new Error(reply.error);
    logger.info('Web Audio capture stopped, blob:', reply.blob.size, 'bytes');
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
