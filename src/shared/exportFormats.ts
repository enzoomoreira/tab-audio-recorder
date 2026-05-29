import type { ExportFormat } from '../types';

// Lightweight format metadata, free of the encoder's heavy deps (lamejs), so
// the settings page and filename logic can import it without pulling in the
// MP3 encoder. The encoder itself lives in AudioEncoder.ts.
export const FORMAT_META: Record<
  ExportFormat,
  { mimeType: string; extension: string; label: string }
> = {
  wav: { mimeType: 'audio/wav', extension: 'wav', label: 'WAV (lossless)' },
  mp3: { mimeType: 'audio/mpeg', extension: 'mp3', label: 'MP3' },
};

export const EXPORT_FORMATS: ExportFormat[] = ['wav', 'mp3'];
