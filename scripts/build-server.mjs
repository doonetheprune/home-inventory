// Bundles Larder's own server code (core, adapters, modules) into dist/server/main.js.
// Dependencies are loaded from node_modules at runtime.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await build({
  // main.js is Larder; install-integration.js is the add-on's start-up step (see docker/entrypoint.sh).
  entryPoints: ['src/server/main.ts', 'src/server/install-integration.ts'],
  outdir: 'dist/server',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Libraries stay in node_modules (some, like the API docs page, load their own files at runtime).
  packages: 'external',
  define: { __LARDER_VERSION__: JSON.stringify(version) },
  alias: { '@larder/core': './src/core/index.ts' },
  logLevel: 'info',
});
