import { defineConfig } from 'vitest/config';
import { tailwindMergeAlias } from './vite.config';

export default defineConfig({
  resolve: { alias: tailwindMergeAlias },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
  },
});
