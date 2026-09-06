# Storage and export

Audio is **stored incrementally** in IndexedDB while recording and **exported**
on demand to a user-visible file, either in its original format or as WAV/MP3.
This document covers the persistence layer, the domain model, and the export
pipeline (transcode + filename + download).

## Domain model

Defined in `src/types/index.ts`:

```ts
interface RecordingMetadata {
  id: string; // rec_<UUID>, allocated before capture starts
  sourceUrl: string;
  sourceHost: string; // used for the per-site filter
  sourceTitle: string;
  mimeType: string; // the captured container, e.g. audio/webm;codecs=opus
  durationMs: number;
  sizeBytes: number;
  startedAt: number; // epoch ms; also the default sort key
  endedAt: number;
  status?: 'recording' | 'complete' | 'interrupted';
  nextSequence?: number;
  ownerTabId?: number;
  ownerFrameId?: number;
}

interface Recording {
  metadata: RecordingMetadata;
  blob: Blob;
}
```

Metadata and audio are stored separately so listing recordings does not load
audio. Older saved recordings have no status or chunk ownership fields and
remain readable from the existing blob store.

## Persistence: IndexedDBRepository

`src/shared/Repository.ts` is the only place the database is touched. It
implements the `IRepository` interface from `src/types/index.ts`.

### Schema

- Database `tab-audio-recorder`, version `2` (upgraded in place).
- Object store `metadata`, `keyPath: 'id'`, with two indexes:
  - `sourceHost` (for per-site filtering)
  - `startedAt` (for chronological sorting / pruning)
- Object store `blobs`, `keyPath: 'id'`, holding existing `{ id, blob }` recordings.
- Object store `chunks`, `keyPath: ['id', 'sequence']`, with an `id` index,
  holding `{ id, sequence, blob }` for new captures.

`beginCapture` allocates metadata and the tab/frame owner before sending the
capture command. `appendCapture` commits each ordered chunk and its updated byte
count, timestamps and next sequence in one read-write transaction. Acknowledgment
waits for the transaction's `complete` event; an abort rejects the operation even
if individual requests already succeeded. Ownership, sequence and chunk count
checks reject stale or incomplete capture messages.

The content-side `ChunkSink` serializes writes and bounds pending work to 16
chunks / 8 MiB; MAIN-world hooks also bound unacknowledged chunks. An acknowledgment
timeout, storage failure, or queue overflow stops capture instead of accumulating
unlimited pending audio. `MediaRecorder.start(1000)` requests periodic chunks;
it does not guarantee one-second delivery or disk durability on that schedule.

Stop drains pending writes and `saveCapture` finalizes metadata without assembling
the audio. `getById` assembles ordered chunks into a Blob only for playback/export;
this stage can still consume memory proportional to the recording. The default
Original export avoids the much larger full-audio PCM decode.

### API

| Method                    | Notes                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| `getMetadataById(id)`     | Reads metadata without loading audio; used for progress and active-capture checks |
| `begin(metadata)`         | Allocates a capture session before capture starts                                 |
| `append(...)`             | Verifies ownership/sequence and commits chunk + progress                          |
| `finalize(...)`           | Verifies final chunk count and marks the capture complete                         |
| `interrupt(id)`           | Retains nonempty captures as interrupted; removes empty sessions                  |
| `interruptAllExcept(ids)` | Reconciles stored captures with live session IDs on wake                          |
| `list(filter?, sort?)`    | Returns metadata only (no blobs); filters and sorts in memory                     |
| `getById(id)`             | Full `Recording`, assembling chunks on demand, or `null`                          |
| `getBlobById(id)`         | Just the blob (used by the manager for playback)                                  |
| `deleteById(id)`          | Removes metadata, existing blob and chunks atomically                             |

`list` reads all metadata via `getAll()`, then applies the `RecordingFilter`
(`host`, `dateFrom`, `dateTo`) and `SortOptions` (`field` x `direction`,
defaulting to `startedAt desc`) in JavaScript. This is fine for the expected
volume; if the dataset grew large, the `startedAt` index would be the place to
push sorting into IndexedDB.

`RecordingsService` refuses playback, export and deletion while the recording is
active, before loading its audio. The popup polls committed byte count and
saved-through duration every two seconds while recording.

> Tests run against `fake-indexeddb` (installed in `test/setup.ts`), so
> `Repository.test.ts` exercises the real query logic without a browser.

## Export pipeline

Triggered by `EXPORT_RECORDING` from the manager, or automatically after save
when `settings.autoExport` is on. Orchestrated by `exportRecording`
(`src/background/RecordingsService.ts`). Three stages: preserve/convert, name,
download. Auto-export failure is returned explicitly as "Recording saved in
Recordings, but auto-export failed"; the stored recording is retained.

### 1. Preserve or convert (`src/shared/AudioEncoder.ts`)

`encodeForExport(blob, format, opts)` preserves Original exports or converts WAV/MP3.
The **background** event page coordinates both manual and auto-export, including
Web Audio decoding. WAV/MP3 PCM encoding runs in a dedicated Worker
(`EncodingWorker.ts`, `encoding.worker.ts`, `PcmEncoder.ts`), so its synchronous
encoding loops do not block capture message handling. The Worker is terminated
on completion or failure.

- **Original** returns the same Blob without `arrayBuffer()` or decoding. Its
  extension comes from the actual MIME type (WebM, Ogg, MP3, AAC, MP4/M4A, WAV,
  FLAC); unknown MIME types fail explicitly rather than receive a guessed extension.
  This is the default for new/reset settings; stored user choices are preserved.
  Original exports also bypass the conversion queue.
- **Decode for WAV/MP3.** `AudioContext.decodeAudioData` turns the audio blob into PCM.
  `arrayBuffer()` is read fresh each call because `decodeAudioData` detaches the
  buffer. Decoding and encoding share a serial queue, so only one conversion job
  runs at a time; a failed job does not prevent subsequent jobs from running.
- **WAV** (`encodeWav`): writes a 16-bit little-endian RIFF/WAVE stream directly
  from the PCM channels. Lossless, larger files.
- **MP3** (`encodeMp3`): uses `@breezystack/lamejs`. Encodes in 1152-sample
  blocks (one MPEG granule pair), mono or stereo, at the target kbps.
  - MP3 only supports a fixed set of sample rates. If the decoded buffer's rate
    is outside the set, the blob is **re-decoded at 44100 Hz** before encoding.
  - The target bitrate is derived from the recording bitrate
    (`settings.bitrate / 1000`) and clamped to `[8, 320]` kbps.

WAV/MP3 still decode the entire recording and allocate encoding buffers; MP3's
block loop does not make this a bounded-memory converter. Recommend Original for
long recordings. Worker isolation does not make conversion a streaming or
bounded-memory operation.

Format metadata (mime type, extension, label) lives in `src/shared/exportFormats.ts`
(`FORMAT_META`, `EXPORT_FORMAT_LABELS`, `originalExtension`), separate from the encoder so the settings page can
import labels without pulling in lamejs.

### 2. Filename (`src/shared/FilenameTemplate.ts`)

`applyTemplate(template, metadata, extension)` renders the download filename from
the user's template string.

- **Variables:** `{host}`, `{title}`, `{date}` (YYYY-MM-DD), `{time}` (HH-MM-SS),
  `{timestamp}` (epoch ms). Default template: `{host}_{date}_{time}`.
- Each substituted value is sanitized (filesystem-invalid chars -> `_`), the full
  basename is truncated to 200 chars, leading dots and trailing dots/spaces are
  removed, and the format's extension is appended.
- Falls back to `recording.<ext>` if substitution yields an empty string.
- `validateTemplate` is used by the settings UI to reject an empty template or
  one with no recognized variable (the live preview shows the result).

If `settings.exportSubfolder` is set, the filename is prefixed with
`<subfolder>/`, so downloads land in a subfolder of the browser's Downloads
directory.
`validateSubfolder` rejects absolute paths, empty/dot-prefixed segments and invalid
filename characters before settings are saved. `buildDownloadPath` shares this
policy between the live preview and actual downloads; existing invalid settings
also fail explicitly at export time.

### 3. Download (`src/background/RecordingsService.ts`)

- `URL.createObjectURL(encoded.blob)` -> `browser.downloads.download` with
  `conflictAction: 'uniquify'` (auto-suffix on name clash) and `saveAs: false`.
- The object URL is **revoked** once the download reaches a terminal state
  (`complete` or `interrupted`), via a `downloads.onChanged` listener that removes
  itself. This prevents leaking object URLs in the long-lived background.
- The listener is installed before requesting the download so an early completion
  cannot be missed. The manager reports **Download completed** only after a
  `complete` event, and displays interruption/rejection details visibly.
- If the background begins suspending before confirmation, export reports that
  completion could not be confirmed and directs the user to Firefox Downloads.
  The saved recording remains available. This is not persistent tracking of a
  download across a browser restart.

The downloads API creates the exported file after capture; it does not append
chunks to a user-selected file during recording. Incremental storage stays inside
the browser profile.

## Interrupted recordings

Navigation, tab closure, capture errors and timeouts mark nonempty sessions
interrupted. On background startup, sessions absent from restored `storage.session`
are reconciled the same way; a browser restart ends capture rather than resuming it.
Empty sessions are removed. The manager shows preserved size and saved-through
duration, with actions disabled while a capture is active.

Only committed bytes are available. Individual MediaRecorder chunks and interrupted
prefixes are not guaranteed playable; this implementation preserves bytes but does
not repair/remux containers. Interrupted recordings always export their original
bytes regardless of the format setting, retaining data for external repair.
Storage quota, browser-data removal, disk failure and abrupt
crashes remain limits; transaction acknowledgment is not a universal crash-recovery
guarantee. See the [MediaStream Recording specification](https://www.w3.org/TR/mediastream-recording/)
for the distinction between individual blobs and completed recordings.

## Retention: pruning

After a successful save, if `settings.maxRecordings > 0`, `pruneOldRecordings`
lists completed recordings oldest-first and deletes the excess beyond the cap.
Active and interrupted captures are excluded, and failed auto-export skips pruning.
`0` means unlimited completed recordings. Empty or discarded capture sessions are
also removed as part of capture cleanup; manual deletion remains available for
completed/interrupted recordings.

## In-page playback (recordings view)

The recordings view does not export to play. `AudioPlayer` (`src/app/AudioPlayer.ts`)
lazily fetches the blob via `GET_BLOB` on first play, wraps it in an object URL,
and caches that URL for playback; export runs independently in the background. The view revokes all
cached URLs on `pagehide` and when a recording is deleted. See the player's
lazy-load notes inline in `AudioPlayer.ts`.
Pending blob loads are invalidated when a player is destroyed, and failed loads
can be retried. The list discards outdated responses after a newer filter request.
The visible recordings section refreshes every two seconds and on focus,
visibility or section changes. Existing cards keep their player instances when
their metadata is unchanged, so refreshes do not restart playback; changed capture
metadata updates size, status and available actions.

Settings changes are queued in order. Reset cancels pending debounce work and
runs after any in-flight save; storage failures remain visible in the settings view.
