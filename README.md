# Tab Audio Recorder

A Firefox (Manifest V3) extension that records the audio playing in a browser
tab and saves it locally for sampling. It captures from regular `<audio>` /
`<video>` elements, raw network audio streams (e.g. web radios), and pages that
synthesize sound through the Web Audio API.

## Features

- **Three capture strategies, tried in order** so a single Record button works
  across very different sites:
  1. **Media element** — `captureStream()` on a played `<audio>`/`<video>`,
     found by hooking `play()` in the page so it also works for detached
     `new Audio()` players (e.g. WhatsApp Web voice messages) and elements in
     closed shadow roots.
  2. **Network stream** — when no media element exists, a detected audio stream
     URL (sniffed by `Content-Type`) is fetched and recorded.
  3. **Web Audio** — a `document_start` hook taps the page's `AudioContext`
     destination for sites that play purely through the Web Audio API.
- **Recordings manager** with per-site filtering, sorting, an inline lazy-loading
  player, export, and delete.
- **Export format**: recordings are captured as WebM/Opus and converted on
  export to **WAV** (lossless, larger) or **MP3** (smaller, uses the recording
  bitrate). Conversion runs in the background, so auto-export honors the choice.
- **Settings**: bitrate, max recording length (memory guard), export format,
  export subfolder, filename template, auto-export, storage cap with
  auto-cleanup, verbose logging.
- **Hotkey**: `Alt+Shift+R` toggles recording on the active tab.
- **DRM-aware**: EME/DRM-protected playback is detected and refused up front
  instead of saving silence.

## Install (development)

Requires [Bun](https://bun.sh) and Firefox.

```bash
bun install
bun run build          # outputs to dist/
```

Then either load it temporarily or run it with auto-reload:

```bash
# Auto-reload dev session (launches a clean Firefox with the extension):
bun run start

# Or load manually: open about:debugging#/runtime/this-firefox
# -> "Load Temporary Add-on" -> pick dist/manifest.json
```

## Scripts

| Command            | What it does                                     |
| ------------------ | ------------------------------------------------ |
| `bun run build`    | Production build into `dist/`                    |
| `bun run dev`      | Rebuild on change                                |
| `bun run start`    | Launch Firefox with the extension (web-ext)      |
| `bun run test`     | Vitest unit suite                                |
| `bun run test:e2e` | Selenium E2E suite (needs Firefox + geckodriver) |
| `bun run lint`     | ESLint over `src`                                |
| `bun run lint:ext` | `web-ext lint` over `dist` (AMO validator)       |
| `bun run format`   | Prettier write                                   |

## Architecture

The source is organized by execution context, which is the natural boundary for
a WebExtension:

- `src/background/` — the orchestrator. Owns per-tab recording state, routes the
  typed message bus, runs the three-strategy `startRecording`, and the
  save/export/prune pipeline. State is persisted to `storage.session` so it
  survives the non-persistent MV3 background being suspended mid-recording.
- `src/content/` — the capture strategies (`MediaElementRecorder`,
  `NetworkRecorder`, `WebAudioRecorder`) plus their `document_start` MAIN-world
  hooks `MediaElementHook` (taps played media elements, including detached ones)
  and `AudioContextHook` (Web Audio tap).
- `src/manager/`, `src/popup/`, `src/settings/` — the three UI surfaces.
- `src/shared/` — `Repository` (IndexedDB), `Settings`, `Logger`,
  `FilenameTemplate`, `SessionState`, `AudioEncoder` (WAV/MP3 transcode).
- `src/types/` — the domain model and the discriminated-union message bus.

Recordings are stored in IndexedDB (metadata + blob). Export decodes the blob,
re-encodes it to the chosen format (`AudioEncoder`), and saves it through the
`downloads` API with a user-defined filename template.

For the full internals — the message bus, the three-strategy capture pipeline,
the MV3 state machine, the export pipeline, and step-by-step change recipes — see
the developer documentation in [`docs/`](docs/README.md).

## Documentation

Developer- and agent-facing docs live in [`docs/`](docs/README.md):

- [docs/architecture.md](docs/architecture.md) — execution contexts, the typed
  message bus, and the end-to-end recording flow.
- [docs/capture.md](docs/capture.md) — the three capture strategies, media
  detection, and frame routing.
- [docs/storage-and-export.md](docs/storage-and-export.md) — IndexedDB
  persistence and the transcode/filename/download export pipeline.
- [docs/state-and-lifecycle.md](docs/state-and-lifecycle.md) — the per-tab state
  machine, MV3 suspension survival, and cleanup.
- [docs/development.md](docs/development.md) — build, test, the test bridge, and
  change recipes for extending the codebase.

## Permissions

Each permission is requested only for the functionality below:

| Permission                                          | Why it is needed                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<all_urls>` (host) + content scripts on all frames | Audio can play on any site and inside any frame; the recorder must be able to attach there.                                                                                |
| `tabs`                                              | Resolve the active tab and read its title/URL for recording metadata.                                                                                                      |
| `webNavigation`                                     | Enumerate frames to route capture/stop to the frame that actually has the audio, and clear state when a tab navigates away.                                                |
| `webRequest` (observe response headers)             | Detect audio stream URLs by `Content-Type` for the network-fetch strategy.                                                                                                 |
| `storage`                                           | Persist settings and in-flight recording state (`storage.session`).                                                                                                        |
| `downloads`                                         | Export saved recordings to disk.                                                                                                                                           |
| Web Audio hook in the MAIN world                    | Required to tap `AudioContext` audio on sites that never create a media element. It must run at `document_start` to intercept connections before the page wires its graph. |

## Privacy

The extension records audio **only** while you are actively recording a tab.
Recordings and settings are stored **locally** in your browser (IndexedDB and
extension storage). Nothing is uploaded, transmitted, or shared with any server;
the manifest declares no data collection (`data_collection_permissions: none`).
Export writes files to your own Downloads folder.

## Known limitations

- **DRM/EME** content (e.g. Netflix, Spotify web player) cannot be captured —
  Firefox yields a silent stream, so it is refused up front.
- The MV3 background is non-persistent; recording state is rehydrated from
  `storage.session` on wake, but a browser restart ends any in-flight recording.
- Long recordings are held in memory until stopped. Use the **Max recording
  length** setting as a memory guard for long streams.

## License

ISC — see [LICENSE](LICENSE).
