import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/rate-strategy.test.ts', 'tests/unit/**/*.test.ts'],
  },
});
