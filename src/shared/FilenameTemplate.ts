import type { RecordingMetadata } from '../types';

export const TEMPLATE_VARIABLES = ['host', 'title', 'date', 'time', 'timestamp'] as const;
type TemplateVar = (typeof TEMPLATE_VARIABLES)[number];

const FILESYSTEM_INVALID = /[/\\:*?"<>|\r\n\t]/g;
const MAX_BASENAME_LEN = 200;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

function sanitize(s: string): string {
  return s.replace(FILESYSTEM_INVALID, '_').trim();
}

function extFromMime(mime: string): string {
  const main = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (main.includes('ogg')) return 'ogg';
  if (main.includes('aac')) return 'aac';
  if (main.includes('mpeg')) return 'mp3';
  if (main.includes('webm')) return 'webm';
  return 'bin';
}

const RESOLVERS: Record<TemplateVar, (m: RecordingMetadata) => string> = {
  host: (m) => m.sourceHost,
  title: (m) => m.sourceTitle,
  date: (m) => formatDate(m.startedAt),
  time: (m) => formatTime(m.startedAt),
  timestamp: (m) => String(m.startedAt),
};

/**
 * Renders a filename from a template like "{host}_{date}_{time}" using the
 * recording's metadata. Each variable value is sanitized for filesystem
 * safety, the full basename is truncated to 200 chars, and an extension is
 * appended based on the MIME type. Returns "recording.<ext>" as a fallback
 * if substitution produces an empty string.
 */
export function applyTemplate(template: string, meta: RecordingMetadata): string {
  // Fresh regex per call — avoids /g lastIndex statefulness pitfalls
  const pattern = /\{(host|title|date|time|timestamp)\}/g;
  const body = template.replace(pattern, (_, varName: string) => {
    const fn = RESOLVERS[varName as TemplateVar];
    return sanitize(fn(meta));
  });
  const sanitized = sanitize(body).slice(0, MAX_BASENAME_LEN);
  const ext = extFromMime(meta.mimeType);
  return `${sanitized || 'recording'}.${ext}`;
}

export function validateTemplate(template: string): { ok: boolean; error?: string } {
  if (!template.trim()) {
    return { ok: false, error: 'Template cannot be empty' };
  }
  if (!/\{(host|title|date|time|timestamp)\}/.test(template)) {
    return {
      ok: false,
      error: 'Template must contain at least one variable like {host} or {date}',
    };
  }
  return { ok: true };
}
