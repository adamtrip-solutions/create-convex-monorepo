import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/backend.test.ts'],
    // Workspace tests render and format whole projects; Windows runners need
    // well over the 5s default.
    testTimeout: 30_000,
  },
});
