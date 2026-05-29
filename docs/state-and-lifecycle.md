# State and lifecycle

The hardest part of a Manifest V3 recorder is not capturing audio — it is staying
correct when the browser suspends your background mid-recording. This document
covers the per-tab state machine, how state survives an MV3 suspension, the
watchdog timers, and the cleanup paths that guarantee a tab is never stuck.

## The MV3 problem

The Firefox MV3 background is a **non-persistent event page**: the browser may
suspend it whenever it is idle and respawn it on the next event. A naive
in-memory `Map<tabId, state>` would be wiped by a suspension that happens while a
recording is in progress, and the eventual `STOP` would not know which frame to
talk to.

Two things make this safe:

1. **Write-through persistence** of all routing state to `storage.session`
   (`SessionState`), rehydrated on every wake.
2. **Idempotent, always-releasing cleanup** so any path — including a missed
   message or a timeout — returns the tab to `idle`.

## Per-tab state machine

A tab is in exactly one of four states (`TabRecordingState` in
`src/types/index.ts`):

```
        toggle: audio already playing (a strategy succeeds)
 idle ------------------------------------------------> recording
   | ^                                                      |
   | |  toggle: nothing playing yet                         | STOP (STOP_CAPTURE acked)
   | |  (ARM_CAPTURE broadcast to all frames)               | or max-duration timer
   | v                                                      v
   | armed --- play() fires -> ARMED_STARTED ----------> processing
   |   |       (capture started in the page)                |
   |   '--- toggle again -> disarm -> idle                  | RECORDING_COMPLETE saved
   |                                                        | (or save failure)
   '<-------------------------------------------------------'
   '<-- processing watchdog (30s) / RECORDING_ERROR
   '<-- tab closed / top-frame navigation (clearTab)
```

- **idle** — nothing happening; the popup shows "Ready".
- **armed** — every frame's element hook is primed to auto-capture the next media
  element that plays; capture has not started yet. The popup shows "Armed —
  waiting for audio" and a toolbar badge marks it. The next `play()` starts capture
  in the page, and the winning frame reports `ARMED_STARTED`, moving the tab to
  `recording`. Only the media-element strategy is armable.
- **recording** — a recorder is active in `activeFrame(tabId)`. The popup shows
  "Recording".
- **processing** — `STOP_CAPTURE` was acknowledged and the blob is being
  assembled; we are waiting for `RECORDING_COMPLETE`. The popup shows "Saving"
  and disables the button.

The popup's single button sends one `TOGGLE_RECORDING`; on success it re-reads the
resulting state (it cannot predict whether `idle` becomes `recording` or `armed`),
and on `{ ok: false }` it restores the previous state and shows the error — see
`src/popup/index.ts`.

## SessionState (`src/shared/SessionState.ts`)

Holds three maps and writes through to `storage.session` on every mutation:

| Map             | Key -> Value              | Purpose                                   |
| --------------- | ------------------------- | ----------------------------------------- |
| `tabStates`     | tabId -> state            | The state machine above                   |
| `activeFrames`  | tabId -> frameId          | Which frame the active recorder is in     |
| `tabStreamURLs` | tabId -> (frameId -> url) | Audio stream URLs sniffed by `webRequest` |

`storage.session` is **in-memory and cleared on browser restart** — which is
exactly the lifetime of an in-flight recording, so it is the right backing store.
Maps are not JSON-serializable, so `persist()` converts them to entry arrays
(`Snapshot`) on write and `hydrate()` rebuilds the Maps on read.

## hydrate(): resuming after a wake

`Orchestrator.hydrate()` runs on background boot (`src/background/index.ts`). It:

1. Rebuilds the three maps from `storage.session`.
2. Re-arms the **processing watchdog** for any tab still in `processing` — timers
   are not persisted, so a suspension during `processing` would otherwise lose
   the safety net.

The boot sequence also loads settings and configures the logger verbosity before
the extension does anything else.

## Watchdog timers

Both are kept in plain in-memory `Map`s in the orchestrator (not persisted; one
is re-armed by `hydrate`).

- **Processing watchdog (`PROCESSING_TIMEOUT_MS = 30_000`).** Armed when a tab
  enters `processing`. If `RECORDING_COMPLETE` never arrives (content script
  crashed, frame gone), it fires and resets the tab to `idle` so the UI cannot
  hang. Cleared when the recording is saved.
- **Max-duration timer.** Armed at record start only if
  `settings.maxDurationSec > 0`. On expiry it calls the normal `stopRecording`
  path, so the auto-stop behaves identically to a user clicking Stop — and works
  uniformly across all three capture strategies. This is the memory guard for
  long streams (the whole recording is held in memory until stopped).

## Cleanup paths

The invariant "a tab is always released" is enforced from several directions:

- **`saveRecording` `finally`** — `clearTab(tabId)` runs even if the IndexedDB
  write throws (e.g. `QuotaExceededError`, which is logged with a hint to delete
  recordings or lower the bitrate).
- **`RECORDING_ERROR`** (content -> background) — a mid-capture failure clears the
  tab immediately.
- **`browser.tabs.onRemoved`** — closing the tab clears its state.
- **`browser.webNavigation.onCommitted` on the top frame** — navigating away
  destroys the content script (and any in-flight `MediaRecorder`), so the
  orchestrator must not keep believing the tab is recording. Sub-frame
  navigations are ignored (`frameId !== 0`).
- **`clearTab`** itself cancels both timers and drops all three maps' entries for
  the tab.

## Hotkey path

`browser.commands.onCommand` handles `record-toggle` (`Alt+Shift+R`): after
`await ready` (so a fresh MV3 wake has rehydrated state before it is read) it calls
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
