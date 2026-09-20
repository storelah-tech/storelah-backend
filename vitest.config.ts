import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    setupFiles: ['tests/e2e/setup.ts'],
    globalSetup: ['tests/e2e/global-setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Every spec file shares ONE isolated test DB (see test-db.ts) and each
    // test truncates it first — files must run sequentially, never in parallel.
    fileParallelism: false,
  },
});
