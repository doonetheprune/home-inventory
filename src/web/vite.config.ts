import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Writes sw.js after a build: the service worker that keeps the web app on
 * the device so it opens with no connection (src/web/sw-template.js). It
 * lists every file the build made, except .woff fonts (browsers use .woff2).
 */
function keepOnDevice(): Plugin {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  return {
    name: 'larder-keep-on-device',
    apply: 'build',
    closeBundle() {
      const out = r('../../dist/web');
      const files = walk(out).map((f) => relative(out, f).split('\\').join('/')).filter((f) => f !== 'sw.js' && !/\.(map|woff)$/.test(f)).sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(out, f)));
      const list = ['./', ...files.filter((f) => f !== 'index.html')];
      const sw = readFileSync(r('./sw-template.js'), 'utf8').replace('__VERSION__', hash.digest('hex').slice(0, 12)).replace('__FILES__', JSON.stringify(list));
      writeFileSync(join(out, 'sw.js'), sw);
    },
  };
}

export default defineConfig({
  root: r('.'),
  // Relative paths so the app works behind Home Assistant ingress and reverse proxies.
  base: './',
  plugins: [react(), keepOnDevice()],
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
