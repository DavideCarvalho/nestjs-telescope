import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The bundled console runs on Tailwind 4, whose class names `tailwind-merge` 3 understands; the
 * published `./react` components keep `tailwind-merge` 2 as their runtime dependency (Tailwind 3
 * consumers). Inside the SPA bundle (and its tests) every `tailwind-merge` import resolves to 3.
 */
export const tailwindMergeAlias = [{ find: /^tailwind-merge$/, replacement: 'tailwind-merge-v3' }];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/telescope/',
  resolve: { alias: tailwindMergeAlias },
  // CSS-referenced assets (the kit's bundled fonts) load relative to the stylesheet: the controller
  // rewrites the `/telescope/` base in index.html only, so an absolute `/telescope/assets/…` font
  // URL inside the CSS would 404 once the console is mounted anywhere else.
  experimental: {
    renderBuiltUrl: (_file, { hostType }) => (hostType === 'css' ? { relative: true } : undefined),
  },
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
  },
});
