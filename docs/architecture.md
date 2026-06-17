# Architecture

This document explains how Tab Audio Recorder is wired together: the execution
contexts that make up a WebExtension, how they are declared in the manifest, the
typed message bus that connects them, and the end-to-end flow of a single
recording. Read this first; the other docs drill into individual subsystems.

## Why "by execution context"

A WebExtension is not one program. The browser runs the same add-on as several
isolated JavaScript realms that can only talk through message passing. The
source tree mirrors those realms exactly, so a directory tells you _where_ code
runs (and therefore what it can and cannot do):

| Directory         | Realm                                  | Can call `browser.*`?          | DOM access                 |
| ----------------- | -------------------------------------- | ------------------------------ | -------------------------- |
| `src/background/` | Background event page (non-persistent) | Full                           | None (no page DOM)         |
| `src/content/`    | Content scripts (per frame)            | Most APIs (messaging, storage) | Page DOM (ISOLATED + MAIN) |
| `src/popup/`      | Browser-action popup page              | Full                           | Its own document           |
| `src/app/`        | Unified recordings + settings tab      | Full                           | Its own document           |
| `src/shared/`     | Plain modules imported by the above    | Depends on importer            | n/a                        |
| `src/types/`      | Type-only declarations                 | n/a                            | n/a                        |

The background is the single source of truth: it owns recording state, runs the
capture-strategy selection, and is the only realm that writes to the database.
Everything else is a thin surface that sends it messages.

## Manifest wiring

`src/manifest.json` declares which file runs in which realm. The non-obvious
parts:

- **MAIN-world hooks, deliberately.** `content/AudioContextHook.ts` and
  `content/MediaElementHook.ts` run in the **MAIN** world at `document_start` and
  `all_frames`. The first patches `AudioContext` before any page script builds its
  audio graph; the second patches `HTMLMediaElement.prototype.play` so it can
  capture media elements the page never inserts into the DOM (e.g. detached
  `new Audio()` players, as WhatsApp Web uses for voice messages).
  `content/index.ts` runs in the default **ISOLATED** world at `document_idle`; it
  is the realm that can call `browser.runtime.*`. The halves talk via
  `window.postMessage` (see [capture.md](capture.md#strategy-1-media-element-capturestream)).
- **`all_frames: true`** on all content scripts. Audio can play in any frame,
  including cross-origin iframes the top document cannot reach, so the recorder
  must be injected everywhere and addressed per `frameId`.
- **Background `type: "module"`** — the background is an ES module, so it uses
  static `import`. It is **non-persistent** (Firefox MV3 event page); see
  [state-and-lifecycle.md](state-and-lifecycle.md).
- **`commands.record-toggle`** binds `Alt+Shift+R` to the record/arm/stop toggle
  on the active tab — the same logic as the popup button — handled in
  `src/background/index.ts`.
- **`options_ui.open_in_tab: true`** opens the unified app page (`app/index.html`)
  as a full tab, not a popup. The page is a small hash-routed SPA: the sidebar
  switches between the `#recordings` and `#settings` sections without reloading.
  The popup's two buttons both go through the background's find-or-focus opener
  (`OPEN_APP`), which reuses an already-open app tab and just re-targets the hash.

The permission rationale (why each of `tabs`, `webRequest`, `webNavigation`,
`storage`, `downloads`, `<all_urls>` is needed) lives in the root
[README](../README.md#permissions).

## Module map

Where to look when you are changing a given concern:

| Concern                        | File                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| Message router (background)    | `src/background/index.ts`                                                 |
| Capture orchestration + state  | `src/background/Orchestrator.ts`                                          |
| Save / export / prune pipeline | `src/background/RecordingsService.ts`                                     |
| Toolbar badge                  | `src/background/badge.ts`                                                 |
| Per-tab state + persistence    | `src/shared/SessionState.ts`                                              |
| Element capture strategy       | `src/content/MediaElementRecorder.ts` + `src/content/MediaElementHook.ts` |
| Network capture strategy       | `src/content/NetworkRecorder.ts`                                          |
| Web Audio capture strategy     | `src/content/WebAudioRecorder.ts` + `src/content/AudioContextHook.ts`     |
| Content-script message handler | `src/content/index.ts`                                                    |
| Persistence (IndexedDB)        | `src/shared/Repository.ts`                                                |
| Transcode (WAV/MP3)            | `src/shared/AudioEncoder.ts`                                              |
| Export filename rendering      | `src/shared/FilenameTemplate.ts`                                          |
| Settings model + storage       | `src/shared/Settings.ts`                                                  |
| Logging                        | `src/shared/Logger.ts`                                                    |
| Domain model + message types   | `src/types/index.ts`                                                      |
| Popup UI                       | `src/popup/index.ts`                                                      |
| App shell + hash routing       | `src/app/index.ts`                                                        |
| Recordings UI + audio player   | `src/app/recordings.ts` + `src/app/recordingCard.ts` + `src/app/AudioPlayer.ts` |
| Settings UI                    | `src/app/settings.ts`                                                     |

## The message bus

All cross-realm communication is `browser.runtime.sendMessage` /
`browser.tabs.sendMessage`. Every message is a **discriminated union** keyed on
`type`, declared in `src/types/index.ts`. The background's listener is typed as
the closed `InboundMessage` union and narrows with a `switch`, so payloads are
read without `as` casts (`src/background/index.ts`).

Popup/app calls into the background go through the typed `sendToBackground`
wrapper (`src/shared/messaging.ts`): it constrains the request to the outbound
union and resolves with the matching response type (via a `ResponseFor` map), so
the **calling** side is checked too — no `as` cast on the reply.

There are two messaging shapes in play:

- **Request/response** — the sender `await`s a reply. The listener returns a
  `Promise`. Used by popup/app calls into the background.
- **Proactive (fire-and-forget)** — the sender does not wait. The listener
  returns `undefined`. Used by the content script telling the background a
  recording finished or errored.

### Message catalog

| Message                  | Direction                 | Shape            | Purpose                                                            |
| ------------------------ | ------------------------- | ---------------- | ------------------------------------------------------------------ |
| `GET_TAB_STATE`          | Popup -> Background       | request/response | Read a tab's `idle`/`armed`/`recording`/`processing` state         |
| `TOGGLE_RECORDING`       | Popup -> Background       | request/response | One button: stop / disarm / start-now / arm, by state              |
| `OPEN_APP`               | Popup -> Background       | proactive        | Open/focus the app tab, deep-linked to a section                   |
| `CHECK_MEDIA`            | Background -> Content     | request/response | "Is a media element playing in this frame?" (`{ found, playing }`) |
| `START_CAPTURE`          | Background -> Content     | request/response | Start media-element (`captureStream`) capture                      |
| `START_NETWORK_CAPTURE`  | Background -> Content     | request/response | Start network-fetch capture                                        |
| `START_WEBAUDIO_CAPTURE` | Background -> Content     | request/response | Start Web Audio capture                                            |
| `STOP_CAPTURE`           | Background -> Content     | request/response | Stop the active recorder in the frame                              |
| `ARM_CAPTURE`            | Background -> Content     | request/response | Arm the element hook to auto-capture the next play                 |
| `DISARM_CAPTURE`         | Background -> Content     | request/response | Cancel a pending arm                                               |
| `ABORT_CAPTURE`          | Background -> Content     | request/response | Discard an armed capture a losing frame started                    |
| `RECORDING_COMPLETE`     | Content -> Background     | proactive        | Deliver the finished `CaptureResult` blob                          |
| `RECORDING_ERROR`        | Content -> Background     | proactive        | Report a mid-capture failure                                       |
| `ARMED_STARTED`          | Content -> Background     | proactive        | An armed frame auto-started capture on `play()`                    |
| `LIST_RECORDINGS`        | App -> Background         | request/response | Query metadata (filter + sort)                                     |
| `DELETE_RECORDING`       | App -> Background         | request/response | Delete a recording (metadata + blob)                               |
| `GET_BLOB`               | App -> Background         | request/response | Fetch a blob for in-page playback                                  |
| `EXPORT_RECORDING`       | App -> Background         | request/response | Run the export pipeline for one recording                          |
| `TEST_START_RECORDING`   | Test bridge -> Background | request/response | E2E-only; stripped from production                                 |
| `TEST_STOP_RECORDING`    | Test bridge -> Background | request/response | E2E-only; stripped from production                                 |
| `TEST_ARM_RECORDING`     | Test bridge -> Background | request/response | E2E-only; stripped from production                                 |
| `TEST_GET_LOGS`          | Test bridge -> Background | request/response | E2E-only; returns the background log buffer                        |

> Note: the background<->MAIN-world hooks do **not** use this bus. The MAIN
> world cannot call `browser.*`, so the ISOLATED drivers (`WebAudioRecorder`,
> `MediaElementRecorder`) and their MAIN-world hooks (`AudioContextHook`,
> `MediaElementHook`) communicate with their own `window.postMessage` protocol
> tagged `tab-audio-recorder` / `tab-audio-recorder-page`.

## End-to-end flow of one recording

The path from clicking Record to a saved (and optionally exported) file. Frame
selection and the capture strategies are summarized here and detailed in
[capture.md](capture.md).

```
Popup click / Alt+Shift+R
        |
        v
TOGGLE_RECORDING { tabId }                        (popup -> background)
        |
        v
Orchestrator.toggleRecording(tabId)               (src/background/Orchestrator.ts)
   |  recording -> stopRecording   armed -> disarm
   |  idle + nothing playing -> armRecording  (auto-starts on next play(); see capture.md)
   |  idle + audio already playing -> startRecording (below)
        |
        v
Orchestrator.startRecording(tabId)                (src/background/Orchestrator.ts)
   |  loads Settings
   |
   |-- Strategy 1: Media element ----------------------------------.
   |     CHECK_MEDIA across frames -> first frame with media       |
   |     START_CAPTURE { bitrate } -> MediaElementHook.captureStream|
   |                                                                |
   |-- Strategy 2: Network stream (if no media element) -----------|
   |     stream URL cached by webRequest sniffing                  |
   |     START_NETWORK_CAPTURE { url } -> NetworkRecorder.fetch    |
   |                                                                |
   |-- Strategy 3: Web Audio (if neither) -------------------------|
   |     START_WEBAUDIO_CAPTURE { bitrate } -> AudioContext tap    |
   |                                                                |
   '--> first strategy that succeeds: mark tab 'recording', arm    |
        the optional max-duration timer <-------------------------'
        |
        v
   (user records...)  TOGGLE_RECORDING { tabId }   (popup -> background)
        |
        v
Orchestrator.stopRecording -> tab 'processing', STOP_CAPTURE -> frame
        |                       arm 30s processing watchdog
        v
Content assembles the Blob, sends RECORDING_COMPLETE { CaptureResult }
        |                                            (content -> background, proactive)
        v
Orchestrator.saveRecording(tabId, result)        (owns only the tab lifecycle)
   |  RecordingsService.saveCapture(): build RecordingMetadata, Repository.save()
   |     if settings.autoExport -> exportRecording() (decode -> WAV/MP3 -> downloads)
   |     if settings.maxRecordings > 0 -> prune oldest
   '--> clearTab(tabId)  (always, even on failure)
```

Recordings are always captured as **WebM/Opus** (the `MediaRecorder` container);
the user's chosen WAV/MP3 format is applied only at export time by decoding and
re-encoding. See [storage-and-export.md](storage-and-export.md).

## Cross-cutting invariants

A few rules hold across the whole codebase; breaking them is how subtle bugs get
in:

- **The background never touches a page DOM.** It addresses frames by `frameId`
  and delegates all capture to content scripts.
- **A tab is released no matter what.** Every terminal path in the orchestrator
  calls `clearTab`, including save failures and watchdog timeouts, so the UI can
  never get stuck showing "Recording" forever.
- **State survives a background suspension.** Anything the orchestrator needs to
  resume after an MV3 wake is written through `SessionState` to
  `storage.session`. Timers are the exception — they are re-armed by `hydrate()`.
- **The app builds DOM structurally, never from HTML strings.** `el()` /
  `svgEl()` helpers use `textContent` and `createElementNS`, which keeps the AMO
  validator clean and avoids injection surface.
