import { createLogger } from '../shared/Logger';
import type { IDetector } from '../types';

const logger = createLogger('DOMScanner');

export interface DiagnosticReport {
  url: string;
  directElements: DiagnosticElement[];
  shadowElements: DiagnosticElement[];
  iframeElements: DiagnosticElement[];
}

interface DiagnosticElement {
  tag: string;
  src: string;
  currentSrc: string;
  paused: boolean;
  readyState: number;
  duration: number;
  inShadowOf?: string;
  inIframe?: number;
}

function describeElement(el: HTMLMediaElement, extra?: Partial<DiagnosticElement>): DiagnosticElement {
  return {
    tag: el.tagName,
    src: el.src,
    currentSrc: el.currentSrc,
    paused: el.paused,
    readyState: el.readyState,
    duration: el.duration,
    ...extra,
  };
}

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
        logger.debug('Found:', el.tagName, `src="${el.currentSrc || el.src}"`, `paused=${el.paused}`, `readyState=${el.readyState}`);
        return el;
      }
    }

    logger.debug('No <audio>/<video> found in main document. Try DIAGNOSE command to inspect shadow DOM and iframes.');
    return null;
  }

  hasMedia(): boolean {
    return this.find() !== null;
  }

  diagnose(): DiagnosticReport {
    const report: DiagnosticReport = {
      url: location.href,
      directElements: [],
      shadowElements: [],
      iframeElements: [],
    };

    // Direct
    document.querySelectorAll<HTMLMediaElement>('audio, video').forEach((el) => {
      report.directElements.push(describeElement(el));
    });

    // Shadow DOM (shallow scan — one level deep for common patterns)
    document.querySelectorAll('*').forEach((host) => {
      if (host.shadowRoot) {
        host.shadowRoot.querySelectorAll<HTMLMediaElement>('audio, video').forEach((el) => {
          report.shadowElements.push(describeElement(el, { inShadowOf: host.tagName }));
        });
      }
    });

    // Same-origin iframes
    document.querySelectorAll('iframe').forEach((frame, idx) => {
      try {
        frame.contentDocument?.querySelectorAll<HTMLMediaElement>('audio, video').forEach((el) => {
          report.iframeElements.push(describeElement(el, { inIframe: idx }));
        });
      } catch {
        // cross-origin — inaccessible
      }
    });

    logger.info('Diagnostic report:', JSON.stringify(report, null, 2));
    return report;
  }

  private findPlaying(tag: 'video' | 'audio'): HTMLMediaElement | null {
    const elements = document.querySelectorAll<HTMLMediaElement>(tag);
    for (const el of elements) {
      if (!el.paused && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        return el;
      }
    }
    return null;
  }
}
