// Icons are built as real SVG nodes (not innerHTML) to avoid any HTML-string
// assignment surface and keep the AMO validator clean.
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function icon(
  viewBox: string,
  rootAttrs: Record<string, string>,
  children: SVGElement[],
): SVGSVGElement {
  const svg = svgEl('svg', { width: '14', height: '14', viewBox, ...rootAttrs });
  for (const c of children) svg.appendChild(c);
  return svg;
}

function playIcon(): SVGSVGElement {
  return icon('0 0 12 12', { fill: 'currentColor' }, [
    svgEl('path', { d: 'M2 1.5l9 4.5-9 4.5V1.5z' }),
  ]);
}

function pauseIcon(): SVGSVGElement {
  return icon('0 0 12 12', { fill: 'currentColor' }, [
    svgEl('rect', { x: '2', y: '1', width: '3', height: '10', rx: '1' }),
    svgEl('rect', { x: '7', y: '1', width: '3', height: '10', rx: '1' }),
  ]);
}

function spinnerIcon(): SVGSVGElement {
  return icon(
    '0 0 24 24',
    { fill: 'none', stroke: 'currentColor', 'stroke-width': '3', 'stroke-linecap': 'round' },
    [svgEl('path', { d: 'M12 3 a9 9 0 0 1 9 9' })],
  );
}

function fmtSec(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Lazy-loading audio player.
 *
 * The blob is only fetched on the first click of the play button — this
 * keeps page-load cheap when there are many recordings. Subsequent clicks
 * toggle play/pause as expected. The `loader` callback supplies the object
 * URL on demand (typically wrapping an IndexedDB fetch).
 */
export class AudioPlayer {
  private audio = new Audio();
  private btn: HTMLButtonElement;
  private scrubber: HTMLInputElement;
  private timeEl: HTMLSpanElement;
  private knownDurationSec: number;
  private scrubbing = false;
  private loader: () => Promise<string | null>;
  private loadingPromise: Promise<boolean> | null = null;

  constructor(
    container: HTMLElement,
    knownDurationMs: number,
    loader: () => Promise<string | null>,
  ) {
    this.knownDurationSec = knownDurationMs / 1000;
    this.loader = loader;

    this.btn = container.querySelector<HTMLButtonElement>('.player__btn')!;
    this.scrubber = container.querySelector<HTMLInputElement>('.player__scrubber')!;
    this.timeEl = container.querySelector<HTMLSpanElement>('.player__time')!;

    this.btn.replaceChildren(playIcon());
    this.setTime(0, this.knownDurationSec);

    this.bindAudioEvents();
    this.bindUiEvents();
  }

  destroy(): void {
    this.audio.pause();
    this.audio.src = '';
  }

  // --- Internals ---

  private bindAudioEvents(): void {
    this.audio.addEventListener('play', () => this.renderPlaying());
    this.audio.addEventListener('pause', () => this.renderPaused());
    this.audio.addEventListener('timeupdate', () => {
      if (!this.scrubbing) this.syncScrubber();
    });
    this.audio.addEventListener('ended', () => {
      this.scrubber.value = '0';
      this.setTime(0, this.effectiveDuration());
      this.renderPaused();
    });
  }

  private bindUiEvents(): void {
    this.btn.addEventListener('click', () => void this.handleToggle());

    this.scrubber.addEventListener('mousedown', () => {
      this.scrubbing = true;
    });
    this.scrubber.addEventListener('touchstart', () => {
      this.scrubbing = true;
    });
    this.scrubber.addEventListener('input', () => this.previewScrub());
    this.scrubber.addEventListener('change', () => void this.commitScrub());
  }

  private async handleToggle(): Promise<void> {
    const loaded = await this.ensureLoaded();
    if (!loaded) return;

    if (this.audio.paused) {
      void this.audio.play();
    } else {
      this.audio.pause();
    }
  }

  private async ensureLoaded(): Promise<boolean> {
    if (this.audio.src) return true;

    // Dedup concurrent loads (defensive — UI also disables the button)
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = this.doLoad();
    const ok = await this.loadingPromise;
    if (!ok) this.loadingPromise = null; // allow retry on failure
    return ok;
  }

  private async doLoad(): Promise<boolean> {
    this.btn.disabled = true;
    this.btn.replaceChildren(spinnerIcon());
    this.btn.classList.add('player__btn--loading');

    try {
      const url = await this.loader();
      if (!url) {
        this.renderPaused();
        return false;
      }
      this.audio.src = url;
      this.audio.preload = 'metadata';
      return true;
    } finally {
      this.btn.disabled = false;
      this.btn.classList.remove('player__btn--loading');
      // Icon is reset by the play/pause event listeners once playback toggles.
      // If load failed, renderPaused() above already set it back.
    }
  }

  private previewScrub(): void {
    const pct = Number(this.scrubber.value) / 1000;
    const dur = this.effectiveDuration();
    this.setTime(pct * dur, dur);
  }

  private async commitScrub(): Promise<void> {
    this.scrubbing = false;
    const pct = Number(this.scrubber.value) / 1000;

    // Auto-load on first scrub: lets the user pre-position before pressing play.
    const loaded = await this.ensureLoaded();
    if (!loaded) return;

    const dur = this.effectiveDuration();
    if (isFinite(dur) && dur > 0) {
      this.audio.currentTime = pct * dur;
    }
  }

  private renderPlaying(): void {
    this.btn.replaceChildren(pauseIcon());
    this.btn.setAttribute('aria-label', 'Pause');
  }

  private renderPaused(): void {
    this.btn.replaceChildren(playIcon());
    this.btn.setAttribute('aria-label', 'Play');
  }

  private effectiveDuration(): number {
    return isFinite(this.audio.duration) && this.audio.duration > 0
      ? this.audio.duration
      : this.knownDurationSec;
  }

  private syncScrubber(): void {
    const dur = this.effectiveDuration();
    const pct = dur > 0 ? this.audio.currentTime / dur : 0;
    this.scrubber.value = String(Math.round(pct * 1000));
    this.setTime(this.audio.currentTime, dur);
  }

  private setTime(current: number, total: number): void {
    this.timeEl.textContent = `${fmtSec(current)} / ${fmtSec(total)}`;
  }
}
