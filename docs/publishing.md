# Publishing to AMO (addons.mozilla.org)

How to publish Tab Audio Recorder to the official Firefox Add-ons store as a
**listed** add-on (publicly visible; Mozilla signs **and** distributes; Firefox
auto-updates installed copies). This is the supported path — not self-distribution
(unlisted), which would need an `update_url` the manifest deliberately omits.

## Why a source-code submission is required

The packaged extension is **bundled and transpiled** with Vite (the shipped
`background/index.js` is ~180 kB of generated code). AMO policy requires the
matching **source code plus build instructions** for any add-on containing
machine-generated code, and a reviewer must be able to rebuild it and get a
byte-identical result. So every submission needs **two** uploads: the built
extension zip and the source zip.

See: <https://extensionworkshop.com/documentation/publish/source-code-submission/>

## 1. Build the two packages

```bash
bun run package          # built extension -> web-ext-artifacts/tab_audio_recorder-<version>.zip
bun run package:source   # source archive  -> web-ext-artifacts/tab-audio-recorder-source.zip
```

- `package` runs a production build (no test bridge) and zips `dist/` with
  `manifest.json` at the **root** of the archive — the shape AMO expects.
- `package:source` runs `git archive` over `HEAD`, so the source zip contains
  exactly the tracked files (source, configs, and the `bun.lock` lockfile) and
  nothing ignored (`node_modules/`, `dist/`, artifacts). **Commit first** —
  uncommitted changes are not included.

## 2. Build instructions for reviewers

Attach these alongside the source upload (the reviewer rebuilds and diffs the
output against the submitted package — there must be no differences):

- **OS:** any (Linux, macOS, or Windows). No OS-specific steps.
- **Toolchain:** [Bun](https://bun.sh) `1.3.11` (the only build tool needed; it
  is the package manager and the script runner). No global packages required.
- **Commands:**
  ```bash
  bun install --frozen-lockfile   # installs the exact versions from bun.lock
  bun run build                   # Vite production build -> dist/
  ```
- **Result:** `dist/` is the unpacked extension; its contents match the submitted
  extension zip (`manifest.json` at the root). The build is deterministic for a
  given Bun version + lockfile.

Keep the Bun version above in sync with the version used to cut the release
(`bun --version`).

## 3. Notes for reviewers (paste into the submission form)

Broad host access plus media capture makes this add-on a likely candidate for
manual review, so justify the surface explicitly:

> Tab Audio Recorder records the audio of the user's active tab, on demand, and
> saves it locally (IndexedDB) for later export to a file. Nothing is transmitted
> off-device — the manifest declares `data_collection_permissions: ["none"]`.
>
> Permission rationale:
>
> - `<all_urls>` (host) + content scripts on all frames: audio can play on any
>   site and inside any (possibly cross-origin) frame; the recorder must attach
>   there to capture it.
> - `world: "MAIN"` content scripts (`AudioContextHook`, `MediaElementHook`):
>   required to tap the page's own `AudioContext` and to capture media elements
>   the page never inserts into the DOM (detached `new Audio()` players). These
>   hooks only mirror/observe audio; they never exfiltrate page data.
> - `webRequest` (response headers only): detect audio stream URLs by
>   `Content-Type` for the network-fetch capture strategy.
> - `webNavigation`: enumerate frames to route capture/stop to the right frame,
>   and clear state on navigation.
> - `tabs`: read the active tab's title/URL for recording metadata.
> - `downloads`: export saved recordings to the user's Downloads folder.
>
> DRM/EME-protected playback is detected and refused up front (no silent capture).

## 4. Listing assets and metadata (AMO Developer Hub)

Prepared/owned in the portal, not in this repo:

- **Listing icon:** PNG or JPEG at **32x32 and 64x64** — AMO does **not** accept
  SVG for the listing icon (the SVG in the manifest is fine for the runtime).
  Rasterize `src/public/icons/icon.svg` to those sizes.
- **Screenshots:** 1280x800 (1.6:1), showing the popup, recordings manager, and
  settings.
- **Summary:** ≤ 250 characters. **Description:** longer-form (the README's
  Features section is a good base).
- **Categories:** up to 2. **Support:** email and/or the GitHub repo.
- **License:** ISC (matches `LICENSE`). **Privacy policy:** optional here because
  data collection is `none`; linking one is still good practice.

## 5. Submit

1. Sign in to the [Developer Hub](https://addons.mozilla.org/developers/) and
   accept the agreement.
2. Upload `web-ext-artifacts/tab_audio_recorder-<version>.zip` on the **"On this
   site" (listed)** channel; let automated validation pass.
3. When asked, choose **"Yes, this add-on requires source code"** and upload
   `web-ext-artifacts/tab-audio-recorder-source.zip` with the build instructions
   from section 2.
4. Fill in the listing metadata (section 4) and the reviewer notes (section 3).
5. Submit. Signing/publishing is usually within ~24h, longer if selected for
   manual review.

Bump `version` in both `package.json` and `src/manifest.json` before each new
submission — AMO rejects re-uploading an existing version.
