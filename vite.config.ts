import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';

// Build-time flag for the E2E test bridge (see src/content/index.ts). The bridge
// lets specs trigger record/stop via dispatchEvent on localhost; it MUST NOT
// ship in production builds or any localhost page could trigger silent capture.
// `bun run test:e2e` sets this; `bun run build` does not, so prod strips it.
const TEST_BRIDGE = process.env['VITE_TEST_BRIDGE'] === 'true';

export default defineConfig({
  root: 'src',
  define: {
    __TEST_BRIDGE__: JSON.stringify(TEST_BRIDGE),
  },
  plugins: [
    webExtension({
      browser: 'firefox',
      additionalInputs: ['manager/index.html', 'settings/index.html'],
    }),
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
