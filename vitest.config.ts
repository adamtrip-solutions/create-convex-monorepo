import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/backend.test.ts'],
    // Workspace tests render and format whole projects; Windows runners need
    // well over the 5s default, and the suite runs many of them in parallel.
    testTimeout: 120_000,
  },
});
