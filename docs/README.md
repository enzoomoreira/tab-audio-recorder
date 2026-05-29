# Documentation

Developer- and agent-facing documentation for Tab Audio Recorder. These docs
explain how the extension works internally and where to make changes. For the
user-facing overview (features, install, permissions, privacy), see the root
[README](../README.md).

## Reading order

If you are new to the codebase, read in this order:

1. **[architecture.md](architecture.md)** — the big picture: execution contexts,
   the manifest wiring, the module map, the typed message bus, and the
   end-to-end flow of one recording. Start here.
2. **[capture.md](capture.md)** — the three capture strategies (DOM, network,
   Web Audio), media detection, and frame routing.
3. **[storage-and-export.md](storage-and-export.md)** — IndexedDB persistence,
   the domain model, and the transcode -> filename -> download export pipeline.
4. **[state-and-lifecycle.md](state-and-lifecycle.md)** — the per-tab state
   machine, surviving an MV3 background suspension, watchdogs, and cleanup.
5. **[development.md](development.md)** — build, run, test, the test-bridge
   mechanism, and step-by-step change recipes.

## If you are changing X, read Y

| You are working on...                           | Read                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A new capture path / why a site does not record | [capture.md](capture.md) + [development.md](development.md#add-a-capture-strategy)                       |
| Recording reliability, stuck UI, MV3 wake bugs  | [state-and-lifecycle.md](state-and-lifecycle.md)                                                         |
| Export formats, filenames, downloads, encoding  | [storage-and-export.md](storage-and-export.md)                                                           |
| The database schema or queries                  | [storage-and-export.md](storage-and-export.md#persistence-indexeddbrepository)                           |
| A new message between realms                    | [architecture.md](architecture.md#the-message-bus) + [development.md](development.md#add-a-message-type) |
| A new setting                                   | [development.md](development.md#add-a-setting)                                                           |
| Build, tests, or the test bridge                | [development.md](development.md)                                                                         |
| The UI (popup / manager / settings)             | [architecture.md](architecture.md#module-map) (module map)                                               |

## Source-of-truth note

Code is the source of truth; these docs cite files (and occasionally `file:line`)
so claims stay verifiable. Line numbers drift — trust the file path and the
surrounding description over an exact line. When code and a doc disagree, the
code is right and the doc should be fixed.
