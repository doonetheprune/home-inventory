/** Replaced at build time by scripts/build-server.mjs; read from package.json in development. */
import { readFileSync } from 'node:fs';

declare const __LARDER_VERSION__: string | undefined;

function fromPackage(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'dev';
  }
}

export const VERSION: string = typeof __LARDER_VERSION__ === 'string' ? __LARDER_VERSION__ : (process.env.npm_package_version ?? fromPackage());
