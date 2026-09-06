# Publishing to AMO (addons.mozilla.org)

How to publish Tab Audio Recorder to the official Firefox Add-ons store as a
**listed** add-on (publicly visible; Mozilla signs **and** distributes; Firefox
auto-updates installed copies). This is the supported path — not self-distribution
(unlisted), which would need an `update_url` the manifest deliberately omits.

The live listing is <https://addons.mozilla.org/firefox/addon/tab-audio-rec/>.

> **Never delete a submission to start over.** AMO permanently deny-lists the
> GUID of any deleted add-on, so `browser_specific_settings.gecko.id` can never
> be reused — the deny-list exists so nobody can hijack a deleted add-on's update
> path. The block only surfaces at upload time, as a duplicate-add-on-ID
> rejection. Recovering means regenerating the GUID in `src/manifest.json` plus
> the matching `EXT_ID` in `test/e2e/fixture.ts`. The slug is retained the same
> way: `tab-audio-recorder` was burned like this, hence `tab-audio-rec`.

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
> - `alarms`: wake the background for recording limits and stop timeouts.
>
> DRM/EME-protected playback is detected and refused up front (no silent capture).

## 4. Listing assets and metadata (AMO Developer Hub)

Prepared/owned in the portal, not in this repo.

**Required** — AMO will not create a listed add-on without these:

- **Name**, **summary** (≤ 250 characters), and **categories** (up to 2).
- **License:** ISC (matches `LICENSE`).

**Optional** — addable at any time from the Developer Hub, without submitting a
new version or triggering another review:

- **Description:** longer-form (the README's Features section is a good base).
- **Listing icon:** PNG or JPEG at 32x32 and 64x64 — ready to upload at
  `docs/listing/icon-32.png` and `docs/listing/icon-64.png`, rasterized from
  `src/public/icons/icon.svg` with transparency preserved. Needed whenever AMO
  falls back to a generic icon instead of using the SVG shipped in the package.
- **Screenshots:** 1280x800 (1.6:1), showing the popup, recordings manager, and
  settings.
- **Support:** email and/or the GitHub repo. **Privacy policy:** unnecessary
  here because data collection is `none`.

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

A listed add-on's public page 404s for anonymous visitors until the review
clears; the author still sees it while signed in, so "the page is up for me" is
not evidence that it is live.

## 6. Tag the GitHub release

Cut the release **after** the commit that produced the uploaded zip. The tag is
the record of exactly what AMO received, and `package:source` archives `HEAD`, so
a tag left behind on an earlier commit ships different code than the reviewer
rebuilt.

```bash
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
gh release create vX.Y.Z --notes-from-tag
```

Do not attach a built `.xpi` or zip to the release. The only signed copies come
from AMO; an unsigned artifact next to a store listing invites people to sideload
something Firefox will refuse to install anyway.

Bump `version` in both `package.json` and `src/manifest.json` before each new
submission — AMO rejects re-uploading an existing version.
