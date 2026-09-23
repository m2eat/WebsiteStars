import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['fake-indexeddb/auto', './tests/setup-locale.ts'],
    restoreMocks: true,
  },
});
