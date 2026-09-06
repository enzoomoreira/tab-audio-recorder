# Incremental recording: implementation and validation

Date: 2026-09-06.

## Problem and scope

A user reported losing the exported file after recording for about 20 minutes.
The original implementation retained the full capture in memory until Stop and
decoded the entire recording to export WAV/MP3. Download acceptance was reported
as success without waiting for the file to finish. The specific reviewer's failure
was not reproduced; these were separate implementation risks identified in the
recording and export paths.

The implemented scope is incremental browser storage, bounded pending writes,
interrupted-session visibility, conversion-free export and explicit download
outcomes. It does not include native filesystem streaming, a streaming WAV/MP3
encoder, container repair, or a guarantee of playable recovery after every crash.

## Implementation plan and completion

- [x] Allocate an owned capture session before each start/arm command. Route
      chunks, completion and errors by capture ID, tab and frame.
- [x] Upgrade IndexedDB to version 2 with an ordered `chunks` store. Preserve
      existing recordings in the original blob store.
- [x] Commit each chunk and metadata progress atomically, acknowledging only
      after transaction completion. Enforce sequence and final-count checks.
- [x] Replace whole-capture arrays in the media-element, Web Audio and network
      strategies with `ChunkSink`. Bound pending work to 16 chunks / 8 MiB and stop
      capture on acknowledgment timeout, storage failure or overflow.
- [x] Drain pending writes and finalize metadata at Stop without assembling audio.
      Assemble saved chunks only for playback/export.
- [x] Reconcile inactive sessions as interrupted recordings, retaining available
      committed bytes and showing size/duration. Remove empty/discarded sessions.
- [x] Add Original export and make it the default for new/reset settings, keeping
      stored preferences. Always export interrupted recordings as original bytes.
- [x] Wait for download completion, display failures and unconfirmed suspension,
      and retain the stored recording when export fails.
- [x] Exclude active/interrupted captures from retention pruning, block active
      playback/export/delete, and expose committed progress in the popup.
- [x] Adapt existing test fixtures and update user/developer documentation.

Implementation details are in [capture.md](capture.md),
[storage-and-export.md](storage-and-export.md) and
[state-and-lifecycle.md](state-and-lifecycle.md).

## Verified outcomes

The following checks were executed during implementation. Mock-based checks and
real Firefox checks are distinguished deliberately.

Browser checks used Firefox 155.0.1 on Windows 11. The minimum supported Firefox
version was not separately exercised. No local development server was started:
the scripts generate audio on an example.com page in an isolated test profile.

| Check                                                                                              | Environment                              | Result                                                                                                                      |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Existing unit suite after API/fixture adaptations                                                  | Vitest                                   | 79 tests passed                                                                                                             |
| Original export MIME mapping and no conversion                                                     | Bun ad hoc execution                     | Seven MIME cases passed; exported Blob retained object identity while its `arrayBuffer` method deliberately threw if called |
| Unsupported original MIME                                                                          | Bun ad hoc execution                     | Rejected explicitly                                                                                                         |
| Download completion, early completion before ID resolution, interruption, rejection and suspension | Bun with browser API stubs               | Correct outcomes; listeners removed                                                                                         |
| Incremental commits before Stop                                                                    | Firefox, short production-build captures | Media-element and Web Audio captures persisted audio before stopping                                                        |
| Completed capture playback                                                                         | Firefox, short production-build captures | Stop completed; captured media-element and Web Audio audio decoded and was non-silent                                       |
| Original download                                                                                  | Firefox, short production-build capture  | Download completed                                                                                                          |
| Navigation interruption                                                                            | Firefox, production build                | Navigation ended capture and retained saved bytes as interrupted                                                            |
| Type checking                                                                                      | TypeScript                               | Passed during the documentation consistency check; final root verification may supersede this snapshot                      |

Additional final-source checks passed:

- Armed playback persisted audio and completed at Stop.
- Clearing `storage.session` and reloading the extension simulated restart
  bookkeeping. The same extension UUID reopened 33,611 saved bytes as interrupted.
  This was not a browser/OS crash test.
- With WAV selected, interrupted export produced WebM whose SHA-256 matched the
  saved Blob. The download existed on disk and reached `complete`.
- The manager's interrupted-recording warning was checked in the DOM and visually.
- Ad hoc execution checked stale-error isolation, chunk ownership and sequence
  rejection, active recording guards, committed progress, preserved interrupted
  bytes, and return to idle after storage allocation failure.
- TypeScript, ESLint, formatting, and extension validation passed. Extension
  validation reported zero errors, notices, and warnings.

### Long-recording validation

- [x] Complete the actual 20-minute Firefox recording.
- [x] Record its committed progress before Stop, final duration/size, download
      outcome and playback/decode result here.

Status: **passed** on generated audio in Firefox. The real-time run persisted
1,192 chunks / 19,686,600 bytes before Stop, at 1,191,980 ms of elapsed capture.
Stop finalized 1,201 chunks / 19,821,723 bytes, with metadata duration 1,200,141 ms.
The saved WebM decoded to 1,200.1735 seconds of non-silent audio (sampled peak
0.15259), and Original export reached download completion. The same run's
subsequent navigation-recovery and Web Audio checks passed.

The long run exercised the incremental capture pipeline while final message
ownership and UI refinements were being completed. A separate short run against
the final build passed media-element capture, Web Audio capture, interrupted
navigation, decoding and downloads; the final-source restart simulation also
passed. This is evidence for these tested cases, not universal site coverage or
an OS-crash recovery guarantee.

## Remaining limits

The queue limits bound application-owned pending audio, not total Firefox memory.
The browser's recorder/network internals can buffer data, and playback/export
still assembles saved chunks. WAV/MP3 conversion still decodes the full recording
and allocates PCM/encoding buffers; Original avoids this conversion cost.

`MediaRecorder.start(1000)` requests periodic delivery, not exact one-second
saves. Committed audio can outlive a capture interruption, but the unsaved tail
can be lost. Incomplete MediaRecorder containers may not play without external
repair; no repair/remux implementation is included. Browser-data removal, storage
quota, disk failure and abrupt crashes remain limits.

Incremental data stays in extension-owned browser storage until export. The
downloads API is used for the final file and does not provide an appendable
Downloads file during capture. Listing text is prepared in
[publishing.md](publishing.md#recordingstorage-description-for-the-updated-listing);
the live AMO listing has not been changed by this implementation.

## Runtime references

- [MediaStream Recording specification](https://www.w3.org/TR/mediastream-recording/):
  individual blobs need not be playable; completed recordings have a different
  guarantee from interrupted prefixes.
- [MDN downloads.download](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/download):
  the returned download ID starts tracking a download, rather than confirming its
  completion.
- [MDN background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts):
  Firefox MV3 uses non-persistent event pages; open extension views and message
  ports affect their lifetime.
