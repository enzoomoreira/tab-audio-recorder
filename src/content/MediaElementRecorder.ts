import { ChunkSink } from './ChunkSink';
import { createLogger } from '../shared/Logger';
import { onPageMessage, postToPage, waitForReply } from './pageBridge';
import type { IRecorder, CaptureResult } from '../types';

const logger = createLogger('MediaElementRecorder');

// ISOLATED-world driver for the MAIN-world MediaElementHook. The element (which
// may be detached from the DOM) lives in the page world and is unreachable from
// here, so detection and capture both happen in the hook; this class just speaks
// the postMessage protocol (see pageBridge.ts).
export class MediaElementRecorder implements IRecorder {
  private recording = false;
  private sink: ChunkSink | null = null;
  private disposeErrorListener: (() => void) | null = null;
  private disposeArmListener: (() => void) | null = null;

  // Invoked if the page-world recorder errors spontaneously mid-capture.
  onError: ((reason: string) => void) | null = null;
  // Invoked when an armed capture auto-starts (the played element triggered it)
  // or when that auto-start failed (e.g. DRM content).
  onArmFired: (() => void) | null = null;
  onArmFailed: ((reason: string) => void) | null = null;

  private installErrorListener(): void {
    this.disposeErrorListener = onPageMessage<{ error?: string; captureId: string }>(
      'EL_ERROR',
      (data) => {
        if (data.captureId !== this.sink?.captureId) return;
        this.recording = false;
        this.sink?.dispose();
        this.sink = null;
        this.removeErrorListener();
        this.onError?.(data.error ?? 'Media element capture error');
      },
    );
  }

  private removeErrorListener(): void {
    this.disposeErrorListener?.();
    this.disposeErrorListener = null;
  }

  // Listens for the spontaneous EL_ARM_FIRED the hook sends when an armed
  // element plays. On success the recorder transitions to recording (and an
  // error listener is installed, mirroring start()); on failure it reports back.
  private installArmListener(): void {
    this.disposeArmListener = onPageMessage<{ ok?: boolean; error?: string; captureId: string }>(
      'EL_ARM_FIRED',
      (data) => {
        if (data.captureId !== this.sink?.captureId) return;
        this.removeArmListener();
        if (data.ok) {
          this.recording = true;
          this.installErrorListener();
          this.onArmFired?.();
        } else {
          this.sink?.dispose();
          this.sink = null;
          this.onArmFailed?.(data.error ?? 'Armed capture failed');
        }
      },
    );
  }

  private removeArmListener(): void {
    this.disposeArmListener?.();
    this.disposeArmListener = null;
  }

  /** What the page has played: any capturable element, and whether one is playing now. */
  async probe(): Promise<{ found: boolean; playing: boolean }> {
    postToPage({ type: 'EL_PROBE' });
    try {
      const reply = await waitForReply<{ found: boolean; playing: boolean }>(
        'EL_PROBE_RESULT',
        1000,
      );
      return { found: reply.found, playing: reply.playing };
    } catch {
      return { found: false, playing: false };
    }
  }

  /** Arm the hook to auto-capture the next media element that plays. */
  arm(bitrate: number, captureId: string): void {
    this.sink?.dispose();
    this.sink = new ChunkSink(captureId);
    this.sink.listen('EL_');
    this.installArmListener();
    postToPage({ type: 'EL_ARM', bitrate, captureId });
    logger.info('Media element capture armed, bitrate:', bitrate);
  }

  /** Cancel a pending arm (no element has played yet). */
  disarm(): void {
    const pending = this.disposeArmListener !== null;
    const captureId = this.sink?.captureId;
    this.removeArmListener();
    if (pending) {
      this.sink?.dispose();
      this.sink = null;
    }
    postToPage({ type: pending ? 'EL_ABORT' : 'EL_DISARM', captureId });
    logger.info('Media element capture disarmed');
  }

  /** Discard an in-flight capture without producing a recording (multi-frame race). */
  abort(): void {
    const captureId = this.sink?.captureId;
    this.recording = false;
    this.sink?.dispose();
    this.sink = null;
    this.removeArmListener();
    this.removeErrorListener();
    postToPage({ type: 'EL_ABORT', captureId });
    logger.info('Media element capture aborted');
  }

  async start(bitrate: number, captureId: string): Promise<void> {
    this.sink?.dispose();
    this.sink = new ChunkSink(captureId);
    this.sink.listen('EL_');
    postToPage({ type: 'EL_START', bitrate, captureId });
    try {
      const reply = await waitForReply<{ ok: boolean; error?: string }>(
        'EL_STARTED',
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
    logger.info('Media element capture started, bitrate:', bitrate);
  }

  async stop(): Promise<CaptureResult> {
    if (!this.recording) throw new Error('Not recording');
    postToPage({ type: 'EL_STOP', captureId: this.sink?.captureId });
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
      reply = await waitForReply<StopReply>('EL_STOPPED', 10_000, this.sink?.captureId);
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
