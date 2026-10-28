import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('.'),
  // Relative paths so the app works behind Home Assistant ingress and reverse proxies.
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@larder/core': r('../core/index.ts'),
      '@larder/web-sdk': r('./src/sdk/index.ts'),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [r('../..')] },
    proxy: { '/api': { target: process.env.LARDER_DEV_API ?? 'http://localhost:8080', changeOrigin: false } },
  },
  build: {
    outDir: r('../../dist/web'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
});
