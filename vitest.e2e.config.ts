import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    // Reap geckodriver/firefox processes selenium leaks on Windows (see the file).
    globalSetup: ['./test/e2e/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
    globals: false,
    typecheck: { enabled: false },
  },
});
