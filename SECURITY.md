# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities.

Report them privately through GitHub's
[**Security Advisories**](https://github.com/YOUR-USERNAME/tab-audio-recorder/security/advisories/new)
("Report a vulnerability" on the repository's **Security** tab). Include:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- the affected version (see `version` in `src/manifest.json`).

You can expect an acknowledgement within a few days. Once the issue is confirmed
and a fix is available, a new signed version is published through
[addons.mozilla.org](https://addons.mozilla.org), and the report is credited
unless you prefer to stay anonymous.

## Scope

This is a browser extension that requests broad host access (`<all_urls>`) and
observes network response headers (`webRequest`) so it can attach a recorder to
audio playing on any site. Reports that are especially relevant:

- ways the recorder could be triggered without the user's action,
- leakage of recorded audio or metadata outside the local browser storage,
- privilege escalation from a page (content/MAIN world) into the background,
- bypasses of the DRM/EME refusal path.

The extension stores recordings and settings **locally only** (IndexedDB and
extension storage) and uploads nothing; a report showing otherwise is in scope.
