import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { haActionsJson, haServicesYaml } from '../scripts/ha-services';

describe('custom_components/larder/services.yaml', () => {
  it('matches Larder\'s actions (run `npm run ha:services` if this fails)', async () => {
    expect(readFileSync(new URL('../custom_components/larder/services.yaml', import.meta.url), 'utf8')).toBe(await haServicesYaml());
    expect(readFileSync(new URL('../custom_components/larder/actions.json', import.meta.url), 'utf8')).toBe(await haActionsJson());
  });
});
