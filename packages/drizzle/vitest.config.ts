import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    // The integration specs start a PostgreSQL container per file; pulling and booting it is slow
    // on a cold runner, so the hooks and tests get more than the 5s default.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
