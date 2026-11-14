import { defineConfig } from 'vite';

// Relative base: the same build works on GitHub Pages (/NASA-space-app-challenge/),
// on a custom domain, and when opened from any sub-path.
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
