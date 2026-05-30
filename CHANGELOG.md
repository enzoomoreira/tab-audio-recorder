# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The project is in active development toward its first published release.

### Changed

- Unified the recordings manager and settings into a single sidebar-navigated app
  page (`src/app/`), replacing the two separate extension tabs. The popup buttons
  deep-link to a section through a find-or-focus opener so they never spawn
  duplicate tabs.

### Fixed

- E2E suite no longer leaks `geckodriver`/`firefox` processes on Windows; a
  `globalSetup` hook reaps the ones a run started on teardown.
