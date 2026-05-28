// Global test setup: install fake-indexeddb, fix happy-dom HTMLMediaElement,
// and load the community WebExtensions mock so `browser.*` and `chrome.*` are
// available with proper `jest.fn`-style stubs.

import 'fake-indexeddb/auto';
import { vi } from 'vitest';

// happy-dom doesn't define HTMLMediaElement.HAVE_* constants; install them
// so `readyState >= HAVE_CURRENT_DATA` comparisons work.
const Media = (globalThis as { HTMLMediaElement?: unknown }).HTMLMediaElement;
if (typeof Media === 'function') {
  const ctor = Media as unknown as Record<string, number>;
  if (ctor['HAVE_NOTHING'] === undefined) ctor['HAVE_NOTHING'] = 0;
  if (ctor['HAVE_METADATA'] === undefined) ctor['HAVE_METADATA'] = 1;
  if (ctor['HAVE_CURRENT_DATA'] === undefined) ctor['HAVE_CURRENT_DATA'] = 2;
  if (ctor['HAVE_FUTURE_DATA'] === undefined) ctor['HAVE_FUTURE_DATA'] = 3;
  if (ctor['HAVE_ENOUGH_DATA'] === undefined) ctor['HAVE_ENOUGH_DATA'] = 4;
}

// jest-webextension-mock calls `jest.fn()` internally. Vitest exposes the same
// API under `vi`; aliasing lets the library load unchanged.
(globalThis as { jest?: unknown }).jest = vi;
await import('jest-webextension-mock');

// Polyfill APIs not covered by jest-webextension-mock (or where its defaults
// don't fit our tests).
const b = (globalThis as { browser?: Record<string, unknown> }).browser ?? {};
const webNav = (b['webNavigation'] as Record<string, unknown> | undefined) ?? {};
if (typeof webNav['getAllFrames'] !== 'function') {
  webNav['getAllFrames'] = vi.fn(async () => [{ frameId: 0 }]);
  b['webNavigation'] = webNav;
}
(globalThis as { browser?: unknown }).browser = b;
