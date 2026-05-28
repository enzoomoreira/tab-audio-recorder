import { createLogger } from '../shared/Logger';
import type { IDetector } from '../types';

const logger = createLogger('DOMScanner');

export class DOMScanner implements IDetector {
  find(): HTMLMediaElement | null {
    // Priority: playing video > playing audio > any video > any audio
    const candidates: Array<HTMLMediaElement | null> = [
      this.findPlaying('video'),
      this.findPlaying('audio'),
      document.querySelector<HTMLVideoElement>('video'),
      document.querySelector<HTMLAudioElement>('audio'),
    ];

    for (const el of candidates) {
      if (el) {
        logger.debug('Found media element:', el.tagName, el.currentSrc || el.src);
        return el;
      }
    }

    logger.debug('No media element found');
    return null;
  }

  hasMedia(): boolean {
    return this.find() !== null;
  }

  private findPlaying(tag: 'video' | 'audio'): HTMLMediaElement | null {
    const elements = document.querySelectorAll<HTMLMediaElement>(tag);
    for (const el of elements) {
      if (!el.paused && el.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
        return el;
      }
    }
    return null;
  }
}
