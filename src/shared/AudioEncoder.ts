import { encodeInWorker } from './EncodingWorker';
import { FORMAT_META, originalExtension, MP3_SAMPLE_RATES } from './exportFormats';
import type { ExportFormat } from '../types';

export interface EncodedAudio {
  blob: Blob;
  mimeType: string;
  extension: string;
}

export interface EncodeOptions {
  mp3Kbps?: number;
}

// Serialize decoding as well as encoding to avoid multiple full PCM allocations.
// Original exports bypass this queue.
let conversionQueue: Promise<void> = Promise.resolve();

async function decodeAudio(blob: Blob, sampleRate?: number): Promise<AudioBuffer> {
  const data = await blob.arrayBuffer();
  const ctx = sampleRate ? new AudioContext({ sampleRate }) : new AudioContext();
  try {
    return await ctx.decodeAudioData(data);
  } finally {
    await ctx.close();
  }
}

export async function encodeForExport(
  blob: Blob,
  format: ExportFormat,
  opts: EncodeOptions = {},
): Promise<EncodedAudio> {
  if (format === 'original') {
    return { blob, mimeType: blob.type, extension: originalExtension(blob.type) };
  }
  const job = conversionQueue.then(async (): Promise<EncodedAudio> => {
    let pcm = await decodeAudio(blob);
    if (format === 'mp3' && !MP3_SAMPLE_RATES.has(pcm.sampleRate)) {
      pcm = await decodeAudio(blob, 44100);
    }
    const bytes = await encodeInWorker(
      pcm,
      format,
      Math.max(8, Math.min(320, Math.round(opts.mp3Kbps ?? 128))),
    );
    const { mimeType, extension } = FORMAT_META[format];
    return { blob: new Blob([bytes], { type: mimeType }), mimeType, extension };
  });
  conversionQueue = job.then(
    (): void => {},
    (): void => {},
  );
  return job;
}
