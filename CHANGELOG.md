# Changelog

## [2026-09-06 09:34]

### Added

- Incremental recording storage: ordered audio chunks are committed to IndexedDB
  during capture, with bounded pending queues and visible storage failures.
- Interrupted recordings retain committed audio for export; the manager shows
  preserved size and duration and warns that playback may require file repair.
- Original-format export preserves the captured bytes without decoding audio.
- Popup recording progress shows committed bytes and saved-through duration.

### Changed

- New and reset settings default to Original export, recommended for long
  recordings. Existing export preferences are preserved; WAV/MP3 conversion still
  decodes the entire recording and can use substantial memory.
- Recordings are assembled for playback/export only; Stop finalizes their saved
  chunk count. Retention pruning excludes active and interrupted captures.
- Interrupted captures export original bytes regardless of format preferences;
  active captures cannot be played, exported or deleted before stopping.

### Fixed

- Export success now requires a completed download; interruption, rejection and
  unconfirmed background suspension are reported without deleting the saved audio.
- Failed auto-export is exposed to the user instead of being logged as an
  otherwise successful save.
- Capture messages are checked against their allocated tab/frame/session, so
  stale completion and error messages cannot finalize or clear a newer recording.

## [2026-09-06 08:55]

### Added

- Release workflow builds and validates extension/source packages from the release
  tag, with optional submission to the existing Mozilla listing through web-ext.

### Changed

- Prepare version 0.1.2 and pin CI builds to Bun 1.3.11 for reproducible releases.

## [2026-09-06 08:40]

### Fixed

- Popup follows recording state changes while open, leaves "Saving..." after
  completion, reports capture/storage errors, and recovers from rejected actions.
- Background waits for session hydration, claims armed captures before yielding,
  rejects overlapping toggles, and clears routing when the recording frame navigates.
- Completion of an older save after navigation cannot reset a newer recording
  or overwrite its error state.
- Recording deadlines survive background suspension through session storage and
  browser alarms; the stop watchdog starts before waiting for acknowledgement.
- Captures remain saveable after media ends naturally. Pending capture can be
  cancelled, native controls/autoplay are detected, and stop failures release listeners.
- IndexedDB writes are acknowledged only after transaction commit; storage aborts
  are reported instead of silently returning success.
- Playback, export and delete recover after errors; stale list/blob responses no
  longer overwrite newer UI state. Downloads release object URLs even when they
  complete before the download request resolves.
- Settings saves and reset execute in order, with visible storage failures.
- Firefox test launcher uses the installed geckodriver package's supported API.

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- E2E suite runs again on geckodriver 0.37.1, which dropped support for setting
  Firefox's `--remote-allow-system-access` through `moz:firefoxOptions`. The
  chrome-context grant the UUID discovery depends on now goes to the geckodriver
  process as `--allow-system-access`.

## [0.1.1] - 2026-06-17

### Added

- `browser_specific_settings.gecko.strict_min_version` pinned to `142.0` — the
  minimum Firefox (desktop and Android) that supports the manifest's
  `data_collection_permissions` declaration. It also covers the `world: "MAIN"`
  content scripts (Firefox 128) that capture strategies 1 and 3 rely on, and
  keeps `web-ext lint` warning-free.
- `bun run package` and `bun run package:source` scripts that produce the built
  extension zip and the source archive for AMO submission, documented in
  `docs/publishing.md` (the AMO "listed" workflow + reviewer build instructions).

### Changed

- Unified the recordings manager and settings into a single sidebar-navigated app
  page (`src/app/`), replacing the two separate extension tabs. The popup buttons
  deep-link to a section through a find-or-focus opener so they never spawn
  duplicate tabs.
- Internal refactor for maintainability, no behavior change: split the background
  `Orchestrator` into a capture controller, a `RecordingsService`
  (persistence/export/prune, owning the IndexedDB layer), and a `badge` module;
  extracted a shared content `pageBridge` helper and the app's `recordingCard`
  builder; and added a typed `sendToBackground` message wrapper.
- Regenerated `browser_specific_settings.gecko.id` (and the matching `EXT_ID` in
  the E2E fixture). AMO permanently deny-lists the GUID of a deleted submission,
  so the original ID could never be uploaded again — see `docs/publishing.md`.

### Fixed

- E2E suite no longer leaks `geckodriver`/`firefox` processes on Windows; a
  `globalSetup` hook reaps the ones a run started on teardown.
