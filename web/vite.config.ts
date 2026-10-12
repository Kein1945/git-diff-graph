import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    // The viewer may import only these two core modules: contracts (types) and layout (pure).
    // `@core/layout/sizes` is the ELK-free part, safe for the main bundle; ELK itself runs in the worker.
    alias: [
      { find: '@core/contracts', replacement: here('../src/contracts/index.ts') },
      { find: '@core/layout/sizes', replacement: here('../src/layout/sizes.ts') },
      { find: '@core/layout', replacement: here('../src/layout/index.ts') },
    ],
  },
  worker: { format: 'es' },
  build: {
    outDir: here('../dist/web'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    // `npm run dev:web` against a running `git-diff-graph --no-open` on the default port
    proxy: { '/api': 'http://127.0.0.1:4173' },
  },
});
