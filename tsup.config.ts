import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: true,
  banner: { js: '#!/usr/bin/env node' },
  external: ['pdf-parse', 'mammoth', 'node-cron', 'better-sqlite3'],
})
