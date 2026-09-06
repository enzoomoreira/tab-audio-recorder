import type { PcmAudio } from './PcmEncoder';
import workerUrl from './encoding.worker.ts?worker&url';

export interface EncodingRequest {
  channels: Float32Array<ArrayBuffer>[];
  sampleRate: number;
  format: 'wav' | 'mp3';
  kbps: number;
}

export type EncodingResponse =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; error: string };

/** Transfer PCM to a dedicated worker so encoding cannot block capture messages. */
export async function encodeInWorker(
  pcm: PcmAudio,
  format: 'wav' | 'mp3',
  kbps: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const worker = new Worker(browser.runtime.getURL(workerUrl), { type: 'module' });
  try {
    return await new Promise((resolve, reject): void => {
      worker.onmessage = (event: MessageEvent<EncodingResponse>): void => {
        if (event.data.ok) resolve(event.data.bytes);
        else reject(new Error(event.data.error));
      };
      worker.onerror = (event): void =>
        reject(new Error(event.message || 'Audio encoder worker failed'));
      worker.onmessageerror = (): void =>
        reject(new Error('Could not read encoded audio from worker'));
      const count = format === 'mp3' ? Math.min(pcm.numberOfChannels, 2) : pcm.numberOfChannels;
      const channels = Array.from(
        { length: count },
        (_, channel) => new Float32Array(pcm.getChannelData(channel)),
      );
      const request: EncodingRequest = { channels, sampleRate: pcm.sampleRate, format, kbps };
      worker.postMessage(
        request,
        channels.map((channel) => channel.buffer),
      );
    });
  } finally {
    worker.terminate();
  }
}
