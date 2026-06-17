// Runs in MAIN world at document_start (declared in manifest with "world": "MAIN").
// No imports -- must be entirely self-contained. No access to browser.* APIs.
// Communicates with the ISOLATED content script via window.postMessage.
//
// This is Strategy 1 (element capture). Patching HTMLMediaElement.prototype.play
// in the MAIN world lets us track EVERY media element the page plays -- including
// detached `new Audio()` elements that are never inserted into the DOM (e.g.
// WhatsApp Web voice messages) and elements inside closed shadow roots, neither
// of which a DOM scan from the ISOLATED world can reach.

(() => {
  const TAG = 'tab-audio-recorder';
  const TAG_PAGE = 'tab-audio-recorder-page';

  type Flag = { __tabAudioRecorderMediaHookLoaded?: boolean };
  if ((window as unknown as Flag).__tabAudioRecorderMediaHookLoaded) return;
  (window as unknown as Flag).__tabAudioRecorderMediaHookLoaded = true;

  // Most-recently-played media elements (attached or detached), most recent last.
  // Capped so a long-lived page creating many elements cannot grow this unbounded
  // (holding the references would also pin detached elements against GC).
  const MAX_TRACKED = 16;
  const tracked: HTMLMediaElement[] = [];

  function remember(el: HTMLMediaElement): void {
    const at = tracked.indexOf(el);
    if (at !== -1) tracked.splice(at, 1);
    tracked.push(el);
    if (tracked.length > MAX_TRACKED) tracked.shift();
  }

  // Patch play() before any page script runs (document_start guarantees this),
  // so we observe the very first playback of every element. When armed, this is
  // also the trigger point: capture starts synchronously here, with no round-trip
  // to the background, so the recording catches the audio from sample zero.
  type PlayFn = (this: HTMLMediaElement) => Promise<void>;
  const OrigPlay = HTMLMediaElement.prototype.play as PlayFn;
  const wrappedPlay: PlayFn = function (this: HTMLMediaElement) {
    try {
      remember(this);
      if (armed) {
        armed = false;
        void handleArmedStart(this, armBitrate);
      }
    } catch {
      // Tracking and arming must never break the page's own playback.
    }
    return OrigPlay.call(this);
  };
  (HTMLMediaElement.prototype as unknown as { play: PlayFn }).play = wrappedPlay;

  function isPlaying(el: HTMLMediaElement): boolean {
    return !el.paused && el.readyState >= 2; // HAVE_CURRENT_DATA
  }

  function pickElement(): HTMLMediaElement | null {
    // Prefer something actually playing (video first -- it carries the audio we
    // want, matching the old DOM-scan priority), else the most recently played.
    const playing = tracked.filter(isPlaying);
    const playingVideo = playing.find((e) => e.tagName === 'VIDEO');
    if (playingVideo) return playingVideo;
    return playing.at(-1) ?? tracked.at(-1) ?? null;
  }

  type WithCapture = { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  function captureFrom(el: HTMLMediaElement): MediaStream {
    const c = el as unknown as WithCapture;
    if (typeof c.captureStream === 'function') return c.captureStream();
    if (typeof c.mozCaptureStream === 'function') return c.mozCaptureStream();
    throw new Error('captureStream not available on this element');
  }

  // captureStream() at the instant playback starts can return a stream whose
  // audio track has not been added yet (element readyState 0). Wait briefly.
  function waitForAudioTrack(
    el: HTMLMediaElement,
    stream: MediaStream,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      if (stream.getAudioTracks().length > 0) {
        resolve();
        return;
      }
      const cleanup = (): void => {
        clearTimeout(timer);
        stream.removeEventListener('addtrack', onAdd);
        el.removeEventListener('playing', onPlaying);
      };
      const done = (): void => {
        cleanup();
        resolve();
      };
      const onAdd = (e: MediaStreamTrackEvent): void => {
        if (e.track.kind === 'audio') done();
      };
      const onPlaying = (): void => {
        if (stream.getAudioTracks().length > 0) done();
      };
      const timer = setTimeout(done, timeoutMs);
      stream.addEventListener('addtrack', onAdd);
      el.addEventListener('playing', onPlaying);
    });
  }

  function pickMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
    ];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  // --- Recording state (one at a time per page) ---
  let activeRecorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;
  let mimeType = '';
  // Arm state: when set, the next play() auto-captures that element.
  let armed = false;
  let armBitrate = 128_000;

  function reply(payload: Record<string, unknown>): void {
    window.postMessage({ source: TAG_PAGE, ...payload }, window.location.origin);
  }

  // Sets up and starts a MediaRecorder over `el`'s captured audio. Shared by the
  // explicit start path (handleStart) and the armed auto-start path
  // (handleArmedStart). Returns the outcome; the caller sends the matching reply.
  async function beginCapture(
    el: HTMLMediaElement,
    bitrate: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // EME/DRM-protected playback yields a silent capture stream in Firefox.
    // Surface this up-front instead of recording silence.
    if ((el as unknown as { mediaKeys?: unknown }).mediaKeys != null) {
      return { ok: false, error: 'DRM/EME content cannot be captured (Firefox security policy)' };
    }
    try {
      const stream = captureFrom(el);
      if (stream.getAudioTracks().length === 0) {
        await waitForAudioTrack(el, stream, 3000);
      }
      // A <video> capture also carries a video track, which MediaRecorder rejects
      // under an audio-only mimeType -- record an audio-only stream.
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        return { ok: false, error: 'Media element has no audio tracks' };
      }
      const audioOnly = new MediaStream(audioTracks);
      mimeType = pickMimeType();
      const opts: MediaRecorderOptions = { audioBitsPerSecond: bitrate };
      if (mimeType) opts.mimeType = mimeType;
      activeRecorder = new MediaRecorder(audioOnly, opts);
      mimeType = activeRecorder.mimeType;
      chunks = [];
      activeRecorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunks.push(ev.data);
      };
      // Spontaneous mid-capture failures. The STOP handler installs its own
      // onstop/onerror, so this only fires while actively recording.
      activeRecorder.onerror = (ev) => {
        const err = (ev as Event & { error?: { message?: string } }).error;
        activeRecorder = null;
        chunks = [];
        reply({ type: 'EL_ERROR', error: `MediaRecorder error: ${err?.message ?? 'unknown'}` });
      };
      startedAt = Date.now();
      activeRecorder.start(1000);
      return { ok: true };
    } catch (err) {
      activeRecorder = null;
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function handleStart(bitrate: number): Promise<void> {
    if (activeRecorder) {
      reply({ type: 'EL_STARTED', ok: false, error: 'Already recording' });
      return;
    }
    const el = pickElement();
    if (!el) {
      reply({ type: 'EL_STARTED', ok: false, error: 'No media element found on this page' });
      return;
    }
    reply({ type: 'EL_STARTED', ...(await beginCapture(el, bitrate)) });
  }

  // Auto-start triggered from the patched play() while armed. Captures the exact
  // element that the user played (no pickElement heuristic needed). The reply is
  // spontaneous (not awaited by the ISOLATED driver), so it routes through the
  // EL_ARM_FIRED passive listener there.
  async function handleArmedStart(el: HTMLMediaElement, bitrate: number): Promise<void> {
    if (activeRecorder) {
      reply({ type: 'EL_ARM_FIRED', ok: false, error: 'Already recording' });
      return;
    }
    reply({ type: 'EL_ARM_FIRED', ...(await beginCapture(el, bitrate)) });
  }

  // Stop and discard an in-flight capture without producing a blob. Used when a
  // multi-frame arm race causes a losing frame to start a recording the
  // background has already superseded.
  function handleAbort(): void {
    if (!activeRecorder) return;
    const rec = activeRecorder;
    activeRecorder = null;
    chunks = [];
    rec.ondataavailable = null;
    rec.onerror = null;
    rec.onstop = null;
    try {
      rec.stop();
    } catch {
      // Already stopped; nothing to discard.
    }
  }

  function handleStop(): void {
    if (!activeRecorder) {
      reply({ type: 'EL_STOPPED', ok: false, error: 'Not recording' });
      return;
    }
    const rec = activeRecorder;
    rec.onstop = () => {
      const endedAt = Date.now();
      const blob = new Blob(chunks, { type: mimeType });
      activeRecorder = null;
      chunks = [];
      reply({
        type: 'EL_STOPPED',
        ok: true,
        blob,
        mimeType,
        durationMs: endedAt - startedAt,
        startedAt,
        endedAt,
      });
    };
    rec.onerror = (ev) => {
      activeRecorder = null;
      chunks = [];
      const err = (ev as Event & { error?: { message?: string } }).error;
      reply({
        type: 'EL_STOPPED',
        ok: false,
        error: `MediaRecorder error: ${err?.message ?? 'unknown'}`,
      });
    };
    rec.stop();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; type?: string; bitrate?: number } | null;
    if (!data || data.source !== TAG) return;

    if (data.type === 'EL_PROBE') {
      reply({
        type: 'EL_PROBE_RESULT',
        found: tracked.length > 0,
        playing: tracked.some(isPlaying),
      });
    } else if (data.type === 'EL_START') {
      void handleStart(data.bitrate ?? 128_000);
    } else if (data.type === 'EL_STOP') {
      handleStop();
    } else if (data.type === 'EL_ARM') {
      armed = true;
      armBitrate = data.bitrate ?? 128_000;
    } else if (data.type === 'EL_DISARM') {
      armed = false;
    } else if (data.type === 'EL_ABORT') {
      handleAbort();
    }
  });
})();
