/**
 * Keeps the layers honest:
 * - the core never imports adapters, the server, the web app, Node built-ins or modules;
 * - adapters and modules only use the public "@larder/core" API;
 * - modules never import from src/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}
const imports = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
const violations = (dir: string, bad: (spec: string, file: string) => boolean) =>
  files(join(root, dir)).flatMap((f) => imports(f).filter((s) => bad(s, f)).map((s) => `${relative(root, f)} imports ${s}`));

describe('architecture', () => {
  it('core stays free of adapters, servers and Node APIs', () => {
    expect(violations('src/core', (s) => s.startsWith('node:') || /^(\.\.\/)+(adapters|server|web)|^(\.\.\/){2,}modules|fastify|react/.test(s))).toEqual([]);
  });
  it('adapters use only the public core API', () => {
    expect(violations('src/adapters', (s) => s.includes('/core/') || s.includes('../core'))).toEqual([]);
  });
  it('modules use only @larder/core, @larder/web-sdk, zod, react, _shared and their own files', () => {
    expect(
      violations('modules', (s, f) => {
        if (['@larder/core', '@larder/web-sdk', 'zod', 'react', 'react/jsx-runtime'].includes(s)) return false;
        if (s.startsWith('./')) return false;
        if (s.startsWith('../_shared/')) return false;
        if (relative(root, f) === 'modules/index.ts' && s.startsWith('./')) return false;
        return true;
      }),
    ).toEqual([]);
  });
});
