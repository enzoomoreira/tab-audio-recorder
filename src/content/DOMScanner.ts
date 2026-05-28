import { createLogger } from '../shared/Logger';
import type { IDetector } from '../types';

const logger = createLogger('DOMScanner');

const MAX_SCAN_DEPTH = 8;

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

type Location = 'direct' | 'shadow' | 'iframe';

interface FoundMedia {
  element: HTMLMediaElement;
  location: Location;
  hostTag: string | undefined;
  iframeIndex: number | undefined;
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

function isPlaying(el: HTMLMediaElement): boolean {
  return !el.paused && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

export class DOMScanner implements IDetector {
  find(): HTMLMediaElement | null {
    const all = this.scanAll();

    // Priority: playing video > playing audio > any video > any audio
    const byKind = (tag: 'VIDEO' | 'AUDIO', playingOnly: boolean): FoundMedia | undefined =>
      all.find((m) => m.element.tagName === tag && (!playingOnly || isPlaying(m.element)));

    const candidates = [
      byKind('VIDEO', true),
      byKind('AUDIO', true),
      byKind('VIDEO', false),
      byKind('AUDIO', false),
    ];

    for (const m of candidates) {
      if (m) {
        const el = m.element;
        logger.debug(
          'Found:',
          el.tagName,
          `(${m.location}${m.hostTag ? ` in <${m.hostTag.toLowerCase()}>` : ''}${m.iframeIndex !== undefined ? ` iframe#${m.iframeIndex}` : ''})`,
          `src="${el.currentSrc || el.src}"`,
          `paused=${el.paused}`,
          `readyState=${el.readyState}`,
        );
        return el;
      }
    }

    logger.debug('No <audio>/<video> found in document, shadow roots, or same-origin iframes.');
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

    for (const m of this.scanAll()) {
      if (m.location === 'direct') {
        report.directElements.push(describeElement(m.element));
      } else if (m.location === 'shadow') {
        report.shadowElements.push(
          describeElement(m.element, m.hostTag !== undefined ? { inShadowOf: m.hostTag } : {}),
        );
      } else {
        report.iframeElements.push(
          describeElement(m.element, m.iframeIndex !== undefined ? { inIframe: m.iframeIndex } : {}),
        );
      }
    }

    logger.info('Diagnostic report:', JSON.stringify(report, null, 2));
    return report;
  }

  private scanAll(): FoundMedia[] {
    const results: FoundMedia[] = [];
    const visitedDocs = new Set<Document>([document]);
    this.scanRoot(document, 'direct', undefined, undefined, results, visitedDocs, 0);
    return results;
  }

  private scanRoot(
    root: Document | ShadowRoot,
    location: Location,
    hostTag: string | undefined,
    iframeIndex: number | undefined,
    results: FoundMedia[],
    visitedDocs: Set<Document>,
    depth: number,
  ): void {
    if (depth > MAX_SCAN_DEPTH) return;

    root.querySelectorAll<HTMLMediaElement>('audio, video').forEach((element) => {
      results.push({ element, location, hostTag, iframeIndex });
    });

    root.querySelectorAll('*').forEach((host) => {
      if (host.shadowRoot) {
        this.scanRoot(host.shadowRoot, 'shadow', host.tagName, iframeIndex, results, visitedDocs, depth + 1);
      }
    });

    root.querySelectorAll('iframe').forEach((frame, idx) => {
      try {
        const doc = frame.contentDocument;
        if (doc && !visitedDocs.has(doc)) {
          visitedDocs.add(doc);
          this.scanRoot(doc, 'iframe', undefined, idx, results, visitedDocs, depth + 1);
        }
      } catch {
        // cross-origin -- inaccessible from here, P2 will cover via all_frames
      }
    });
  }
}
