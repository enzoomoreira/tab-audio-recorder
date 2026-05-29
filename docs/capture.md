# Capture strategies

A single Record button has to work across wildly different sites: a plain
`<audio>` tag, a YouTube-style `<video>`, a web radio that streams MP3 over the
network, and a synth that plays purely through the Web Audio API. Tab Audio
Recorder handles this with **three capture strategies tried in order**, each a
fallback for the previous one. This document explains the order, what each
strategy needs, and the per-strategy implementation details.

The selection logic lives in `Orchestrator.startRecording`
(`src/background/Orchestrator.ts:144`). The actual capture runs in the content
script (`src/content/index.ts`), which instantiates one of the three recorder
classes.

## Strategy order and selection

```
startRecording(tabId)
  1. findFrameWithMedia(tabId)              -> a frame with an <audio>/<video>?
        yes -> START_CAPTURE (DOM)          -> StreamRecorder
  2. findFrameWithStreamURL(tabId)          -> a sniffed audio stream URL?
        yes -> START_NETWORK_CAPTURE        -> NetworkRecorder
  3. for each frame: START_WEBAUDIO_CAPTURE -> probe AudioContext, tap it
        yes -> WebAudioRecorder
  none -> { ok: false, error: 'No audio source detected ...' }
```

The order is deliberate: DOM `captureStream` is the highest-fidelity and most
common case, network fetch is exact when a discrete stream URL exists, and the
Web Audio tap is the catch-all for synthesized audio that never touches a media
element. The first strategy that returns `{ ok: true }` wins; the tab is marked
`recording` and the optional max-duration timer is armed.

### Frame routing

Audio can live in any frame, so capture is addressed per `frameId`, not per tab:

- `listFrameIds(tabId)` enumerates frames via `browser.webNavigation.getAllFrames`
  and sorts them **top frame (0) first**, so the top document is preferred when
  several frames have media.
- `findFrameWithMedia` sends `CHECK_MEDIA` to each frame and returns the first
  that answers `{ found: true }`. Frames without our content script (e.g.
  `about:`, `chrome://`) simply throw and are skipped.
- The chosen `frameId` is stored in `SessionState` (`activeFrame`) so `STOP_CAPTURE`
  later reaches the exact frame that is recording.

This is why both content scripts are injected with `all_frames: true`: a
cross-origin iframe is unreachable from the top document's DOM, but the browser
still injects our content script into it, and `frameId` routing delivers
start/stop to it directly.

## Strategy 1: DOM element (`captureStream`)

Used when the page has an `<audio>` or `<video>` element. Two pieces:
`DOMScanner` finds the element, `StreamRecorder` records it.

### DOMScanner (`src/content/DOMScanner.ts`)

Recursively scans for media elements and returns the best candidate:

- **Search scope, per frame:** the document, every open **Shadow DOM** root
  (walked recursively), and every **same-origin iframe** (cross-origin iframes
  throw on `contentDocument` access and are skipped — they are covered by the
  `all_frames` injection + frame routing above). Recursion is bounded by
  `MAX_SCAN_DEPTH = 8` and a visited-document set guards against cycles.
- **Priority:** playing `<video>` > playing `<audio>` > any `<video>` > any
  `<audio>`. "Playing" means `!paused && readyState >= HAVE_CURRENT_DATA`.
- `hasMedia()` is just `find() !== null`; it answers the `CHECK_MEDIA` probe.
- `diagnose()` returns a `DiagnosticReport` listing every element found (direct,
  shadow, iframe) with its `src`, `paused`, `readyState`, `duration` — the
  payload behind the `DIAGNOSE` debug message.

### StreamRecorder (`src/content/StreamRecorder.ts`)

Wraps `MediaRecorder` over the element's captured stream. The fiddly parts, each
there for a concrete reason:

- **Firefox Xray wrapper.** Content scripts see a security wrapper around page
  objects; `element.wrappedJSObject` (falling back to the element itself) is used
  to reach the real `captureStream` / `mozCaptureStream`.
- **Audio-only stream rebuild.** A `<video>` captureStream carries both audio and
  video tracks, and `MediaRecorder` rejects a video track under an audio-only
  mimeType. The recorder builds a fresh `MediaStream` from `getAudioTracks()`
  only. (This is the "YouTube bug" the E2E test `02-video-with-audio` guards
  against.) A stream with zero audio tracks throws.
- **DRM/EME refusal.** If the element has `mediaKeys`, capture would yield
  silence under Firefox's EME policy, so it is refused up front with a clear
  error instead of saving a silent file. (E2E: `13-drm-fake`.)
- **MIME selection.** Picks the first supported of
  `audio/webm;codecs=opus`, `audio/webm`, `audio/ogg;codecs=opus`, `audio/ogg`.
- **Chunking.** `recorder.start(1000)` emits a data chunk every second; chunks
  accumulate and are assembled into one `Blob` on stop.
- **Spontaneous errors.** A mid-capture `onerror` (not triggered by stop) clears
  local state and fires the `onError` callback, which the content script forwards
  as `RECORDING_ERROR`.

## Strategy 2: Network stream (fetch)

Used when there is no media element but the page is pulling a discrete audio
stream over the network (typical of web radios).

### Detection (`src/background/index.ts`)

`browser.webRequest.onHeadersReceived` watches every response and inspects its
`Content-Type`. When it starts with `audio/`, or contains `mpegURL` (HLS) or
`ogg`, the URL is cached for that `(tabId, frameId)` via
`Orchestrator.onMediaURLDetected` -> `SessionState.addStreamURL`. This runs
continuously in the background, so by the time the user clicks Record the URL is
usually already cached.

`findFrameWithStreamURL` then prefers the top frame's cached URL, falling back to
the first frame that has one.

### NetworkRecorder (`src/content/NetworkRecorder.ts`)

- `fetch(url, { signal })` with an `AbortController`; the response body is read
  chunk by chunk into a `Uint8Array[]`.
- `stop()` aborts the fetch, waits for the read loop to drain, concatenates the
  chunks into one `Blob`, and reports duration from wall-clock start/end.
- MIME type is guessed from the URL extension (`.ogg`/`.opus` -> `audio/ogg`,
  `.aac` -> `audio/aac`, `.webm` -> `audio/webm`, else `audio/mpeg`).
- A failed or interrupted fetch (non-OK status, network error) fires `onError`;
  a normal abort from `stop()` is silent.

This strategy records the raw stream bytes as delivered — it does not go through
`MediaRecorder`.

## Strategy 3: Web Audio API hook

Used as the catch-all when a page synthesizes sound through the Web Audio API and
never creates a media element (synths, sequencers, game audio, some DAWs). This
is the only strategy that needs code in the page's **MAIN** world, because the
`AudioContext` instances are page objects the ISOLATED content script cannot
reach directly.

### AudioContextHook (`src/content/AudioContextHook.ts`) — MAIN world

Runs at `document_start` so it patches things **before** the page builds its
graph. It is fully self-contained (no imports, no `browser.*`). What it does:

- **Wraps `AudioNode.prototype.connect`.** Whenever any node connects to an
  `AudioDestinationNode` (the speakers), the hook also connects it to a
  per-context `MediaStreamAudioDestinationNode` ("the tap"). The original
  `output` index is preserved so split graphs mirror the right channel. Mirroring
  is wrapped in try/catch and must never break the page's real audio.
- **Wraps `AudioNode.prototype.disconnect`** symmetrically, so dynamic graphs
  (DAWs, sequencers) keep the tap in sync with what the user actually hears.
- **Wraps the `AudioContext` / `webkitAudioContext` constructors** so every
  context the page creates is tracked in a set.
- On `START`, it picks a running context (or any context), builds a
  `MediaRecorder` over the tap's stream, and records — same MIME selection and
  1-second chunking as `StreamRecorder`.

### WebAudioRecorder (`src/content/WebAudioRecorder.ts`) — ISOLATED world

The ISOLATED-world half that the orchestrator drives. Because it cannot call into
the MAIN world directly, it speaks a small `window.postMessage` protocol:

| ISOLATED -> MAIN (`tab-audio-recorder`) | MAIN -> ISOLATED (`tab-audio-recorder-page`) |
| --------------------------------------- | -------------------------------------------- |
| `PROBE`                                 | `PROBE_RESULT { hasContexts }`               |
| `START { bitrate }`                     | `STARTED { ok, error? }`                     |
| `STOP`                                  | `STOPPED { ok, blob, mimeType, ... }`        |
| (passive listen)                        | `ERROR { error }` (spontaneous mid-capture)  |

- `probe()` (1s timeout) checks whether the page created any `AudioContext` at
  all — if not, the strategy is skipped without error.
- `start()` / `stop()` wait for the matching reply (10s timeout); the assembled
  `Blob` is structured-cloneable, so it crosses the postMessage boundary and then
  the runtime messaging boundary back to the background.

## Capture output

Every strategy produces a `CaptureResult` (`src/types/index.ts`):

```ts
interface CaptureResult {
  blob: Blob;
  mimeType: string; // typically audio/webm;codecs=opus
  durationMs: number;
  startedAt: number;
  endedAt: number;
}
```

The content script forwards it to the background as `RECORDING_COMPLETE`, where
`saveRecording` attaches tab metadata and persists it. The on-disk format is
decided later at export time — see [storage-and-export.md](storage-and-export.md).

## Strategy and E2E test-page map

Most capture paths have a dedicated fixture under `test-pages/`, exercised by the
Selenium suite (`test/e2e/capture.test.ts`). Useful when adding or debugging a
strategy:

| Test page                     | Exercises                                            |
| ----------------------------- | ---------------------------------------------------- |
| `01-audio-src-direct.html`    | DOM strategy on a plain `<audio>`                    |
| `02-video-with-audio.html`    | DOM strategy, audio-only rebuild (YouTube-bug guard) |
| `03-mse-blob.html`            | DOM strategy on a MediaSource-fed `<audio>`          |
| `06-webaudio-pure.html`       | Web Audio strategy (an `OscillatorNode`)             |
| `07-shadow-dom.html`          | DOMScanner reaching into a Shadow DOM root           |
| `08-iframe-same-origin.html`  | DOMScanner reaching into a same-origin iframe        |
| `09-iframe-cross-origin.html` | Cross-origin frame found via `all_frames` + routing  |
| `13-drm-fake.html`            | DRM/EME refusal (faked `mediaKeys`)                  |

The **network strategy has no E2E fixture** — it is covered by
`NetworkRecorder.test.ts` (unit) only. See
[development.md](development.md#end-to-end-tests) for how the E2E harness drives
the rest.
