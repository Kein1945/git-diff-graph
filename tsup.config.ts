import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: false, // dist/web is produced by vite before this step
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  onSuccess: async () => {
    cpSync('grammars', 'dist/grammars', { recursive: true });
  },
});
