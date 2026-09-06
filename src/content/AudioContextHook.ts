// Runs in MAIN world at document_start (declared in manifest with "world": "MAIN").
// No imports -- must be entirely self-contained. No access to browser.* APIs.
// Communicates with the ISOLATED content script via window.postMessage.

(() => {
  const TAG = 'tab-audio-recorder';
  const TAG_PAGE = 'tab-audio-recorder-page';

  type Flag = { __tabAudioRecorderHookLoaded?: boolean };
  if ((window as unknown as Flag).__tabAudioRecorderHookLoaded) return;
  (window as unknown as Flag).__tabAudioRecorderHookLoaded = true;

  const taps = new WeakMap<AudioContext, MediaStreamAudioDestinationNode>();
  const allContexts = new Set<AudioContext>();

  function getTap(ctx: AudioContext): MediaStreamAudioDestinationNode {
    let tap = taps.get(ctx);
    if (!tap) {
      tap = ctx.createMediaStreamDestination();
      taps.set(ctx, tap);
    }
    return tap;
  }

  // Mirror every connection to a destination node into our per-context tap.
  // This must run before any page script creates and connects nodes -- document_start guarantees that.
  const OrigConnect = AudioNode.prototype.connect;
  const OrigDisconnect = AudioNode.prototype.disconnect;
  const apply = (fn: unknown, self: unknown, args: unknown[]): unknown =>
    (fn as (...a: unknown[]) => unknown).apply(self, args);

  type ConnectFn = (
    this: AudioNode,
    target: AudioNode | AudioParam,
    output?: number,
    input?: number,
  ) => AudioNode | void;
  const wrappedConnect: ConnectFn = function (this, target, output, input) {
    const args: unknown[] = [target];
    if (output !== undefined) args.push(output);
    if (input !== undefined) args.push(input);
    const result = apply(OrigConnect, this, args);
    try {
      if (target instanceof AudioDestinationNode) {
        const tap = getTap(target.context as AudioContext);
        // Preserve `output` index so split graphs (e.g. ChannelSplitter pipes
        // separate outputs to destination) mirror the right channel. Tap input
        // is always 0 (MediaStreamAudioDestinationNode has a single input).
        const tapArgs: unknown[] = [tap];
        if (output !== undefined) tapArgs.push(output);
        apply(OrigConnect, this, tapArgs);
      }
    } catch {
      // Mirroring must never break the page audio graph.
    }
    return result as AudioNode | void;
  };
  (AudioNode.prototype as unknown as { connect: ConnectFn }).connect = wrappedConnect;

  // Mirror disconnects so dynamic graphs (DAWs, sequencers) keep recording
  // in sync with what the user is actually hearing.
  type DisconnectFn = (this: AudioNode, ...args: unknown[]) => void;
  const wrappedDisconnect: DisconnectFn = function (this, ...args) {
    apply(OrigDisconnect, this, args);
    try {
      // Cases that already cover the tap implicitly:
      //   disconnect()                      -- removes all outgoing, including tap
      //   disconnect(outputNumber)          -- removes everything from that output, including tap
      // Cases that need an explicit mirror:
      //   disconnect(destination[, output[, input]])
      const first = args[0];
      if (first instanceof AudioDestinationNode) {
        const tap = taps.get(first.context as AudioContext);
        if (tap) {
          const mirrorArgs: unknown[] = [tap];
          if (typeof args[1] === 'number') mirrorArgs.push(args[1]);
          // Skip args[2] (input index) -- tap only has input 0.
          apply(OrigDisconnect, this, mirrorArgs);
        }
      }
    } catch {
      // Never break the page audio graph.
    }
  };
  (AudioNode.prototype as unknown as { disconnect: DisconnectFn }).disconnect = wrappedDisconnect;

  function wrapCtor<T extends typeof AudioContext>(Original: T): T {
    function Wrapped(this: AudioContext, ...args: unknown[]) {
      const target = (new.target ?? Wrapped) as unknown as new (...a: unknown[]) => AudioContext;
      const instance = Reflect.construct(Original, args, target) as AudioContext;
      allContexts.add(instance);
      return instance;
    }
    Wrapped.prototype = Original.prototype;
    Object.setPrototypeOf(Wrapped, Original);
    return Wrapped as unknown as T;
  }

  if (typeof AudioContext === 'function') {
    (window as { AudioContext: typeof AudioContext }).AudioContext = wrapCtor(AudioContext);
  }
  type WebkitWin = { webkitAudioContext?: typeof AudioContext };
  const w = window as unknown as WebkitWin;
  if (typeof w.webkitAudioContext === 'function') {
    w.webkitAudioContext = wrapCtor(w.webkitAudioContext);
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

    reply({ type: stopping ? 'STOPPED' : 'ERROR', captureId, ok: false, error });
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
    reply({ type: 'CHUNK', captureId, sequence, blob, startedAt, endedAt: Date.now() });
  }
  let startedAt = 0;
  let mimeType = '';
  let stoppedAt = 0;

  function pickContext(): AudioContext | null {
    for (const ctx of allContexts) {
      if (ctx.state === 'closed') allContexts.delete(ctx);
    }
    for (const ctx of allContexts) {
      if (ctx.state === 'running') return ctx;
    }
    for (const ctx of allContexts) return ctx;
    return null;
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

  function reply(payload: Record<string, unknown>): void {
    window.postMessage({ source: TAG_PAGE, captureId, ...payload }, window.location.origin);
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
    if (['STOP', 'ABORT'].includes(data.type ?? '') && data.captureId !== captureId) return;
    if (data.type === 'CHUNK_ACK') {
      if (data.captureId !== captureId || data.sequence === undefined) return;
      const item = pending.get(data.sequence);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(data.sequence);
      pendingBytes -= item.size;
      if (!data.ok) failCapture(data.error ?? 'Recording chunk could not be saved');
      return;
    }

    if (data.type === 'PROBE') {
      reply({ type: 'PROBE_RESULT', hasContexts: pickContext() !== null });
      return;
    }

    if (data.type === 'ABORT') {
      const rec = activeRecorder;
      activeRecorder = null;
      clearPending();
      if (rec) {
        rec.ondataavailable = null;
        rec.onerror = null;
        rec.onstop = null;
        if (rec.state !== 'inactive') rec.stop();
      }
      return;
    }

    if (data.type === 'START') {
      if (activeRecorder) {
        reply({
          type: 'STARTED',
          captureId: data.captureId,
          ok: false,
          error: 'Already recording',
        });
        return;
      }
      const ctx = pickContext();
      if (!ctx) {
        reply({
          type: 'STARTED',
          captureId: data.captureId,
          ok: false,
          error: 'No AudioContext detected',
        });
        return;
      }
      try {
        const tap = getTap(ctx);
        mimeType = pickMimeType();
        const opts: MediaRecorderOptions = { audioBitsPerSecond: data.bitrate ?? 128_000 };
        if (mimeType) opts.mimeType = mimeType;
        activeRecorder = new MediaRecorder(tap.stream, opts);
        mimeType = activeRecorder.mimeType;
        captureId = data.captureId ?? '';
        chunkCount = 0;
        stopping = false;
        clearPending();
        stoppedAt = 0;
        activeRecorder.onstop = () => {
          stoppedAt = Date.now();
        };
        activeRecorder.ondataavailable = (ev) => {
          emitChunk(ev.data);
        };
        // Spontaneous mid-capture failures. The STOP handler installs its own
        // onerror, so this only fires while actively recording.
        activeRecorder.onerror = (ev): void => {
          const err = (ev as Event & { error?: { message?: string } }).error;
          failCapture(`MediaRecorder error: ${err?.message ?? 'unknown'}`);
        };
        startedAt = Date.now();
        activeRecorder.start(1000);
        reply({ type: 'STARTED', captureId: data.captureId, ok: true });
      } catch (err) {
        activeRecorder = null;
        clearPending();
        reply({
          type: 'STARTED',
          captureId: data.captureId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (data.type === 'STOP') {
      if (!activeRecorder) {
        reply({ type: 'STOPPED', ok: false, error: 'Not recording' });
        return;
      }
      stopping = true;
      const rec = activeRecorder;
      const finalize = (): void => {
        const endedAt = stoppedAt || Date.now();
        activeRecorder = null;
        clearPending();
        reply({
          type: 'STOPPED',
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
      if (stoppedAt) finalize();
      else if (rec.state !== 'inactive') rec.stop();
    }
  });
})();
