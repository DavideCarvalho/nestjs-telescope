import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: '/telescope/',
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
  },
});
