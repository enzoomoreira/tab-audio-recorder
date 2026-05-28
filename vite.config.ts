import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';

export default defineConfig({
  root: 'src',
  plugins: [
    webExtension({
      browser: 'firefox',
      additionalInputs: ['manager/index.html'],
    }),
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
