import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    // File-backed sqlite schema.update (the self-heal guards) is CPU-heavy and
    // several integration spec files run in parallel, so the 5s default is too
    // tight under contention. Bump the per-test timeout package-wide.
    testTimeout: 30_000,
  },
});
