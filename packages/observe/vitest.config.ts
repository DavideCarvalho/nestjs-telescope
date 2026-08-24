import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    // Specs that exercise a send wait on real zlib thread-pool completions while
    // driving fake backoff timers, and CI runs every package's suite at once.
    testTimeout: 20_000,
  },
});
