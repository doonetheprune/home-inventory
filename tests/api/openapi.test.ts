import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSpec } from './spec';

describe('docs/openapi.json', () => {
  it('matches the API (run `npm run openapi` if this fails)', async () => {
    const committed = JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(await buildSpec())));
  });
});
