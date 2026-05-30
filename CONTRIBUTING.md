# Contributing

Thanks for your interest in improving Tab Audio Recorder. This document covers
the practical workflow; the deep technical reference lives in
[`docs/`](docs/README.md).

## Prerequisites

- [Bun](https://bun.sh) (package manager + script runner)
- Firefox
- For the E2E suite: `geckodriver` is pulled in as a dev dependency

```bash
bun install
```

## Workflow

1. Open an issue first for anything beyond a small fix, so the approach can be
   agreed before you write code.
2. Branch from `main`.
3. Make the change. Match the surrounding style — the codebase favors small,
   single-purpose modules, typed message passing, and no dead code or
   backwards-compat shims.
4. Keep the tree green (see below) before opening a pull request.
5. Update the docs in [`docs/`](docs/README.md) and `CHANGELOG.md` when behavior
   or architecture changes.

## Checks

Run these before pushing — CI runs the same set:

```bash
bun run lint          # ESLint over src
bunx tsc --noEmit     # Type check
bun run test          # Vitest unit suite
bun run build         # Production build into dist/
bun run lint:ext      # web-ext lint over dist (the AMO validator)
bun run format        # Prettier write
```

The end-to-end Selenium suite is heavier and needs Firefox:

```bash
bun run test:e2e      # builds with the test bridge, then runs Selenium
```

A full E2E run takes ~95s (it launches Firefox and exercises every capture
strategy). On Windows, leaked `geckodriver` processes are reaped automatically by
`test/e2e/globalSetup.ts`; if you hard-kill the run (Ctrl-C), clear any leftovers
with `Stop-Process -Name geckodriver,firefox -Force`.

## Code style

- TypeScript strict (plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- No emojis in code, comments, or output.
- Build DOM structurally (`textContent` / `createElementNS`), never from HTML
  strings — this keeps the AMO validator clean.
- See [docs/development.md](docs/development.md) for change recipes (adding a
  capture strategy, a setting, a message type, an export format).

## Reporting bugs and requesting features

Use the issue templates. For security issues, do **not** open a public issue —
see [SECURITY.md](SECURITY.md).
