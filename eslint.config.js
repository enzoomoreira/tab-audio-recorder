import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'test/**',
      '*.config.ts',
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript already resolves identifiers (browser, window, __TEST_BRIDGE__).
      'no-undef': 'off',
      // Catches the fire-and-forget bug class (unhandled background promises).
      '@typescript-eslint/no-floating-promises': 'error',
      // Async event listeners returning promises into void slots are an
      // intended, safe pattern in the extension UIs.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
    },
  },
  prettier,
);
