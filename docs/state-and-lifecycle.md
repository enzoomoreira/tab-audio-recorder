# State and lifecycle

The hardest part of a Manifest V3 recorder is not capturing audio — it is staying
correct when the browser suspends your background mid-recording. This document
covers the per-tab state machine, how state survives an MV3 suspension, the
watchdogs, and the cleanup paths that release recording state after completion
or a reported failure. These mechanisms do not recover unsaved audio after a
page navigation or browser crash.

## The MV3 problem

The Firefox MV3 background is a **non-persistent event page**: the browser may
suspend it whenever it is idle and respawn it on the next event. A naive
in-memory `Map<tabId, state>` would be wiped by a suspension that happens while a
recording is in progress, and the eventual `STOP` would not know which frame to
talk to.

The lifecycle uses:

1. **Write-through persistence** of all routing state to `storage.session`
   (`SessionState`), rehydrated on every wake.
2. **Browser alarms and persisted deadlines** to wake the event page when a
   recording limit or stop watchdog expires.
3. **Cleanup paths** that return the tab to `idle` after completion, errors,
   timeout, or navigation of the recording frame.

## Per-tab state machine

A tab is in exactly one of four states (`TabRecordingState` in
`src/types/index.ts`):

```
idle -> recording                 successful immediate capture
idle -> armed -> recording        next playback reports ARMED_STARTED
armed -> idle                     toggle cancels the arm
recording -> processing           stop requested, or capture completes itself
processing -> idle                saved, save failed, or stop watchdog expired
armed/recording/processing -> idle capture error, tab closed, recording frame navigated
```

- **idle** — nothing happening; the popup shows "Ready".
- **armed** — every frame's element hook is primed to auto-capture the next media
  element that plays; capture has not started yet. The popup shows "Armed —
  waiting for audio" and a toolbar badge marks it. The next `play()` starts capture
  in the page, and the winning frame reports `ARMED_STARTED`, moving the tab to
  `recording`. Only the media-element strategy is armable.
- **recording** — a recorder is active in `activeFrame(tabId)`. The popup shows
  "Recording".
- **processing** — stop was requested and the blob is being assembled, or
  `RECORDING_COMPLETE` has arrived and saving/exporting is in progress. The popup
  shows "Saving" and disables the button.

The popup's single button sends one `TOGGLE_RECORDING`; on success it re-reads the
resulting state (it cannot predict whether `idle` becomes `recording` or `armed`),
and also re-reads state after an unsuccessful action. It listens for
`storage.onChanged` updates to the session's `recordingState`, so completion and
automatic starts update an already-open popup. Older asynchronous refreshes
cannot overwrite newer responses. Action errors and persisted capture/save
errors are shown below the status. See `src/popup/index.ts`.

The orchestrator rejects concurrent toggles for the same tab while an action is
pending. Arming sets `armed` before contacting frames; `ARMED_STARTED` claims its
winning frame before awaiting settings. Other frames are disarmed and a losing
frame that also started is instructed to abort. Errors from a different frame
cannot clear the winner's active recording.

## SessionState (`src/shared/SessionState.ts`)

Holds five maps and writes through to `storage.session` on every mutation:

| Map             | Key -> Value              | Purpose                                         |
| --------------- | ------------------------- | ----------------------------------------------- |
| `tabStates`     | tabId -> state            | The state machine above                         |
| `activeFrames`  | tabId -> frameId          | Which frame the active recorder is in           |
| `tabStreamURLs` | tabId -> (frameId -> url) | Audio stream URLs sniffed by `webRequest`       |
| `deadlines`     | tabId -> timestamp in ms  | Recording limit or stop watchdog deadline       |
| `errors`        | tabId -> message          | Capture/save failure exposed by `GET_TAB_STATE` |

`storage.session` is **in-memory and cleared on browser restart** — which is
exactly the lifetime of an in-flight recording, so it is the right backing store.
Maps are not JSON-serializable, so `persist()` converts them to entry arrays
(`Snapshot`) on write and `hydrate()` rebuilds the Maps on read.

## hydrate(): resuming after a wake

`Orchestrator.hydrate()` runs on background boot (`src/background/index.ts`). It:

1. Rebuilds the maps from `storage.session`.
2. Re-arms processing watchdogs and recording-limit timers using their saved
   deadlines, preserving elapsed time. A processing state without a deadline
   receives a new 30-second watchdog.

The boot sequence also loads settings and configures logger verbosity. Event
listeners are registered immediately, but message routing, tab/navigation events,
stream detections, alarms, and hotkey actions await this initialization before
reading or changing session state.

## Watchdog timers

Each watchdog has a local timer and a named `browser.alarms` alarm, sharing a
deadline stored in the session. Alarms can wake the non-persistent background;
local timers alone cannot. Alarm delivery is not an exact timing guarantee.

- **Processing watchdog (`PROCESSING_TIMEOUT_MS = 30_000`).** Armed when a tab
  enters `processing`, before sending `STOP_CAPTURE`. If completion does not
  arrive before the deadline, it resets the tab to `idle` and records a timeout
  error. The stop watchdog is canceled when saving starts, so it does not apply
  a 30-second limit to export conversion.
- **Max-duration timer.** Armed at record start only if
  `settings.maxDurationSec > 0`. On expiry it calls the normal `stopRecording`
  path, so the auto-stop behaves identically to a user clicking Stop — and works
  uniformly across all three capture strategies. This is the memory guard for
  long streams (the whole recording is held in memory until stopped).

## Cleanup paths

Cleanup is performed by these paths:

- **`saveRecording` `finally`** — `clearTab(tabId)` runs even if the IndexedDB
  write throws. A save failure remains available as an
  error in session state after the tab returns to `idle`. Cleanup is scoped to
  the current save operation: if navigation released the tab and another capture
  started, the previous save cannot reset the new recording or attach its error.
- **`RECORDING_ERROR`** (content -> background) — a mid-capture failure clears the
  tab immediately when it comes from the active frame. An armed-start failure
  also disarms the frames; a losing frame's error leaves the winner alone.
- **`browser.tabs.onRemoved`** — closing the tab clears its state.
- **`browser.webNavigation.onCommitted` on the top or active frame** — navigating away
  destroys the content script (and any in-flight `MediaRecorder`), so the
  orchestrator must not keep believing the tab is recording. Navigation of
  another iframe removes its cached stream URL without clearing the recording.
- **`clearTab`** cancels local timers and the browser alarm, and drops the tab's
  entries from all five maps. Failure paths then retain their error message.

Audio remains in the capture context until completion; session persistence
stores routing information, not an incremental recording backup. Closing or
navigating the recording page, or crashing the browser, can lose unsaved audio.

Runtime references: [MDN background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)
and [MDN alarms](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms).

## Hotkey path

`browser.commands.onCommand` handles `record-toggle` (`Alt+Shift+R`): it calls
`toggleRecording` on the active tab — the exact same entry point as the popup
button, so the hotkey records, arms, disarms, or stops by state with no separate
code path. The listener lives in the background, so it works with the popup closed.

## Settings propagation

Settings are stored in `storage.local` (persistent, unlike session state) and
read through `getSettings()` (`src/shared/Settings.ts`), which merges the stored
partial over `DEFAULT_SETTINGS` so a missing or partial record is always valid.
`onSettingsChanged` lets a context react live — the background uses it to retune
logger verbosity without a reload. See [storage-and-export.md](storage-and-export.md)
for which settings affect export, and `Settings.ts` for the full model.
