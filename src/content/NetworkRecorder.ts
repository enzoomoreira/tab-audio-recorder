import { ChunkSink } from './ChunkSink';
import { createLogger } from '../shared/Logger';
import type { INetworkRecorder, CaptureResult } from '../types';

const logger = createLogger('NetworkRecorder');
const START_TIMEOUT_MS = 10_000;

function isPlaylist(url: string, contentType = ''): boolean {
  return (
    /\.m3u8?(?:[?#]|$)/i.test(url) ||
    /^(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/(?:mpegurl|x-mpegurl))$/.test(
      contentType,
    )
  );
}

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
  private sink: ChunkSink | null = null;
  private chunkCount = 0;
  private failure: Error | null = null;
  private mimeType = 'audio/mpeg';
  private startedAt = 0;

  // Invoked if the stream fetch fails mid-capture (not via stop()).
  onError: ((reason: string) => void) | null = null;

  async start(url: string, captureId: string): Promise<void> {
    if (this.controller) throw new Error('Already recording');
    if (isPlaylist(url)) throw new Error('Playlists require media or Web Audio capture');

    const controller = new AbortController();
    this.controller = controller;
    this.sink = new ChunkSink(captureId);
    this.chunkCount = 0;
    this.failure = null;
    this.startedAt = Date.now();
    this.mimeType = guessMimeType(url);

    const timer = setTimeout((): void => controller.abort(), START_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok || !res.body) {
        throw new Error(`Stream fetch failed: ${res.status} ${res.statusText}`);
      }
      const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (isPlaylist(res.url || url, contentType)) {
        throw new Error('Playlists require media or Web Audio capture');
      }
      if (contentType && contentType !== 'application/octet-stream') this.mimeType = contentType;
      this.fetchDone = this.streamFetch(res.body, controller.signal);
    } catch (error) {
      controller.abort();
      this.sink.dispose();
      this.sink = null;
      this.controller = null;
      throw error;
    } finally {
      clearTimeout(timer);
    }
    logger.info('Started network recording:', url);
  }

  private async streamFetch(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || signal.aborted) {
          break;
        }
        if (value) {
          for (let offset = 0; offset < value.byteLength; offset += 1024 * 1024) {
            const blob = new Blob([value.slice(offset, offset + 1024 * 1024)], {
              type: this.mimeType,
            });
            await this.sink!.write(this.chunkCount, blob, Date.now(), this.startedAt);
            this.chunkCount++;
          }
        }
      }

      logger.debug('Stream ended, total chunks:', this.chunkCount);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        logger.debug('Fetch aborted (normal stop)');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.failure = new Error(msg);
        this.controller?.abort();
        logger.error('Stream error:', msg);
        this.onError?.(`Stream error: ${msg}`);
      }
    } finally {
      reader.releaseLock();
    }
  }

  async stop(): Promise<CaptureResult> {
    if (!this.controller || !this.fetchDone) {
      throw new Error('Not recording');
    }

    const sink = this.sink!;
    this.controller.abort();
    await this.fetchDone;
    try {
      if (this.failure) throw this.failure;
      await sink.drain(this.chunkCount);
      const endedAt = Date.now();
      return {
        captureId: sink.captureId,
        chunkCount: this.chunkCount,
        mimeType: this.mimeType,
        startedAt: this.startedAt,
        endedAt,
        durationMs: endedAt - this.startedAt,
      };
    } finally {
      sink.dispose();
      this.sink = null;
      this.controller = null;
      this.fetchDone = null;
    }
  }

  isRecording(): boolean {
    return this.controller !== null;
  }
}
