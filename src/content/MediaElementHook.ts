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

  function observePlayback(el: HTMLMediaElement): void {
    remember(el);
    if (armed) {
      armed = false;
      void handleArmedStart(el, armBitrate);
    }
  }

  // Native controls and autoplay do not call the JavaScript play() wrapper.
  document.addEventListener(
    'play',
    (event) => {
      if (event.target instanceof HTMLMediaElement) observePlayback(event.target);
    },
    true,
  );

  // Patch play() before any page script runs (document_start guarantees this),
  // so we observe the very first playback of every element. When armed, this is
  // also the trigger point: capture starts synchronously here, with no round-trip
  // to the background, reducing the delay before capture starts.
  type PlayFn = (this: HTMLMediaElement) => Promise<void>;
  const OrigPlay = HTMLMediaElement.prototype.play as PlayFn;
  const wrappedPlay: PlayFn = function (this: HTMLMediaElement) {
    try {
      observePlayback(this);
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
  let captureId = '';
  let chunkCount = 0;
  let pendingBytes = 0;
  let stopping = false;
  const pending = new Map<number, { size: number; timer: ReturnType<typeof setTimeout> }>();

  function clearPending(): void {
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    pendingBytes = 0;
  }

  function failCapture(error: string): void {
    const rec = activeRecorder;
    activeRecorder = null;
    clearPending();
    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = null;
      rec.onerror = null;
      if (rec.state !== 'inactive') rec.stop();
    }
    releaseStream();
    reply({ type: stopping ? 'EL_STOPPED' : 'EL_ERROR', captureId, ok: false, error });
  }

  function emitChunk(blob: Blob): void {
    if (!blob.size) return;
    if (pending.size >= 16 || pendingBytes + blob.size > 8 * 1024 * 1024) {
      failCapture('Recording storage cannot keep up; capture stopped to preserve saved audio');
      return;
    }
    const sequence = chunkCount++;
    pendingBytes += blob.size;
    const timer = setTimeout(
      (): void => failCapture('Recording storage acknowledgment timed out'),
      10_000,
    );
    pending.set(sequence, { size: blob.size, timer });
    reply({ type: 'EL_CHUNK', captureId, sequence, blob, startedAt, endedAt: Date.now() });
  }
  let startedAt = 0;
  let mimeType = '';
  let stoppedAt = 0;
  let starting = false;
  let generation = 0;
  let capturedStream: MediaStream | null = null;

  function releaseStream(): void {
    capturedStream?.getTracks().forEach((track) => track.stop());
    capturedStream = null;
  }
  // Arm state: when set, the next play() auto-captures that element.
  let armed = false;
  let armBitrate = 128_000;

  function reply(payload: Record<string, unknown>): void {
    window.postMessage({ source: TAG_PAGE, captureId, ...payload }, window.location.origin);
  }

  // Sets up and starts a MediaRecorder over `el`'s captured audio. Shared by the
  // explicit start path (handleStart) and the armed auto-start path
  // (handleArmedStart). Returns the outcome; the caller sends the matching reply.
  async function beginCapture(
    el: HTMLMediaElement,
    bitrate: number,
    id: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // EME/DRM-protected playback yields a silent capture stream in Firefox.
    // Surface this up-front instead of recording silence.
    if ((el as unknown as { mediaKeys?: unknown }).mediaKeys != null) {
      return { ok: false, error: 'DRM/EME content cannot be captured (Firefox security policy)' };
    }
    captureId = id;
    starting = true;
    const attempt = generation;
    try {
      const stream = captureFrom(el);
      capturedStream = stream;
      if (stream.getAudioTracks().length === 0) {
        await waitForAudioTrack(el, stream, 3000);
      }
      if (attempt !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        return { ok: false, error: 'Capture cancelled' };
      }
      // A <video> capture also carries a video track, which MediaRecorder rejects
      // under an audio-only mimeType -- record an audio-only stream.
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        releaseStream();
        return { ok: false, error: 'Media element has no audio tracks' };
      }
      const audioOnly = new MediaStream(audioTracks);
      mimeType = pickMimeType();
      const opts: MediaRecorderOptions = { audioBitsPerSecond: bitrate };
      if (mimeType) opts.mimeType = mimeType;
      activeRecorder = new MediaRecorder(audioOnly, opts);
      mimeType = activeRecorder.mimeType;
      chunkCount = 0;
      stopping = false;
      clearPending();
      stoppedAt = 0;
      activeRecorder.onstop = () => {
        stoppedAt = Date.now();
        releaseStream();
      };
      activeRecorder.ondataavailable = (ev) => {
        emitChunk(ev.data);
      };
      // Spontaneous mid-capture failures. The STOP handler installs its own
      // onstop/onerror, so this only fires while actively recording.
      activeRecorder.onerror = (ev): void => {
        const err = (ev as Event & { error?: { message?: string } }).error;
        failCapture(`MediaRecorder error: ${err?.message ?? 'unknown'}`);
      };
      startedAt = Date.now();
      activeRecorder.start(1000);
      return { ok: true };
    } catch (err) {
      activeRecorder = null;
      releaseStream();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (attempt === generation) starting = false;
    }
  }

  async function handleStart(bitrate: number, id: string): Promise<void> {
    if (activeRecorder || starting) {
      reply({ type: 'EL_STARTED', captureId: id, ok: false, error: 'Already recording' });
      return;
    }
    const el = pickElement();
    if (!el) {
      reply({
        type: 'EL_STARTED',
        captureId: id,
        ok: false,
        error: 'No media element found on this page',
      });
      return;
    }
    reply({ type: 'EL_STARTED', captureId: id, ...(await beginCapture(el, bitrate, id)) });
  }

  // Auto-start triggered from the patched play() while armed. Captures the exact
  // element that the user played (no pickElement heuristic needed). The reply is
  // spontaneous (not awaited by the ISOLATED driver), so it routes through the
  // EL_ARM_FIRED passive listener there.
  async function handleArmedStart(el: HTMLMediaElement, bitrate: number): Promise<void> {
    const id = captureId;
    if (activeRecorder || starting) {
      reply({ type: 'EL_ARM_FIRED', captureId: id, ok: false, error: 'Already recording' });
      return;
    }
    reply({ type: 'EL_ARM_FIRED', captureId: id, ...(await beginCapture(el, bitrate, id)) });
  }

  // Stop and discard an in-flight capture without producing a blob. Used when a
  // multi-frame arm race causes a losing frame to start a recording the
  // background has already superseded.
  function handleAbort(): void {
    generation++;
    starting = false;
    armed = false;
    releaseStream();
    if (!activeRecorder) return;
    const rec = activeRecorder;
    activeRecorder = null;
    clearPending();
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
    stopping = true;
    const rec = activeRecorder;
    const finalize = (): void => {
      const endedAt = stoppedAt || Date.now();

      activeRecorder = null;
      clearPending();
      releaseStream();
      reply({
        type: 'EL_STOPPED',
        ok: true,
        captureId,
        chunkCount,
        mimeType,
        durationMs: endedAt - startedAt,
        startedAt,
        endedAt,
      });
    };
    rec.onstop = finalize;
    rec.onerror = (ev): void => {
      const err = (ev as Event & { error?: { message?: string } }).error;
      failCapture(`MediaRecorder error: ${err?.message ?? 'unknown'}`);
    };
    if (stoppedAt) finalize();
    else if (rec.state !== 'inactive') rec.stop();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as {
      source?: string;
      type?: string;
      bitrate?: number;
      captureId?: string;
      sequence?: number;
      ok?: boolean;
      error?: string;
    } | null;
    if (!data || data.source !== TAG) return;
    if (
      ['EL_STOP', 'EL_ABORT', 'EL_DISARM'].includes(data.type ?? '') &&
      data.captureId !== captureId
    )
      return;
    if (data.type === 'EL_CHUNK_ACK') {
      if (data.captureId !== captureId || data.sequence === undefined) return;
      const item = pending.get(data.sequence);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(data.sequence);
      pendingBytes -= item.size;
      if (!data.ok) failCapture(data.error ?? 'Recording chunk could not be saved');
      return;
    }

    if (data.type === 'EL_PROBE') {
      reply({
        type: 'EL_PROBE_RESULT',
        found: tracked.length > 0,
        playing: tracked.some(isPlaying),
      });
    } else if (data.type === 'EL_START') {
      void handleStart(data.bitrate ?? 128_000, data.captureId ?? '');
    } else if (data.type === 'EL_STOP') {
      handleStop();
    } else if (data.type === 'EL_ARM') {
      captureId = data.captureId ?? '';
      armed = true;
      armBitrate = data.bitrate ?? 128_000;
    } else if (data.type === 'EL_DISARM') {
      armed = false;
      if (starting) handleAbort();
    } else if (data.type === 'EL_ABORT') {
      handleAbort();
    }
  });
})();
