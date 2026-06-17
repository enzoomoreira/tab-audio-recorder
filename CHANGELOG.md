# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-06-17

### Added

- `browser_specific_settings.gecko.strict_min_version` pinned to `142.0` — the
  minimum Firefox (desktop and Android) that supports the manifest's
  `data_collection_permissions` declaration. It also covers the `world: "MAIN"`
  content scripts (Firefox 128) that capture strategies 1 and 3 rely on, and
  keeps `web-ext lint` warning-free.
- `bun run package` script that runs a production build and zips the extension
  into `web-ext-artifacts/` for AMO submission.

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

### Fixed

- E2E suite no longer leaks `geckodriver`/`firefox` processes on Windows; a
  `globalSetup` hook reaps the ones a run started on teardown.
