import { createLogger } from '../shared/Logger';
import { onPageMessage, postToPage, waitForReply } from './pageBridge';
import type { IRecorder, CaptureResult } from '../types';

const logger = createLogger('WebAudioRecorder');

export class WebAudioRecorder implements IRecorder {
  private recording = false;
  private disposeErrorListener: (() => void) | null = null;

  // Invoked if the page-world recorder errors spontaneously mid-capture.
  onError: ((reason: string) => void) | null = null;

  private installErrorListener(): void {
    this.disposeErrorListener = onPageMessage<{ error?: string }>('ERROR', (data) => {
      this.recording = false;
      this.removeErrorListener();
      this.onError?.(data.error ?? 'Web Audio capture error');
    });
  }

  private removeErrorListener(): void {
    this.disposeErrorListener?.();
    this.disposeErrorListener = null;
  }

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
    this.installErrorListener();
    logger.info('Web Audio capture started, bitrate:', bitrate);
  }

  async stop(): Promise<CaptureResult> {
    if (!this.recording) throw new Error('Not recording');
    postToPage({ type: 'STOP' });
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
    const reply = await waitForReply<StopReply>('STOPPED');
    this.recording = false;
    this.removeErrorListener();
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
