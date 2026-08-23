import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative base so the build works on GitHub Pages project subpaths,
  // any static host, or even opened straight from disk (launcher.html).
  base: './',
  build: {
    chunkSizeWarningLimit: 1600
    // NOTE: intentionally a single JS bundle — the single-file browser
    // launcher (scripts/make-launcher.mjs) inlines it, which requires
    // zero external chunk imports.
  },
  server: {
    port: 3000,
    open: true
  }
});
