import type { ExportFormat } from '../types';

// Lightweight format metadata, free of the encoder's heavy deps (lamejs), so
// the settings page and filename logic can import it without pulling in the
// MP3 encoder. The encoder itself lives in AudioEncoder.ts.
export const FORMAT_META: Record<
  Exclude<ExportFormat, 'original'>,
  { mimeType: string; extension: string; label: string }
> = {
  wav: { mimeType: 'audio/wav', extension: 'wav', label: 'WAV (lossless)' },
  mp3: { mimeType: 'audio/mpeg', extension: 'mp3', label: 'MP3' },
};

export const EXPORT_FORMATS: ExportFormat[] = ['original', 'wav', 'mp3'];

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  original: 'Original (no conversion; recommended for long recordings)',
  wav: FORMAT_META.wav.label,
  mp3: FORMAT_META.mp3.label,
};

const ORIGINAL_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/aac': 'aac',
  'audio/aacp': 'aac',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

export function originalExtension(mimeType: string): string {
  const mime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = Object.hasOwn(ORIGINAL_EXTENSIONS, mime)
    ? ORIGINAL_EXTENSIONS[mime]
    : undefined;
  if (!extension) {
    throw new Error(`Unknown original audio format: ${mime || 'missing MIME type'}`);
  }
  return extension;
}
