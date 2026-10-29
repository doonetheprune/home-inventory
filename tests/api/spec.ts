import { makeApp } from './helpers';
import { modules } from '../../modules';

/** The OpenAPI spec with every module loaded, as served at /api/openapi.json. */
export async function buildSpec(): Promise<Record<string, unknown>> {
  const { app } = await makeApp({ auth: 'local', modules });
  const spec = app.swagger() as Record<string, unknown> & { info: { version: string } };
  spec.info.version = 'see package.json';
  await app.close();
  return spec;
}
