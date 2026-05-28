import { createLogger } from '../shared/Logger';
import type { IStreamRecorder, CaptureResult } from '../types';

const logger = createLogger('StreamRecorder');

const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickMimeType(): string {
  for (const mime of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

function captureStream(element: HTMLMediaElement): MediaStream {
  // Firefox Xray wrapper workaround: try wrappedJSObject first, then direct.
  const el = (element as unknown as { wrappedJSObject?: HTMLMediaElement }).wrappedJSObject ?? element;

  type WithCapture = { captureStream: () => MediaStream };
  type WithMozCapture = { mozCaptureStream: () => MediaStream };

  if (typeof (el as unknown as Partial<WithCapture>).captureStream === 'function') {
    return (el as unknown as WithCapture).captureStream();
  }
  if (typeof (el as unknown as Partial<WithMozCapture>).mozCaptureStream === 'function') {
    return (el as unknown as WithMozCapture).mozCaptureStream();
  }

  throw new Error('captureStream not available on this element');
}

export class StreamRecorder implements IStreamRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = '';
  private startedAt = 0;

  start(element: HTMLMediaElement): void {
    if (this.recorder) {
      throw new Error('Already recording');
    }

    const stream = captureStream(element);
    const mimeType = pickMimeType();
    this.chunks = [];
    this.startedAt = Date.now();

    const options: MediaRecorderOptions = { audioBitsPerSecond: 128_000 };
    if (mimeType) options.mimeType = mimeType;

    this.recorder = new MediaRecorder(stream, options);
    this.mimeType = this.recorder.mimeType;

    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };

    this.recorder.start(1000);
    logger.info('Started, mimeType:', this.mimeType);
  }

  stop(): Promise<CaptureResult> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error('Not recording'));
        return;
      }

      const recorder = this.recorder;
      const startedAt = this.startedAt;
      const mimeType = this.mimeType;

      recorder.onstop = () => {
        const endedAt = Date.now();
        const blob = new Blob(this.chunks, { type: mimeType });
        this.recorder = null;
        this.chunks = [];
        logger.info('Stopped, blob:', blob.size, 'bytes');
        resolve({ blob, mimeType, durationMs: endedAt - startedAt, startedAt, endedAt });
      };

      recorder.onerror = (event) => {
        this.recorder = null;
        this.chunks = [];
        reject(new Error(`MediaRecorder error: ${event.error?.message ?? 'unknown'}`));
      };

      recorder.stop();
    });
  }

  isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }
}
