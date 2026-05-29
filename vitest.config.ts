import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Unit tests are never the E2E bridge build; define the flag so the build-time
  // `__TEST_BRIDGE__` constant resolves (the production build sets it via vite).
  define: { __TEST_BRIDGE__: 'false' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    globals: false,
    typecheck: { enabled: false },
    coverage: {
      // Reports cover the modules exercised by the unit suite (logic-heavy
      // background/shared/content code). Browser-only UI and MediaRecorder
      // paths are validated by the Selenium E2E suite instead.
      thresholds: {
        statements: 85,
        lines: 85,
        functions: 80,
        branches: 70,
      },
    },
  },
});
