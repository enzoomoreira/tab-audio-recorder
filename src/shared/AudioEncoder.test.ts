// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { encodeWav, encodeMp3, type PcmAudio } from './AudioEncoder';

function tone(frames: number, channels: number, sampleRate: number): PcmAudio {
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const buf = new Float32Array(frames);
    for (let i = 0; i < frames; i++) buf[i] = Math.sin(i * 0.05 * (c + 1)) * 0.5;
    data.push(buf);
  }
  return {
    numberOfChannels: channels,
    sampleRate,
    length: frames,
    getChannelData: (ch) => data[ch]!,
  };
}

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]!);
  return s;
}

function hasMp3FrameSync(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1]! & 0xe0) === 0xe0) return true;
  }
  return false;
}

describe('encodeWav', () => {
  it('writes a valid 16-bit PCM RIFF header (stereo)', () => {
    const frames = 100;
    const bytes = encodeWav(tone(frames, 2, 44100));
    const view = new DataView(bytes.buffer);

    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(ascii(bytes, 36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample

    const expectedData = frames * 2 * 2; // frames * channels * bytesPerSample
    expect(view.getUint32(40, true)).toBe(expectedData);
    expect(view.getUint32(4, true)).toBe(36 + expectedData);
    expect(bytes.length).toBe(44 + expectedData);
  });

  it('handles mono and preserves the sample rate', () => {
    const bytes = encodeWav(tone(50, 1, 48000));
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(bytes.length).toBe(44 + 50 * 1 * 2);
  });

  it('clamps out-of-range samples to the 16-bit limits', () => {
    const pcm: PcmAudio = {
      numberOfChannels: 1,
      sampleRate: 44100,
      length: 2,
      getChannelData: () => Float32Array.of(2, -2),
    };
    const bytes = encodeWav(pcm);
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
  });
});

describe('encodeMp3', () => {
  it('produces a non-empty MP3 stream with frame sync (mono)', () => {
    const bytes = encodeMp3(tone(4608, 1, 44100), 128);
    expect(bytes.length).toBeGreaterThan(0);
    expect(hasMp3FrameSync(bytes)).toBe(true);
  });

  it('encodes stereo', () => {
    const bytes = encodeMp3(tone(4608, 2, 44100), 192);
    expect(bytes.length).toBeGreaterThan(0);
    expect(hasMp3FrameSync(bytes)).toBe(true);
  });

  it('rejects a sample rate MP3 cannot carry', () => {
    expect(() => encodeMp3(tone(1152, 1, 96000), 128)).toThrow(/sample rate/i);
  });
});
