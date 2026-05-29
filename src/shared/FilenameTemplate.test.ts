import { describe, it, expect } from 'vitest';
import { applyTemplate, validateTemplate } from './FilenameTemplate';
import type { RecordingMetadata } from '../types';

function meta(overrides: Partial<RecordingMetadata> = {}): RecordingMetadata {
  // 2026-03-15 14:05:09 UTC
  const startedAt = Date.UTC(2026, 2, 15, 14, 5, 9);
  return {
    id: 'rec_test',
    sourceUrl: 'https://example.com/page',
    sourceHost: 'example.com',
    sourceTitle: 'Example Track',
    mimeType: 'audio/webm;codecs=opus',
    durationMs: 5000,
    sizeBytes: 1024,
    startedAt,
    endedAt: startedAt + 5000,
    ...overrides,
  };
}

describe('applyTemplate', () => {
  it('substitutes {host}', () => {
    expect(applyTemplate('{host}', meta(), 'wav')).toBe('example.com.wav');
  });

  it('substitutes {title}', () => {
    expect(applyTemplate('{title}', meta(), 'wav')).toBe('Example Track.wav');
  });

  it('substitutes {timestamp}', () => {
    const m = meta();
    expect(applyTemplate('{timestamp}', m, 'wav')).toBe(`${m.startedAt}.wav`);
  });

  it('combines multiple variables', () => {
    expect(applyTemplate('{host}_{title}', meta(), 'wav')).toBe('example.com_Example Track.wav');
  });

  it('formats {date} as YYYY-MM-DD in local time', () => {
    // Local time depends on TZ, so just assert the shape.
    const result = applyTemplate('{date}', meta(), 'wav');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}\.wav$/);
  });

  it('formats {time} as HH-MM-SS in local time', () => {
    const result = applyTemplate('{time}', meta(), 'wav');
    expect(result).toMatch(/^\d{2}-\d{2}-\d{2}\.wav$/);
  });

  it('sanitizes filesystem-invalid characters', () => {
    const m = meta({ sourceTitle: 'a/b\\c:d*e?f"g<h>i|j' });
    // Each invalid char becomes "_"
    expect(applyTemplate('{title}', m, 'wav')).toBe('a_b_c_d_e_f_g_h_i_j.wav');
  });

  it('strips control characters from titles', () => {
    const m = meta({ sourceTitle: 'line1\r\nline2\ttab' });
    expect(applyTemplate('{title}', m, 'wav')).toBe('line1__line2_tab.wav');
  });

  it('appends the given export extension', () => {
    expect(applyTemplate('x', meta(), 'wav')).toMatch(/\.wav$/);
    expect(applyTemplate('x', meta(), 'mp3')).toMatch(/\.mp3$/);
  });

  it('truncates basenames longer than 200 chars', () => {
    const longTitle = 'a'.repeat(500);
    const result = applyTemplate('{title}', meta({ sourceTitle: longTitle }), 'wav');
    // 200 chars + ".wav"
    expect(result.length).toBe(200 + '.wav'.length);
  });

  it('falls back to "recording" when substitution yields empty', () => {
    expect(applyTemplate('{title}', meta({ sourceTitle: '   ' }), 'wav')).toBe('recording.wav');
  });

  it('passes through literal text in the template', () => {
    expect(applyTemplate('prefix-{host}-suffix', meta(), 'wav')).toBe(
      'prefix-example.com-suffix.wav',
    );
  });
});

describe('validateTemplate', () => {
  it('rejects empty template', () => {
    expect(validateTemplate('').ok).toBe(false);
    expect(validateTemplate('   ').ok).toBe(false);
  });

  it('rejects template without any variable', () => {
    const result = validateTemplate('static-name');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/variable/i);
  });

  it('accepts template with at least one variable', () => {
    expect(validateTemplate('{host}').ok).toBe(true);
    expect(validateTemplate('prefix-{date}-{time}').ok).toBe(true);
  });
});
