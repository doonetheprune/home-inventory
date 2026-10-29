/**
 * Writes the OpenAPI spec to docs/openapi.json so people (and AI assistants)
 * can read the API without running Larder. tests/api/openapi.test.ts fails
 * if the committed file is out of date: run `npm run openapi` to refresh it.
 */
import { writeFileSync } from 'node:fs';
import { buildSpec } from '../tests/api/spec';

writeFileSync('docs/openapi.json', `${JSON.stringify(await buildSpec(), null, 2)}\n`);
console.log('Wrote docs/openapi.json');
