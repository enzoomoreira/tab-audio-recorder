import { Mp3Encoder } from '@breezystack/lamejs';
import { MP3_SAMPLE_RATES } from './exportFormats';
// lamejs (like LAME) consumes one MPEG granule pair — 1152 samples — per call.
const MP3_BLOCK = 1152;

/**
 * Minimal slice of the AudioBuffer surface the encoders rely on. Declaring it
 * explicitly keeps encodeWav/encodeMp3 pure and unit-testable without a real
 * Web Audio AudioBuffer (which neither node nor happy-dom provide).
 */
export interface PcmAudio {
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

function clampSample16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function toInt16(channel: Float32Array): Int16Array {
  const out = new Int16Array(channel.length);
  for (let i = 0; i < channel.length; i++) out[i] = clampSample16(channel[i] ?? 0);
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Encode PCM to a 16-bit little-endian WAV (RIFF) byte stream. */
export function encodeWav(pcm: PcmAudio): Uint8Array<ArrayBuffer> {
  const channels = pcm.numberOfChannels;
  const frames = pcm.length;
  const blockAlign = channels * 2; // 16-bit samples
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(pcm.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      view.setInt16(offset, clampSample16(channelData[c]?.[i] ?? 0), true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/** Encode PCM to an MP3 byte stream (mono or stereo) via lamejs. */
export function encodeMp3(pcm: PcmAudio, kbps: number): Uint8Array<ArrayBuffer> {
  if (!MP3_SAMPLE_RATES.has(pcm.sampleRate)) {
    throw new Error(`Unsupported MP3 sample rate: ${pcm.sampleRate}`);
  }
  const channels = Math.min(pcm.numberOfChannels, 2);
  const encoder = new Mp3Encoder(channels, pcm.sampleRate, kbps);
  const left = toInt16(pcm.getChannelData(0));
  const right = channels > 1 ? toInt16(pcm.getChannelData(1)) : null;

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < pcm.length; i += MP3_BLOCK) {
    const l = left.subarray(i, i + MP3_BLOCK);
    const block = right
      ? encoder.encodeBuffer(l, right.subarray(i, i + MP3_BLOCK))
      : encoder.encodeBuffer(l);
    if (block.length > 0) chunks.push(block.slice());
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail.slice());

  return concat(chunks);
}
