import { onPageMessage, postToPage } from './pageBridge';
import type { ActionResult } from '../types';

const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_CHUNKS = 16;
const ACK_TIMEOUT_MS = 10_000;

/** Serial, bounded writes; a chunk is acknowledged only after durable storage commits. */
export class ChunkSink {
  private tail: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private pendingCount = 0;
  private nextSequence = 0;
  private failure: Error | null = null;
  private disposed = false;
  private removeListener: (() => void) | null = null;

  constructor(readonly captureId: string) {}

  write(sequence: number, blob: Blob, endedAt: number, startedAt: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Capture cancelled'));
    if (this.failure) return Promise.reject(this.failure);
    if (
      sequence !== this.nextSequence ||
      this.pendingCount >= MAX_PENDING_CHUNKS ||
      this.pendingBytes + blob.size > MAX_PENDING_BYTES
    ) {
      this.failure = new Error(
        'Recording storage cannot keep up; capture stopped to preserve saved audio',
      );
      return Promise.reject(this.failure);
    }
    this.nextSequence++;
    this.pendingCount++;
    this.pendingBytes += blob.size;
    const write = this.tail.then(async (): Promise<void> => {
      if (this.failure) throw this.failure;
      if (this.disposed) throw new Error('Capture cancelled');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          browser.runtime.sendMessage({
            type: 'CAPTURE_CHUNK',
            payload: { captureId: this.captureId, sequence, blob, endedAt, startedAt },
          }) as Promise<ActionResult>,
          new Promise<never>((_, reject): void => {
            timer = setTimeout(
              (): void => reject(new Error('Recording storage acknowledgment timed out')),
              ACK_TIMEOUT_MS,
            );
          }),
        ]);
        if (!result?.ok) throw new Error(result?.error ?? 'Recording chunk could not be saved');
      } finally {
        clearTimeout(timer);
      }
    });
    this.tail = write
      .catch((error: unknown): void => {
        this.failure = error instanceof Error ? error : new Error(String(error));
      })
      .finally((): void => {
        this.pendingCount--;
        this.pendingBytes -= blob.size;
      });
    return write;
  }

  listen(prefix: string): void {
    this.removeListener = onPageMessage<{
      type?: string;
      captureId: string;
      sequence: number;
      blob: Blob;
      endedAt: number;
      startedAt: number;
    }>(`${prefix}CHUNK`, (chunk): void => {
      if (chunk.captureId !== this.captureId) return;
      void this.write(chunk.sequence, chunk.blob, chunk.endedAt, chunk.startedAt).then(
        (): void =>
          postToPage({
            type: `${prefix}CHUNK_ACK`,
            captureId: this.captureId,
            sequence: chunk.sequence,
            ok: true,
          }),
        (error: unknown): void =>
          postToPage({
            type: `${prefix}CHUNK_ACK`,
            captureId: this.captureId,
            sequence: chunk.sequence,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    });
  }

  async drain(expectedCount: number): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure;
    if (this.nextSequence !== expectedCount) throw new Error('Recording chunk count mismatch');
  }

  dispose(): void {
    this.disposed = true;
    this.removeListener?.();
    this.removeListener = null;
  }
}
