# Storage and export

Once a recording is captured it lives in two phases: **stored** in IndexedDB as
captured (WebM/Opus), and **exported** on demand to a file on disk (WAV or MP3).
This document covers the persistence layer, the domain model, and the export
pipeline (transcode + filename + download).

## Domain model

Defined in `src/types/index.ts`:

```ts
interface RecordingMetadata {
  id: string; // rec_<timestamp>_<random>
  sourceUrl: string;
  sourceHost: string; // used for the per-site filter
  sourceTitle: string;
  mimeType: string; // the captured container, e.g. audio/webm;codecs=opus
  durationMs: number;
  sizeBytes: number;
  startedAt: number; // epoch ms; also the default sort key
  endedAt: number;
}

interface Recording {
  metadata: RecordingMetadata;
  blob: Blob;
}
```

Metadata and the (potentially large) blob are stored separately so the manager
can list recordings cheaply without loading audio into memory.

## Persistence: IndexedDBRepository

`src/shared/Repository.ts` is the only place the database is touched. It
implements the `IRepository` interface from `src/types/index.ts`.

### Schema

- Database `tab-audio-recorder`, version `1`.
- Object store `metadata`, `keyPath: 'id'`, with two indexes:
  - `sourceHost` (for per-site filtering)
  - `startedAt` (for chronological sorting / pruning)
- Object store `blobs`, `keyPath: 'id'`, holding `{ id, blob }`.

`save` and `deleteById` write both stores inside a single read-write transaction,
so metadata and blob never drift apart.

### API

| Method                 | Notes                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `save(recording)`      | Puts metadata + blob; returns the id                          |
| `list(filter?, sort?)` | Returns metadata only (no blobs); filters and sorts in memory |
| `getById(id)`          | Full `Recording` (metadata + blob), or `null`                 |
| `getBlobById(id)`      | Just the blob (used by the manager for playback)              |
| `deleteById(id)`       | Removes from both stores                                      |

`list` reads all metadata via `getAll()`, then applies the `RecordingFilter`
(`host`, `dateFrom`, `dateTo`) and `SortOptions` (`field` x `direction`,
defaulting to `startedAt desc`) in JavaScript. This is fine for the expected
volume; if the dataset grew large, the `startedAt` index would be the place to
push sorting into IndexedDB.

> Tests run against `fake-indexeddb` (installed in `test/setup.ts`), so
> `Repository.test.ts` exercises the real query logic without a browser.

## Export pipeline

Triggered by `EXPORT_RECORDING` from the manager, or automatically after save
when `settings.autoExport` is on. Orchestrated by `exportRecording`
(`src/background/Orchestrator.ts:332`). Three stages: transcode, name, download.

### 1. Transcode (`src/shared/AudioEncoder.ts`)

`encodeForExport(blob, format, opts)` decodes the captured blob and re-encodes it
to the chosen format. It runs in the **background** event page, which is why both
manual and auto-export honor the format setting (Firefox MV3 retains Web Audio
there).

- **Decode.** `AudioContext.decodeAudioData` turns the WebM/Opus blob into PCM.
  `arrayBuffer()` is read fresh each call because `decodeAudioData` detaches the
  buffer.
- **WAV** (`encodeWav`): writes a 16-bit little-endian RIFF/WAVE stream directly
  from the PCM channels. Lossless, larger files.
- **MP3** (`encodeMp3`): uses `@breezystack/lamejs`. Encodes in 1152-sample
  blocks (one MPEG granule pair), mono or stereo, at the target kbps.
  - MP3 only supports a fixed set of sample rates. If the decoded buffer's rate
    is outside the set, the blob is **re-decoded at 44100 Hz** before encoding.
  - The target bitrate is derived from the recording bitrate
    (`settings.bitrate / 1000`) and clamped to `[8, 320]` kbps.

Format metadata (mime type, extension, label) lives in `src/shared/exportFormats.ts`
(`FORMAT_META`), intentionally separate from the encoder so the settings page can
import labels without pulling in lamejs.

### 2. Filename (`src/shared/FilenameTemplate.ts`)

`applyTemplate(template, metadata, extension)` renders the download filename from
the user's template string.

- **Variables:** `{host}`, `{title}`, `{date}` (YYYY-MM-DD), `{time}` (HH-MM-SS),
  `{timestamp}` (epoch ms). Default template: `{host}_{date}_{time}`.
- Each substituted value is sanitized (filesystem-invalid chars -> `_`), the full
  basename is truncated to 200 chars, and the format's extension is appended.
- Falls back to `recording.<ext>` if substitution yields an empty string.
- `validateTemplate` is used by the settings UI to reject an empty template or
  one with no recognized variable (the live preview shows the result).

If `settings.exportSubfolder` is set, the filename is prefixed with
`<subfolder>/`, so downloads land in a subfolder of the browser's Downloads
directory.

### 3. Download (`src/background/Orchestrator.ts`)

- `URL.createObjectURL(encoded.blob)` -> `browser.downloads.download` with
  `conflictAction: 'uniquify'` (auto-suffix on name clash) and `saveAs: false`.
- The object URL is **revoked** once the download reaches a terminal state
  (`complete` or `interrupted`), via a `downloads.onChanged` listener that removes
  itself. This prevents leaking object URLs in the long-lived background.

## Retention: pruning

After a successful save, if `settings.maxRecordings > 0`, `pruneOldRecordings`
lists recordings oldest-first and deletes the excess beyond the cap. `0` means
unlimited. This is the only automatic deletion; everything else is user-initiated
from the manager.

## In-page playback (recordings view)

The recordings view does not export to play. `AudioPlayer` (`src/app/AudioPlayer.ts`)
lazily fetches the blob via `GET_BLOB` on first play, wraps it in an object URL,
and caches that URL across Play and Export for the card. The view revokes all
cached URLs on `pagehide` and when a recording is deleted. See the player's
lazy-load notes inline in `AudioPlayer.ts`.
