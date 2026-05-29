import { defineConfig } from 'vitest/config';

export default defineConfig({
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
