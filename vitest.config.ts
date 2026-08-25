import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose `root: 'frontend'` is for the browser
// bundle only. Vitest prefers this file when both are present.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
