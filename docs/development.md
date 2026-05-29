# Development

How to build, run, and test the extension, how the test bridge works, and
step-by-step recipes for the common ways the codebase gets extended. If you are
an agent making a change, the [Change recipes](#change-recipes) section is the
fastest way to find every file you need to touch.

## Prerequisites

- [Bun](https://bun.sh) (package manager + script runner)
- Firefox
- For E2E only: `geckodriver` (pulled in as a dev dependency)

## Build and run

```bash
bun install
bun run build        # production build -> dist/
bun run dev          # rebuild on change
bun run start        # launch a clean Firefox with the extension (web-ext)
```

To load manually instead of `web-ext`: open `about:debugging#/runtime/this-firefox`
-> "Load Temporary Add-on" -> pick `dist/manifest.json`.

### Build pipeline

`vite.config.ts` drives the build with `vite-plugin-web-extension`:

- `root: 'src'`, output to `../dist`, emptied each build.
- The plugin reads `src/manifest.json`, bundles `background`, the two content
  scripts, and the HTML entry points. `manager/index.html` and
  `settings/index.html` are listed as `additionalInputs` because they are not
  reachable from the manifest's `action`/`options_ui` crawl alone.
- `target: 'firefox'` — the plugin emits an MV3 manifest shaped for Gecko.

### The `__TEST_BRIDGE__` flag

`vite.config.ts` injects a build-time boolean `__TEST_BRIDGE__` via `define`
(declared in `src/globals.d.ts`):

- `bun run test:e2e` sets `VITE_TEST_BRIDGE=true`, so the flag is `true`.
- `bun run build` does **not** set it, so it is `false` and the minifier strips
  every `if (__TEST_BRIDGE__) { ... }` block as dead code — including the
  diagnostic log buffer in `Logger.ts`.
- `vitest.config.ts` (unit) also `define`s it as `false`, so shared modules that
  read the flag (e.g. `Logger`) run under happy-dom without a `ReferenceError`.

This matters for security. The bridge (`src/content/index.ts`,
`src/background/index.ts`) lets a page on `localhost`/`127.0.0.1` trigger
record/arm/stop by dispatching a `tab-audio-recorder-cmd` custom event
(`START` / `STOP` / `ARM`), and exposes `TEST_GET_LOGS` to read the background's
diagnostic log buffer. It must never
ship in production, or any localhost page could start a silent capture. The
double guard — build-time strip **and** a runtime hostname check — means
production has no bridge code at all.

## Testing

Two suites with very different scopes.

### Unit tests

```bash
bun run test         # vitest run
bun run test:watch   # vitest watch
```

- Config: `vitest.config.ts`. Environment `happy-dom`, includes `src/**/*.test.ts`.
- `test/setup.ts` wires the test environment: installs `fake-indexeddb`, polyfills
  `HTMLMediaElement.HAVE_*` constants happy-dom omits, aliases `jest` to `vi` so
  `jest-webextension-mock` loads and provides `browser.*`, and polyfills
  `webNavigation.getAllFrames`.
- Coverage thresholds are enforced (statements/lines 85, functions 80, branches
  70). They cover the logic-heavy background/shared/content modules; browser-only
  `MediaRecorder` and UI paths are left to E2E.

Tests live next to their subject (`Foo.ts` -> `Foo.test.ts`). Logic-heavy modules
covered today: `Orchestrator`, `SessionState`, `Settings`, `Repository`,
`AudioEncoder`, `FilenameTemplate`, `NetworkRecorder`. The MAIN-world hooks
(`MediaElementHook`, `AudioContextHook`) and their ISOLATED drivers are covered
end-to-end by the Selenium suite, since they need a real `MediaRecorder`.

### End-to-end tests

```bash
bun run test:e2e     # builds with the bridge, then runs the Selenium suite
```

- Config: `vitest.e2e.config.ts`. Environment `node`, includes `test/e2e/**/*.test.ts`,
  long timeouts, `fileParallelism: false` (one Firefox at a time).
- `test/e2e/fixture.ts` builds a Firefox driver, sets autoplay-permitting prefs,
  and installs the **unpacked `dist/`** as a temporary add-on via
  `driver.installAddon(DIST_DIR, true)`. It throws if `dist/` is missing, so the
  build must run first (the `test:e2e` script chains them).
- The extension's origin UUID is randomized per profile, so `extensionBaseUrl`
  switches Marionette to the privileged **chrome** context and asks
  `WebExtensionPolicy.getByID(...).mozExtensionHostname` to discover it at
  runtime, yielding the `moz-extension://<uuid>` base.
- `test/e2e/server.ts` serves `test-pages/` over two random ports (a second port
  exists so an iframe can be genuinely cross-origin).
- `test/e2e/helpers.ts` drives recordings through the test bridge
  (`startRecording`/`stopRecording`/`armRecording` dispatch the custom event;
  `stopRecording` then waits a short settle window so the save lands before any
  navigation tears the recorder down) and asserts results by reading IndexedDB
  through the manager's runtime messaging. On a failed test, `dumpDiagnostics`
  saves a screenshot to `e2e-artifacts/` and prints the background log buffer
  (via `TEST_GET_LOGS`) so a red test shows *why*, not just "got null".

The `test-pages/` fixtures map one-to-one onto capture paths — see the
[strategy/test-page map](capture.md#strategy-and-e2e-test-page-map).

## Lint and format

```bash
bun run lint         # eslint over src
bun run lint:ext     # web-ext lint over dist (AMO validator)
bun run format       # prettier --write .
bun run format:check # prettier --check .
```

`lint:ext` runs the same validator Mozilla Add-ons (AMO) uses, against the built
`dist/`. Keep it clean — it is why the UI builds DOM structurally instead of from
HTML strings.

## Conventions

- **TypeScript strict**, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `isolatedModules` (see `tsconfig.json`). Expect to handle
  `undefined` from array/Map access and to use `import type` for type-only imports.
- **No `as` casts on messages** — narrow the discriminated union with a `switch`
  on `type` instead.
- **Untrusted input stays typed as the closed union.** The background treats
  inbound messages as `InboundMessage` and never trusts a payload before narrowing.
- **Logging** goes through `createLogger(tag)`; `debug` is gated behind the
  `verboseLogging` setting, `info`/`warn`/`error` always print.

## Change recipes

The highest-leverage reference for an agent: the exact set of files to touch for
each common change. File paths are the source of truth; line numbers drift.

### Add a capture strategy

1. **Recorder class** in `src/content/` implementing `IRecorder` (or the more
   specific `INetworkRecorder` from `src/types/index.ts`): `start(...)`,
   `stop(): Promise<CaptureResult>`, `isRecording()`, and an `onError` callback.
   If the strategy must reach page-world objects the ISOLATED script cannot (a
   detached element, an `AudioContext`), pair it with a self-contained
   `document_start` MAIN-world hook and talk over `window.postMessage` — see
   `MediaElementHook` / `AudioContextHook`.
2. **Message type** — add `START_<X>_CAPTURE` to `BgToContentMessage` in
   `src/types/index.ts`.
3. **Content handler** — in `src/content/index.ts`, add an `if (message.type === ...)`
   branch and a `handleStart<X>` that instantiates the recorder, wires `onError`
   via `wireErrors`, and sets `activeRecorder`.
4. **Orchestrator** — in `Orchestrator.startRecording`, add the strategy in the
   fallback chain in priority order; on success call `markRecording(tabId, frameId, ...)`.
   If the strategy needs a detection signal, add it to `SessionState`.
5. **Test** — add a `test-pages/` fixture and a case in `test/e2e/capture.test.ts`.

### Add a setting

1. **Model** — add the field to the `Settings` interface and `DEFAULT_SETTINGS`
   in `src/shared/Settings.ts`. `merge()` makes it backward-compatible automatically.
2. **Settings UI** — add the control to `src/settings/index.html`, a DOM ref and
   read/write wiring in `src/settings/index.ts` (`applyToForm` + `readForm`), and
   the change listener in `bindEvents`.
3. **Consumer** — read it via `getSettings()` wherever it applies (usually the
   orchestrator or an encoder). For live reaction, subscribe with
   `onSettingsChanged`.

### Add a message type

1. Add the variant to the right union in `src/types/index.ts`
   (`PopupToBgMessage`, `ManagerToBgMessage`, `ContentToBgMessage`, or
   `BgToContentMessage`). Background-inbound unions are aggregated into
   `InboundMessage`.
2. Add a `case` to the relevant `switch`/`if` router:
   background in `src/background/index.ts`, content in `src/content/index.ts`.
   Return a `Promise` for request/response, `undefined` for fire-and-forget.
3. Send it from the originating UI/realm with `browser.runtime.sendMessage` (or
   `browser.tabs.sendMessage` with a `{ frameId }` for background -> content).

### Add an export format

1. **Format metadata** — add the key to `ExportFormat` in `src/types/index.ts`
   and an entry to `FORMAT_META` / `EXPORT_FORMATS` in `src/shared/exportFormats.ts`
   (mime type, extension, label).
2. **Encoder** — add an `encode<X>(pcm, ...)` in `src/shared/AudioEncoder.ts` and
   a branch in `encodeForExport` that decodes and calls it.
3. The settings dropdown and filename preview pick up the new format
   automatically from `EXPORT_FORMATS` / `FORMAT_META`.

### Add a filename template variable

1. Add the token to `TEMPLATE_VARIABLES` and a resolver to `RESOLVERS` in
   `src/shared/FilenameTemplate.ts`.
2. Update the substitution + validation regexes in the same file (they enumerate
   the allowed variable names).
3. The settings page preview and validation update automatically.
