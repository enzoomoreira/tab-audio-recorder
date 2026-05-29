// @vitest-environment node
// Node provides spec-compliant fetch, ReadableStream, Blob, AbortController
// and DOMException, which NetworkRecorder relies on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NetworkRecorder } from './NetworkRecorder';

type FetchImpl = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as { fetch: unknown }).fetch = impl as unknown;
}

/** A body that emits the given chunks and then closes on its own. */
function closingStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** A body that emits initial chunks, then stays open until the signal aborts. */
function openUntilAbort(signal: AbortSignal, initial: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (signal.aborted) {
        controller.error(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (i < initial.length) {
        controller.enqueue(initial[i++]!);
        return;
      }
      return new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
            resolve();
          },
          { once: true },
        );
      });
    },
  });
}

function okResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, statusText: 'OK', body } as unknown as Response;
}

describe('NetworkRecorder', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('assembles streamed chunks into a single blob', async () => {
    setFetch(async () =>
      okResponse(closingStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])),
    );
    const rec = new NetworkRecorder();
    rec.start('https://radio.example/stream.mp3');
    // Let the self-closing stream drain.
    await new Promise((r) => setTimeout(r, 10));
    const result = await rec.stop();
    expect(result.blob.size).toBe(5);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('guesses mime type from the URL extension', async () => {
    const cases: [string, string][] = [
      ['https://x/a.ogg', 'audio/ogg'],
      ['https://x/a.opus', 'audio/ogg'],
      ['https://x/a.aac', 'audio/aac'],
      ['https://x/a.webm', 'audio/webm'],
      ['https://x/a.mp3?token=1', 'audio/mpeg'],
    ];
    for (const [url, mime] of cases) {
      setFetch(async () => okResponse(closingStream([new Uint8Array([0])])));
      const rec = new NetworkRecorder();
      rec.start(url);
      await new Promise((r) => setTimeout(r, 5));
      const result = await rec.stop();
      expect(result.mimeType).toBe(mime);
    }
  });

  it('keeps chunks collected before an abort (stop mid-stream)', async () => {
    setFetch(async (_url, init) =>
      okResponse(openUntilAbort(init.signal, [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])])),
    );
    const rec = new NetworkRecorder();
    rec.start('https://radio.example/live');
    await new Promise((r) => setTimeout(r, 10));
    const result = await rec.stop();
    expect(result.blob.size).toBe(5);
  });

  it('reports onError and yields an empty blob when the response is not ok', async () => {
    setFetch(
      async () =>
        ({ ok: false, status: 404, statusText: 'Not Found', body: null }) as unknown as Response,
    );
    const rec = new NetworkRecorder();
    const errors: string[] = [];
    rec.onError = (reason) => errors.push(reason);
    rec.start('https://radio.example/missing.mp3');
    await new Promise((r) => setTimeout(r, 10));
    const result = await rec.stop();
    expect(result.blob.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/404/);
  });

  it('reports onError when the fetch rejects with a non-abort error', async () => {
    setFetch(async () => {
      throw new Error('network down');
    });
    const rec = new NetworkRecorder();
    const errors: string[] = [];
    rec.onError = (reason) => errors.push(reason);
    rec.start('https://radio.example/stream.mp3');
    await new Promise((r) => setTimeout(r, 10));
    await rec.stop();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/network down/);
  });

  it('tracks isRecording across start/stop', async () => {
    setFetch(async () => okResponse(closingStream([new Uint8Array([1])])));
    const rec = new NetworkRecorder();
    expect(rec.isRecording()).toBe(false);
    rec.start('https://x/a.mp3');
    expect(rec.isRecording()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await rec.stop();
    expect(rec.isRecording()).toBe(false);
  });

  it('rejects a double start', () => {
    setFetch(async () => okResponse(closingStream([])));
    const rec = new NetworkRecorder();
    rec.start('https://x/a.mp3');
    expect(() => rec.start('https://x/b.mp3')).toThrow(/already recording/i);
  });

  it('throws when stopping without recording', async () => {
    const rec = new NetworkRecorder();
    await expect(rec.stop()).rejects.toThrow(/not recording/i);
  });
});
