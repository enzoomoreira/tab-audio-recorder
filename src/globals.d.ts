/**
 * Build-time constants injected by Vite's `define` (see vite.config.ts).
 *
 * `__TEST_BRIDGE__` is true only when building for the E2E suite. Production
 * builds get `false`; the dead-code branches are then stripped by the minifier.
 */
declare const __TEST_BRIDGE__: boolean;
