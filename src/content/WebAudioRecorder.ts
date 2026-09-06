import { ChunkSink } from './ChunkSink';
import { createLogger } from '../shared/Logger';
import { onPageMessage, postToPage, waitForReply } from './pageBridge';
import type { IRecorder, CaptureResult } from '../types';

const logger = createLogger('WebAudioRecorder');

export class WebAudioRecorder implements IRecorder {
  private recording = false;
  private sink: ChunkSink | null = null;
  private disposeErrorListener: (() => void) | null = null;

  // Invoked if the page-world recorder errors spontaneously mid-capture.
  onError: ((reason: string) => void) | null = null;

  private installErrorListener(): void {
    this.disposeErrorListener = onPageMessage<{ error?: string; captureId: string }>(
      'ERROR',
      (data) => {
        if (data.captureId !== this.sink?.captureId) return;
        this.recording = false;
        this.sink?.dispose();
        this.sink = null;
        this.removeErrorListener();
        this.onError?.(data.error ?? 'Web Audio capture error');
      },
    );
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

  async start(bitrate: number, captureId: string): Promise<void> {
    this.sink?.dispose();
    this.sink = new ChunkSink(captureId);
    this.sink.listen('');
    postToPage({ type: 'START', bitrate, captureId });
    try {
      const reply = await waitForReply<{ ok: boolean; error?: string }>(
        'STARTED',
        10_000,
        captureId,
      );
      if (!reply.ok) throw new Error(reply.error ?? 'Failed to start capture');
    } catch (error) {
      this.abort();
      throw error;
    }
    this.recording = true;
    this.installErrorListener();
    logger.info('Web Audio capture started, bitrate:', bitrate);
  }

  abort(): void {
    const captureId = this.sink?.captureId;
    this.recording = false;
    this.sink?.dispose();
    this.sink = null;
    this.removeErrorListener();
    postToPage({ type: 'ABORT', captureId });
  }

  async stop(): Promise<CaptureResult> {
    if (!this.recording) throw new Error('Not recording');
    postToPage({ type: 'STOP', captureId: this.sink?.captureId });
    type StopReply =
      | {
          ok: true;
          captureId: string;
          chunkCount: number;
          mimeType: string;
          durationMs: number;
          startedAt: number;
          endedAt: number;
        }
      | { ok: false; error: string };
    let reply: StopReply;
    try {
      reply = await waitForReply<StopReply>('STOPPED', 10_000, this.sink?.captureId);
    } catch (error) {
      this.abort();
      throw error;
    } finally {
      this.recording = false;
      this.removeErrorListener();
    }
    if (!reply.ok) {
      this.abort();
      throw new Error(reply.error);
    }
    try {
      if (!this.sink || reply.captureId !== this.sink.captureId)
        throw new Error('Capture session mismatch');
      await this.sink.drain(reply.chunkCount);
    } finally {
      this.sink?.dispose();
      this.sink = null;
    }
    logger.info('Capture stopped, chunks:', reply.chunkCount);
    return {
      captureId: reply.captureId,
      chunkCount: reply.chunkCount,
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
