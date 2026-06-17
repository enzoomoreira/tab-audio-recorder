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
  private disposeErrorListener: (() => void) | null = null;
  private disposeArmListener: (() => void) | null = null;

  // Invoked if the page-world recorder errors spontaneously mid-capture.
  onError: ((reason: string) => void) | null = null;
  // Invoked when an armed capture auto-starts (the played element triggered it)
  // or when that auto-start failed (e.g. DRM content).
  onArmFired: (() => void) | null = null;
  onArmFailed: ((reason: string) => void) | null = null;

  private installErrorListener(): void {
    this.disposeErrorListener = onPageMessage<{ error?: string }>('EL_ERROR', (data) => {
      this.recording = false;
      this.removeErrorListener();
      this.onError?.(data.error ?? 'Media element capture error');
    });
  }

  private removeErrorListener(): void {
    this.disposeErrorListener?.();
    this.disposeErrorListener = null;
  }

  // Listens for the spontaneous EL_ARM_FIRED the hook sends when an armed
  // element plays. On success the recorder transitions to recording (and an
  // error listener is installed, mirroring start()); on failure it reports back.
  private installArmListener(): void {
    this.disposeArmListener = onPageMessage<{ ok?: boolean; error?: string }>(
      'EL_ARM_FIRED',
      (data) => {
        this.removeArmListener();
        if (data.ok) {
          this.recording = true;
          this.installErrorListener();
          this.onArmFired?.();
        } else {
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
  arm(bitrate: number): void {
    this.installArmListener();
    postToPage({ type: 'EL_ARM', bitrate });
    logger.info('Media element capture armed, bitrate:', bitrate);
  }

  /** Cancel a pending arm (no element has played yet). */
  disarm(): void {
    this.removeArmListener();
    postToPage({ type: 'EL_DISARM' });
    logger.info('Media element capture disarmed');
  }

  /** Discard an in-flight capture without producing a recording (multi-frame race). */
  abort(): void {
    this.recording = false;
    this.removeArmListener();
    this.removeErrorListener();
    postToPage({ type: 'EL_ABORT' });
    logger.info('Media element capture aborted');
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
