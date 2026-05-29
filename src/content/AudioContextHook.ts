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
  let chunks: Blob[] = [];
  let startedAt = 0;
  let mimeType = '';

  function pickContext(): AudioContext | null {
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
    window.postMessage({ source: TAG_PAGE, ...payload }, window.location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; type?: string; bitrate?: number } | null;
    if (!data || data.source !== TAG) return;

    if (data.type === 'PROBE') {
      reply({ type: 'PROBE_RESULT', hasContexts: allContexts.size > 0 });
      return;
    }

    if (data.type === 'START') {
      if (activeRecorder) {
        reply({ type: 'STARTED', ok: false, error: 'Already recording' });
        return;
      }
      const ctx = pickContext();
      if (!ctx) {
        reply({ type: 'STARTED', ok: false, error: 'No AudioContext detected' });
        return;
      }
      try {
        const tap = getTap(ctx);
        mimeType = pickMimeType();
        const opts: MediaRecorderOptions = { audioBitsPerSecond: data.bitrate ?? 128_000 };
        if (mimeType) opts.mimeType = mimeType;
        activeRecorder = new MediaRecorder(tap.stream, opts);
        mimeType = activeRecorder.mimeType;
        chunks = [];
        activeRecorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) chunks.push(ev.data);
        };
        // Spontaneous mid-capture failures. The STOP handler installs its own
        // onerror, so this only fires while actively recording.
        activeRecorder.onerror = (ev) => {
          const err = (ev as Event & { error?: { message?: string } }).error;
          activeRecorder = null;
          chunks = [];
          reply({ type: 'ERROR', error: `MediaRecorder error: ${err?.message ?? 'unknown'}` });
        };
        startedAt = Date.now();
        activeRecorder.start(1000);
        reply({ type: 'STARTED', ok: true });
      } catch (err) {
        activeRecorder = null;
        const msg = err instanceof Error ? err.message : String(err);
        reply({ type: 'STARTED', ok: false, error: msg });
      }
      return;
    }

    if (data.type === 'STOP') {
      if (!activeRecorder) {
        reply({ type: 'STOPPED', ok: false, error: 'Not recording' });
        return;
      }
      const rec = activeRecorder;
      rec.onstop = () => {
        const endedAt = Date.now();
        const blob = new Blob(chunks, { type: mimeType });
        activeRecorder = null;
        chunks = [];
        reply({
          type: 'STOPPED',
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
          type: 'STOPPED',
          ok: false,
          error: `MediaRecorder error: ${err?.message ?? 'unknown'}`,
        });
      };
      rec.stop();
      return;
    }
  });
})();
