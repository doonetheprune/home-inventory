import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('versions', () => {
  it('match across the app, the add-on and the Home Assistant integration', () => {
    const app = (JSON.parse(read('package.json')) as { version: string }).version;
    // The add-on pulls the image tagged with its version, so a mismatch would install the wrong Larder.
    expect(/^version: "([^"]+)"/m.exec(read('addon/config.yaml'))?.[1]).toBe(app);
    expect((JSON.parse(read('custom_components/larder/manifest.json')) as { version: string }).version).toBe(app);
    expect(read('addon/CHANGELOG.md')).toContain(`## ${app}`);
  });
});
