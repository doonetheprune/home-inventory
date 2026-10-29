import { createCore, type ModuleDefinition } from '@larder/core';
import { createMemoryStorage } from '../../src/adapters/storage-memory';
import { createMemoryFileStore } from '../../src/adapters/files-memory';
import { createMemorySearchIndex } from '../../src/adapters/search-memory';
import { createMemoryEventBus } from '../../src/adapters/events-memory';
import { buildApp } from '../../src/server/app';
import { loadConfig } from '../../src/server/config';

export async function makeApp(options: { auth?: 'local' | 'none' | 'homeassistant'; modules?: ModuleDefinition[]; env?: Record<string, string> } = {}) {
  const config = loadConfig({ LARDER_AUTH: options.auth ?? 'local', LARDER_WEB_DIR: '/nonexistent', LARDER_STORAGE: 'memory', ...options.env }, { version: 'test' });
  const core = await createCore(
    { storage: createMemoryStorage(), files: createMemoryFileStore(), search: createMemorySearchIndex(), events: createMemoryEventBus(), lookupTimeoutMs: 200 },
    { modules: options.modules ?? [], disabled: config.disabledModules, env: options.env ?? {} },
  );
  const { app, auth } = await buildApp({ core, config, logger: false });
  await app.ready();

  let cookie = '';
  let token = '';
  const call = async <T = unknown>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: { ...(cookie ? { cookie, 'x-larder-client': 'web' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    const setCookie = res.headers['set-cookie'];
    if (setCookie) cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(';')[0]!;
    let json: T | undefined;
    try {
      json = res.json() as T;
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, body: json as T, raw: res };
  };
  return {
    app,
    auth,
    core,
    call,
    useToken: (t: string) => {
      token = t;
      cookie = '';
    },
    clearAuth: () => {
      token = '';
      cookie = '';
    },
  };
}
