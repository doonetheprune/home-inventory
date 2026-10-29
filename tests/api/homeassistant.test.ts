import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addonEnv, announceToHomeAssistant, supervisorMqtt } from '../../src/server/addon';
import { makeApp } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const SUPERVISOR = '172.30.32.2';
const ingress = { 'x-remote-user-id': 'abc123', 'x-remote-user-name': 'shaun', 'x-remote-user-display-name': 'Shaun', 'x-larder-client': 'web' };

describe('Home Assistant ingress login', () => {
  it('signs in people arriving through ingress as their Home Assistant user', async () => {
    const { app } = await makeApp({ auth: 'homeassistant' });
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/status', remoteAddress: SUPERVISOR, headers: ingress });
    expect(me.json()).toMatchObject({ mode: 'homeassistant', setupNeeded: false, user: { id: 'ha-abc123', displayName: 'Shaun', role: 'admin', via: 'ingress' } });

    const created = await app.inject({ method: 'POST', url: '/api/v1/products', remoteAddress: SUPERVISOR, headers: ingress, payload: { name: 'Milk' } });
    expect(created.statusCode).toBe(200);
    // Tokens made by a Home Assistant user work on their own.
    const t = await app.inject({ method: 'POST', url: '/api/v1/auth/tokens', remoteAddress: SUPERVISOR, headers: ingress, payload: { name: 'Node-RED' } });
    const token = (t.json() as Any).token as string;
    expect((await app.inject({ method: 'GET', url: '/api/v1/products', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });

  it('keeps Home Assistant users apart by id, whatever their names', async () => {
    const { app, auth } = await makeApp({ auth: 'homeassistant' });
    const as = (id: string, name: string) => ({ ...ingress, 'x-remote-user-id': id, 'x-remote-user-name': name, 'x-remote-user-display-name': name });
    // Same username twice (a user deleted and made again), and one called "integration" next to the add-on's own account.
    await auth.integrationToken(join(mkdtempSync(join(tmpdir(), 'larder-ha-')), 'integration-token'));
    for (const [id, name] of [['id1', 'shaun'], ['id2', 'shaun'], ['id3', 'integration'], ['id4', 'home assistant integration']]) {
      const r = await app.inject({ method: 'GET', url: '/api/v1/auth/status', remoteAddress: SUPERVISOR, headers: as(id!, name!) });
      expect(r.statusCode, name).toBe(200);
      expect((r.json() as Any).user.id).toBe(`ha-${id}`);
    }
    // Without the user id there's no telling people apart, so nobody is signed in.
    const { 'x-remote-user-id': _id, ...noId } = ingress;
    expect((await app.inject({ method: 'GET', url: '/api/v1/products', remoteAddress: SUPERVISOR, headers: noId })).statusCode).toBe(401);
  });

  it('can make only some Home Assistant users Larder admins', async () => {
    const { app } = await makeApp({ auth: 'homeassistant', env: { LARDER_HA_ADMINS: 'Shaun' } });
    const as = (id: string, name: string) => ({ ...ingress, 'x-remote-user-id': id, 'x-remote-user-name': name });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/status', remoteAddress: SUPERVISOR, headers: as('a', 'shaun') })).json()).toMatchObject({ user: { role: 'admin' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/status', remoteAddress: SUPERVISOR, headers: as('b', 'kid') })).json()).toMatchObject({ user: { role: 'member' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/users', remoteAddress: SUPERVISOR, headers: as('b', 'kid') })).statusCode).toBe(403);
  });

  it('ignores ingress headers that arrive from anywhere but the Supervisor', async () => {
    const { app } = await makeApp({ auth: 'homeassistant' });
    const spoofed = await app.inject({ method: 'GET', url: '/api/v1/products', remoteAddress: '192.168.1.50', headers: { ...ingress, 'x-forwarded-for': SUPERVISOR } });
    expect(spoofed.statusCode).toBe(401);
  });

  it('still needs the app header for changes, so other pages in Home Assistant can\'t make them', async () => {
    const { app } = await makeApp({ auth: 'homeassistant' });
    const { 'x-larder-client': _client, ...noClient } = ingress;
    const r = await app.inject({ method: 'POST', url: '/api/v1/products', remoteAddress: SUPERVISOR, headers: noClient, payload: { name: 'Milk' } });
    expect(r.statusCode).toBe(403);
  });
});

describe('add-on runtime', () => {
  it('turns add-on options into settings, only inside an add-on', () => {
    expect(addonEnv({})).toEqual({});
    const options = { log_level: 'debug', disabled_modules: ['pricing'], backups: false, env_vars: [{ name: 'LARDER_MODULE_PRICING_X', value: '1' }, { name: 'LARDER_AUTH', value: 'none' }, { name: 'PATH', value: '/x' }] };
    const env = addonEnv({ SUPERVISOR_TOKEN: 'sup' }, () => JSON.stringify(options));
    expect(env).toEqual({
      LARDER_AUTH: 'homeassistant', LARDER_DATA_DIR: '/data', LARDER_PORT: '8080', LARDER_HOST: '0.0.0.0', LARDER_BACKUP_EVERY_HOURS: '0',
      LARDER_LOG_LEVEL: 'debug', LARDER_MODULES_DISABLED: 'pricing', LARDER_MODULE_PRICING_X: '1',
    });
  });

  it('keeps one integration token across restarts and replaces it if revoked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'larder-ha-'));
    const file = join(dir, 'integration-token');
    const { app, auth } = await makeApp({ auth: 'homeassistant' });
    const first = await auth.integrationToken(file);
    expect(first).toMatch(/^lrd_/);
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await auth.integrationToken(file)).toBe(first);
    const ok = await app.inject({ method: 'GET', url: '/api/v1/automation', headers: { authorization: `Bearer ${first}` } });
    expect(ok.statusCode).toBe(200);

    const tokens = await auth.listTokens({ id: 'x', username: 'x', displayName: 'x', role: 'admin', via: 'token' });
    await auth.removeToken({ id: 'x', username: 'x', displayName: 'x', role: 'admin', via: 'token' }, tokens[0]!.id);
    const second = await auth.integrationToken(file);
    expect(second).not.toBe(first);
  });

  it('uses the Mosquitto add-on for MQTT unless a broker is set', async () => {
    const fake = (async () => new Response(JSON.stringify({ result: 'ok', data: { host: 'core-mosquitto', port: 1883, ssl: false, username: 'addons', password: 'secret' } }))) as unknown as typeof fetch;
    expect(await supervisorMqtt({ SUPERVISOR_TOKEN: 'x' }, fake)).toEqual({ LARDER_MODULE_MQTT_URL: 'mqtt://core-mosquitto:1883', LARDER_MODULE_MQTT_USERNAME: 'addons', LARDER_MODULE_MQTT_PASSWORD: 'secret' });
    expect(await supervisorMqtt({ SUPERVISOR_TOKEN: 'x', LARDER_MODULE_MQTT_URL: 'mqtt://mine' }, fake)).toEqual({});
    expect(await supervisorMqtt({}, fake)).toEqual({});
    const none = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
    expect(await supervisorMqtt({ SUPERVISOR_TOKEN: 'x' }, none)).toEqual({});
  });

  it('announces Larder to the Supervisor, retrying until it answers', async () => {
    const calls: Array<{ url: string; body: Any; auth: string }> = [];
    let n = 0;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).authorization! });
      n++;
      if (n === 1) throw new Error('not up yet');
      return new Response('{}', { status: n === 2 ? 503 : 200 });
    }) as unknown as typeof fetch;
    const logs: string[] = [];
    const ok = await announceToHomeAssistant({ supervisorToken: 'sup', port: 8080, token: 'lrd_x', fetch: fakeFetch, delayMs: 1, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ url: 'http://supervisor/discovery', auth: 'Bearer sup', body: { service: 'larder', config: { port: 8080, token: 'lrd_x' } } });
  });
});

describe('automation API', () => {
  it('lists sensors and actions, reads state, and runs actions by name', async () => {
    const { call } = await makeApp({ auth: 'none' });
    await call('POST', '/api/v1/products', { name: 'AA batteries', minQuantity: 4 });
    await call('POST', '/api/v1/products', { name: 'AAA batteries', minQuantity: 4 });
    const manifest = (await call<Any>('GET', '/api/v1/automation')).body;
    expect(manifest.sensors.map((s: Any) => s.id)).toContain('low_stock');
    expect(manifest.actions.find((a: Any) => a.id === 'add_stock').schema.properties.item.type).toBe('string');

    const state = (await call<Any>('GET', '/api/v1/automation/state')).body;
    expect(state.sensors.low_stock.state).toBe(2);

    const added = await call<Any>('POST', '/api/v1/automation/actions/add_stock', { item: 'aa batteries', quantity: 4 });
    expect(added.body.message).toBe('AA batteries: added 4. 4 in stock.');

    const unsure = await call<Any>('POST', '/api/v1/automation/actions/use_stock', { item: 'batteries' });
    expect(unsure.status).toBe(409);
    expect(unsure.body).toMatchObject({ error: 'ambiguous', candidates: expect.arrayContaining(['AA batteries', 'AAA batteries']) });
    expect((await call('POST', '/api/v1/automation/actions/use_stock', {})).status).toBe(400);
  });

  it('records NFC scans and links tags', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const box = (await call<Any>('POST', '/api/v1/places', { name: 'Camping box' })).body;
    expect((await call<Any>('POST', '/api/v1/nfc/scanned', { tagId: 'tag-1', device: 'Phone' })).body.kind).toBe('unknown');
    expect((await call<Any>('GET', '/api/v1/nfc/recent')).body[0].tagId).toBe('tag-1');
    expect((await call<Any>('POST', '/api/v1/nfc/link', { tagId: 'tag-1', placeId: box.id })).body).toEqual({ kind: 'place' });
    expect((await call<Any>('POST', '/api/v1/nfc/scanned', { tagId: 'tag-1' })).body).toMatchObject({ kind: 'place', name: 'Camping box' });
    expect((await call<Any>('DELETE', '/api/v1/nfc/tags/tag-1')).body).toEqual({ unlinked: true });
  });
});
