import { describe, expect, it } from 'vitest';
import type { HomeAssistantPort } from '@larder/core';
import { makeCore } from '../../tests/helpers';
import onlineShopping, { type ProviderView } from './index';
import { normaliseAddress } from './client';
import { fakeProvider } from './test-provider';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = <T = unknown>(core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'online-shopping' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params, userId: null }) as Promise<T>;

/** Home Assistant that records actions; a wake action wakes the pretend provider. */
function homeAssistant(onCall: (domain: string, service: string, data: Record<string, unknown>) => void = () => {}) {
  const calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
  const port = {
    appPath: async () => null,
    async callService(domain: string, service: string, data: Record<string, unknown>) {
      calls.push({ domain, service, data });
      onCall(domain, service, data);
    },
  } as unknown as HomeAssistantPort;
  return { port, calls };
}

async function setup(o: { version?: string; ha?: HomeAssistantPort; host?: null } = {}) {
  const shop = fakeProvider({ version: o.version, host: o.host });
  const env = { LARDER_MODULE_ONLINE_SHOPPING_WAKE_POLL_MS: '5', LARDER_MODULE_ONLINE_SHOPPING_WAKE_TIMEOUT_MS: '60' };
  const core = await makeCore({ modules: [onlineShopping], fetch: shop.fetch, homeAssistant: o.ha, env });
  const tesco = await core.shops.addPreset('Tesco');
  return { core, shop, tesco };
}

const add = (core: Core, shopId: string, extra: Record<string, unknown> = {}) =>
  call<ProviderView>(core, 'POST', '/providers', { type: 'tesco', shopId, address: '192.168.1.231:8710', token: 'secret', ...extra });

describe('online shopping: providers', () => {
  it('tidies the address it is given', () => {
    expect(normaliseAddress('192.168.1.231:8710')).toBe('http://192.168.1.231:8710');
    expect(normaliseAddress('mac-mini.local')).toBe('http://mac-mini.local:8710');
    expect(normaliseAddress('https://larder-tesco.example.com/')).toBe('https://larder-tesco.example.com:443');
    expect(() => normaliseAddress('ftp://x')).toThrow('must start with http');
  });

  it('adds one provider per shop, the first as the default, and never shows the token', async () => {
    const { core, tesco } = await setup();
    const p = await add(core, tesco.id);
    expect(p).toMatchObject({ shopName: 'Tesco', isDefault: true, url: 'http://192.168.1.231:8710', tokenHint: 'cret' });
    expect(p).not.toHaveProperty('token');
    await expect(add(core, tesco.id)).rejects.toThrow('Tesco already has a shopping provider');

    const asda = await core.shops.create({ name: 'Asda' });
    const second = await add(core, asda.id, { type: 'other', isDefault: true });
    const list = await call<{ providers: ProviderView[] }>(core, 'GET', '/providers');
    expect(list.providers.map((x) => [x.shopName, x.isDefault])).toEqual([['Tesco', false], ['Asda', true]]);
    await call(core, 'DELETE', '/providers/:id', undefined, { id: second.id });
    expect((await call<{ providers: ProviderView[] }>(core, 'GET', '/providers')).providers[0]!.isDefault).toBe(true);
  });

  it('tests the connection, keeps the status and fills in waking from the manifest', async () => {
    const { core, tesco } = await setup();
    const p = await add(core, tesco.id);
    const r = await call<{ provider: ProviderView; message: string; filledWake: boolean }>(core, 'POST', '/providers/:id/test', {}, { id: p.id });
    expect(r.message).toBe('Tesco 0.1.0 is ready (contract 1.3). Larder will wake it with a magic packet to 4c:32:75:12:34:56 when it doesn\'t answer.');
    expect(r.provider.status).toMatchObject({ ok: true, version: '0.1.0', contractVersion: '1.3', capabilities: expect.arrayContaining(['slot_booking']) });
    expect(r.provider.wake).toMatchObject({ mac: '4c:32:75:12:34:56', timeoutSeconds: 180 });
    expect(r.provider.canWake).toBe(true);
  });

  it('says what to do about a wrong token, a logged-out shop or another contract version', async () => {
    const { core, tesco, shop } = await setup({ host: null });
    const p = await add(core, tesco.id, { token: 'wrong' });
    const wrong = await call<{ message: string }>(core, 'POST', '/providers/:id/test', {}, { id: p.id });
    expect(wrong.message).toBe('The Tesco provider didn\'t accept Larder\'s token. Check the token in Settings → Shopping providers matches the provider\'s AUTH_TOKEN.');

    await call(core, 'PATCH', '/providers/:id', { token: 'secret' }, { id: p.id });
    shop.state.loggedIn = false;
    const out = await call<{ message: string; provider: ProviderView }>(core, 'POST', '/providers/:id/test', {}, { id: p.id });
    expect(out.message).toBe('Log in to Tesco again in the Larder Chrome.');
    expect(out.provider.status).toMatchObject({ ok: false, reachable: true, loggedIn: false });

    const v2 = await setup({ version: '2.0' });
    const q = await add(v2.core, v2.tesco.id);
    expect((await call<{ message: string }>(v2.core, 'POST', '/providers/:id/test', {}, { id: q.id })).message)
      .toBe('The Tesco provider speaks contract 2.0, and this Larder understands 1.x. Update whichever is older so they match.');
  });

  it('wakes a sleeping machine through Home Assistant before checking it', async () => {
    let shop: ReturnType<typeof fakeProvider> | null = null;
    const ha = homeAssistant((domain) => {
      if (domain === 'wake_on_lan' && shop) shop.state.asleep = false;
    });
    const s = await setup({ ha: ha.port });
    shop = s.shop;
    const p = await add(s.core, s.tesco.id, { wake: { mac: '4C:32:75:12:34:56', broadcastAddress: '192.168.1.255' } });
    s.shop.state.asleep = true;

    const quiet = await call<{ message: string; provider: ProviderView }>(s.core, 'POST', '/providers/:id/test', {}, { id: p.id });
    expect(quiet.message).toBe('Couldn\'t reach the Tesco provider at 192.168.1.231:8710. Is the machine on and the provider running?');
    expect(quiet.provider.status?.reachable).toBe(false);
    expect(ha.calls).toHaveLength(0);

    const r = await s.core.assistant.call('provider_status', {});
    expect(r.text).toBe('Woke it. Tesco is ready: provider 0.1.0, logged in. It can fill the basket, see loyalty prices, see multibuys, book delivery slots, read your favourites, add favourites and search products.');
    expect(ha.calls).toEqual([{ domain: 'wake_on_lan', service: 'send_magic_packet', data: { mac: '4C:32:75:12:34:56', broadcast_address: '192.168.1.255' } }]);
  });

  it('wakes with a switch or script, and gives up after the wake timeout', async () => {
    const ha = homeAssistant();
    const s = await setup({ ha: ha.port });
    const p = await add(s.core, s.tesco.id, { wake: { entityId: 'script.wake_mac_mini', timeoutSeconds: 10 } });
    s.shop.state.asleep = true;
    const r = await call<{ message: string }>(s.core, 'POST', '/providers/:id/test', { wake: true }, { id: p.id });
    expect(r.message).toBe('Couldn\'t wake the Tesco provider: it didn\'t answer within 10 seconds of waking. Check the machine is plugged in and on the network, and that the provider starts by itself.');
    expect(ha.calls[0]).toEqual({ domain: 'script', service: 'turn_on', data: { entity_id: 'script.wake_mac_mini' } });
  });

  it('picks the default shop, or the one named, and says when there is none', async () => {
    const { core, tesco } = await setup();
    await expect(core.assistant.call('provider_status', {})).rejects.toThrow('No online shop is set up yet. Add one in Settings → Shopping providers.');
    await add(core, tesco.id);
    await core.shops.addPreset('Aldi');
    await expect(core.assistant.call('provider_status', { shop: 'aldi' })).rejects.toThrow('Larder can\'t shop online at Aldi yet.');
    expect((await core.assistant.call('provider_status', { shop: 'tesco' })).data).toMatchObject({ shop: 'Tesco', ok: true });
  });
});
