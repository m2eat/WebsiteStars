import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', timeout: 60000, fullyParallel: false, workers: 1,
  reporter: [['list']], expect: { timeout: 10000 },
  use: { trace: 'retain-on-failure', actionTimeout: 10000 },
});
