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

  let stream: MediaStream;
  if (typeof (el as unknown as Partial<WithCapture>).captureStream === 'function') {
    stream = (el as unknown as WithCapture).captureStream();
  } else if (typeof (el as unknown as Partial<WithMozCapture>).mozCaptureStream === 'function') {
    stream = (el as unknown as WithMozCapture).mozCaptureStream();
  } else {
    throw new Error('captureStream not available on this element');
  }

  // <video> elements expose both audio and video tracks. MediaRecorder rejects
  // a stream containing video when the requested mimeType is audio-only, so
  // build a fresh stream from audio tracks only.
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    throw new Error('Media element has no audio tracks');
  }
  return new MediaStream(audioTracks);
}

export class StreamRecorder implements IStreamRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = '';
  private startedAt = 0;

  start(element: HTMLMediaElement, bitrate: number): void {
    if (this.recorder) {
      throw new Error('Already recording');
    }

    // EME/DRM-protected playback yields a silent capture stream in Firefox.
    // Surface this up-front instead of recording silence.
    const raw =
      (element as unknown as { wrappedJSObject?: HTMLMediaElement }).wrappedJSObject ?? element;
    if ((raw as unknown as { mediaKeys?: unknown }).mediaKeys != null) {
      throw new Error('DRM/EME content cannot be captured (Firefox security policy)');
    }

    const stream = captureStream(element);
    const mimeType = pickMimeType();
    this.chunks = [];
    this.startedAt = Date.now();

    const options: MediaRecorderOptions = { audioBitsPerSecond: bitrate };
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
