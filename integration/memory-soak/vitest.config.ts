import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    // Soak cells run for minutes; never let the default 5s timeout kill them.
    // Per-test timeouts are set explicitly in the spec.
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
});
