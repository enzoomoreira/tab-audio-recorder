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
  1. findFrameWithMedia(tabId)              -> a frame that has played a media element?
        yes -> START_CAPTURE                -> MediaElementRecorder / MediaElementHook
  2. findFrameWithStreamURL(tabId)          -> a sniffed audio stream URL?
        yes -> START_NETWORK_CAPTURE        -> NetworkRecorder
  3. for each frame: START_WEBAUDIO_CAPTURE -> probe AudioContext, tap it
        yes -> WebAudioRecorder
  none -> { ok: false, error: 'No audio source detected ...' }
```

The order is deliberate: element `captureStream` is the highest-fidelity and most
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
  that answers `{ playing: true }` — a media element *currently playing*. A
  paused, previously-played element no longer qualifies, so the toggle arms (see
  below) instead of capturing silence. Frames without our content script (e.g.
  `about:`, `chrome://`) simply throw and are skipped.
- The chosen `frameId` is stored in `SessionState` (`activeFrame`) so `STOP_CAPTURE`
  later reaches the exact frame that is recording.

This is why both content scripts are injected with `all_frames: true`: a
cross-origin iframe is unreachable from the top document's DOM, but the browser
still injects our content script into it, and `frameId` routing delivers
start/stop to it directly.

## Strategy 1: Media element (`captureStream`)

Used when the page plays an `<audio>` or `<video>` element. Two pieces: the
MAIN-world `MediaElementHook` tracks and captures the element, and the
ISOLATED-world `MediaElementRecorder` drives it.

### Why the MAIN world

A media element can play without ever being in the document: a page can do
`new Audio(blobUrl).play()` and never call `appendChild`. WhatsApp Web does
exactly this for voice messages (the decrypted Opus blob is fed to a detached
element). Such an element is invisible to `document.querySelectorAll('audio')`,
and the ISOLATED content script cannot patch the page's own
`HTMLMediaElement.prototype` to intercept playback either. So the element half
runs in the **MAIN** world, like the Web Audio hook. Patching the prototype there
also catches elements inside **closed** shadow roots, which a DOM walk cannot
reach.

### MediaElementHook (`src/content/MediaElementHook.ts`) — MAIN world

Runs at `document_start` so it patches `HTMLMediaElement.prototype.play` before
any page script runs. It is self-contained (no imports, no `browser.*`):

- **Tracks every played element.** Each `play()` call records the element in a
  most-recent-last list, capped at 16 so a long-lived page cannot grow it
  unbounded (holding references also pins detached elements against GC). This
  catches attached elements, detached `new Audio()` elements, and elements inside
  closed shadow roots alike.
- **Picks the capture target** on `START`: a currently-playing element (video
  preferred — it carries the audio we want), else the most recently played one.
- **Arm + auto-start.** On `EL_ARM` the hook sets an armed flag; the very next
  `play()` starts capture on *that* element synchronously, inside the patched
  `play()`, with **no background round-trip** — so the recording catches the audio
  from sample zero. It reports the outcome with a spontaneous `EL_ARM_FIRED`, which
  the ISOLATED driver forwards to the background as `ARMED_STARTED`. `EL_DISARM`
  cancels a pending arm; `EL_ABORT` discards a capture a losing frame started in a
  multi-frame race.
- **DRM/EME refusal.** If the chosen element has `mediaKeys`, capture would yield
  silence under Firefox's EME policy, so it is refused up front with a clear error
  instead of saving a silent file. (E2E: `13-drm-fake`.)
- **Waits for the audio track.** `captureStream()` at the instant playback starts
  can return a stream whose audio track has not been added yet (element
  `readyState` 0). The hook waits briefly (`addtrack` / `playing` events, 3s cap)
  so it does not start recording an empty stream.
- **Audio-only stream rebuild.** A `<video>` capture carries a video track too,
  which `MediaRecorder` rejects under an audio-only mimeType, so it records a
  fresh `MediaStream` built from `getAudioTracks()` only. (The "YouTube bug" the
  E2E test `02-video-with-audio` guards against.) Zero audio tracks throws.
- **MIME selection + chunking.** Picks the first supported of
  `audio/webm;codecs=opus`, `audio/webm`, `audio/ogg;codecs=opus`, `audio/ogg`;
  `recorder.start(1000)` emits a chunk every second, assembled into one `Blob` on
  stop. A spontaneous mid-capture `onerror` reports `EL_ERROR`, which the ISOLATED
  driver forwards as `RECORDING_ERROR`.

### MediaElementRecorder (`src/content/MediaElementRecorder.ts`) — ISOLATED world

The ISOLATED half the orchestrator drives. Because the element lives in the MAIN
world (and may be detached, so unreachable from here), detection and capture both
happen in the hook; this class just speaks a small `window.postMessage` protocol:

| ISOLATED -> MAIN (`tab-audio-recorder`) | MAIN -> ISOLATED (`tab-audio-recorder-page`)    |
| --------------------------------------- | ----------------------------------------------- |
| `EL_PROBE`                              | `EL_PROBE_RESULT { found, playing }`            |
| `EL_START { bitrate }`                  | `EL_STARTED { ok, error? }`                     |
| `EL_STOP`                               | `EL_STOPPED { ok, blob, mimeType, ... }`        |
| `EL_ARM { bitrate }`                    | `EL_ARM_FIRED { ok, error? }` (on the next play) |
| `EL_DISARM` / `EL_ABORT`                | — (no reply)                                    |
| (passive listen)                        | `EL_ERROR { error }` (spontaneous mid-capture)  |

- `probe()` (1s timeout) answers the `CHECK_MEDIA` frame check: has the page
  played any capturable element (`found`), and is one playing right now
  (`playing`)? `findFrameWithMedia` gates Strategy 1 on `playing`. If nothing is
  playing, the strategy is skipped without error.
- `arm()` / `disarm()` / `abort()` send `EL_ARM` / `EL_DISARM` / `EL_ABORT`; a
  passive listener turns the hook's spontaneous `EL_ARM_FIRED` into the recorder
  becoming active (success) or an `onArmFailed` callback (e.g. DRM).
- `start()` / `stop()` wait for the matching reply (10s timeout); the assembled
  `Blob` is structured-cloneable, so it crosses the postMessage boundary and then
  the runtime messaging boundary back to the background.

> The Web Audio hook (Strategy 3) shares this `tab-audio-recorder` /
> `tab-audio-recorder-page` channel; the two stay apart through distinct message
> types (`EL_*` here vs `PROBE`/`START`/`STOP` there).

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
  1-second chunking as the element hook.

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

| Test page                     | Exercises                                                 |
| ----------------------------- | --------------------------------------------------------- |
| `01-audio-src-direct.html`    | Element strategy on a plain `<audio>`                     |
| `02-video-with-audio.html`    | Element strategy, audio-only rebuild (YouTube-bug guard)  |
| `03-mse-blob.html`            | Element strategy on a MediaSource-fed `<audio>`           |
| `06-webaudio-pure.html`       | Web Audio strategy (an `OscillatorNode`)                  |
| `07-shadow-dom.html`          | `play()` hook catching an element in a Shadow DOM root    |
| `08-iframe-same-origin.html`  | `play()` hook catching an element in a same-origin iframe |
| `09-iframe-cross-origin.html` | Cross-origin frame reached via `all_frames` + routing     |
| `13-drm-fake.html`            | DRM/EME refusal (faked `mediaKeys`)                       |
| `14-detached-audio.html`      | Detached `new Audio()` (WhatsApp-style), never in DOM     |
| `15-arm-then-play.html`       | Arm before playback, then auto-capture on the next `play()` |

The **network strategy has no E2E fixture** — it is covered by
`NetworkRecorder.test.ts` (unit) only. See
[development.md](development.md#end-to-end-tests) for how the E2E harness drives
the rest.
