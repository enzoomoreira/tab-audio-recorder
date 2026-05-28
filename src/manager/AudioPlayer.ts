const SVG_PLAY = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 12 12" fill="currentColor">
  <path d="M2 1.5l9 4.5-9 4.5V1.5z"/>
</svg>`;

const SVG_PAUSE = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 12 12" fill="currentColor">
  <rect x="2" y="1" width="3" height="10" rx="1"/>
  <rect x="7" y="1" width="3" height="10" rx="1"/>
</svg>`;

function fmtSec(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class AudioPlayer {
  private audio = new Audio();
  private btn: HTMLButtonElement;
  private scrubber: HTMLInputElement;
  private timeEl: HTMLSpanElement;
  private knownDurationSec: number;
  private scrubbing = false;

  constructor(container: HTMLElement, knownDurationMs: number) {
    this.knownDurationSec = knownDurationMs / 1000;

    this.btn = container.querySelector<HTMLButtonElement>('.player__btn')!;
    this.scrubber = container.querySelector<HTMLInputElement>('.player__scrubber')!;
    this.timeEl = container.querySelector<HTMLSpanElement>('.player__time')!;

    this.btn.innerHTML = SVG_PLAY;
    this.setTime(0, this.knownDurationSec);

    this.audio.addEventListener('play', () => {
      this.btn.innerHTML = SVG_PAUSE;
      this.btn.setAttribute('aria-label', 'Pause');
    });
    this.audio.addEventListener('pause', () => {
      this.btn.innerHTML = SVG_PLAY;
      this.btn.setAttribute('aria-label', 'Play');
    });
    this.audio.addEventListener('timeupdate', () => {
      if (!this.scrubbing) this.syncScrubber();
    });
    this.audio.addEventListener('ended', () => {
      this.scrubber.value = '0';
      this.btn.innerHTML = SVG_PLAY;
      this.btn.setAttribute('aria-label', 'Play');
      this.setTime(0, this.effectiveDuration());
    });

    this.btn.addEventListener('click', () => {
      if (this.audio.paused) void this.audio.play();
      else this.audio.pause();
    });

    // Scrubbing: block timeupdate updates while dragging
    this.scrubber.addEventListener('mousedown', () => { this.scrubbing = true; });
    this.scrubber.addEventListener('touchstart', () => { this.scrubbing = true; });
    this.scrubber.addEventListener('input', () => {
      const pct = Number(this.scrubber.value) / 1000;
      const dur = this.effectiveDuration();
      this.setTime(pct * dur, dur);
    });
    this.scrubber.addEventListener('change', () => {
      this.scrubbing = false;
      const pct = Number(this.scrubber.value) / 1000;
      const dur = this.effectiveDuration();
      if (isFinite(dur) && dur > 0) {
        this.audio.currentTime = pct * dur;
      }
    });
  }

  load(url: string): void {
    this.audio.src = url;
    this.audio.preload = 'metadata';
  }

  play(): void {
    void this.audio.play();
  }

  destroy(): void {
    this.audio.pause();
    this.audio.src = '';
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
