import { createLogger } from '../shared/Logger';
import type { INetworkRecorder, CaptureResult } from '../types';

const logger = createLogger('NetworkRecorder');

function guessMimeType(url: string): string {
  const path = url.toLowerCase().split('?')[0] ?? '';
  if (path.endsWith('.ogg') || path.endsWith('.opus')) return 'audio/ogg';
  if (path.endsWith('.aac')) return 'audio/aac';
  if (path.endsWith('.webm')) return 'audio/webm';
  return 'audio/mpeg'; // default: mp3 streams
}

export class NetworkRecorder implements INetworkRecorder {
  private controller: AbortController | null = null;
  private fetchDone: Promise<void> | null = null;
  private chunks: Uint8Array[] = [];
  private mimeType = 'audio/mpeg';
  private startedAt = 0;

  start(url: string): void {
    if (this.controller) throw new Error('Already recording');

    this.controller = new AbortController();
    this.chunks = [];
    this.startedAt = Date.now();
    this.mimeType = guessMimeType(url);

    // Fire-and-forget: fetchDone resolves when stream ends or is aborted
    this.fetchDone = this.streamFetch(url, this.controller.signal);
    logger.info('Started network recording:', url);
  }

  private async streamFetch(url: string, signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok || !res.body) {
        logger.error('Fetch failed:', res.status, res.statusText);
        return;
      }

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) {
          reader.releaseLock();
          break;
        }
        if (value) this.chunks.push(value);
      }

      logger.debug('Stream ended, total chunks:', this.chunks.length);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        logger.debug('Fetch aborted (normal stop)');
      } else {
        logger.error('Stream error:', err);
      }
    }
  }

  async stop(): Promise<CaptureResult> {
    if (!this.controller || !this.fetchDone) {
      throw new Error('Not recording');
    }

    const startedAt = this.startedAt;
    const mimeType = this.mimeType;

    // Abort the stream and wait for the fetch coroutine to finish collecting
    this.controller.abort();
    await this.fetchDone;

    const endedAt = Date.now();

    // Assemble chunks into a single Blob
    const totalBytes = this.chunks.reduce((n, c) => n + c.length, 0);
    const buffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    const blob = new Blob([buffer], { type: mimeType });

    this.controller = null;
    this.fetchDone = null;
    this.chunks = [];

    logger.info('Stopped, blob size:', blob.size, 'bytes, duration:', endedAt - startedAt, 'ms');
    return { blob, mimeType, durationMs: endedAt - startedAt, startedAt, endedAt };
  }

  isRecording(): boolean {
    return this.controller !== null;
  }
}
