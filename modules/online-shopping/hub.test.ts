import { describe, expect, it } from 'vitest';
import type { HomeAssistantPort } from '@larder/core';
import { makeCore } from '../../tests/helpers';
import onlineShopping, { type ProviderView } from './index';
import { normaliseHubAddress } from './hub';
import { fakeHub, fakeProvider } from './test-provider';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = <T = unknown>(core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'online-shopping' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params, userId: null }) as Promise<T>;

interface HubAnswer {
  hub: { url: string; tokenHint: string; wake: { mac: string | null; broadcastAddress: string | null } | null; canWake: boolean; status: { ok: boolean; message: string | null; extension: boolean | null } | null } | null;
  automations: Array<{ id: string; name: string; running: boolean | null; providerId: string | null; shopName: string | null }>;
  message?: string;
}

async function setup(o: { ha?: HomeAssistantPort; extension?: boolean } = {}) {
  const provider = fakeProvider();
  const hub = fakeHub(provider, { extension: o.extension });
  const env = { LARDER_MODULE_ONLINE_SHOPPING_WAKE_POLL_MS: '5', LARDER_MODULE_ONLINE_SHOPPING_WAKE_TIMEOUT_MS: '60', LARDER_MODULE_ONLINE_SHOPPING_JOB_POLL_MS: '5' };
  const core = await makeCore({ modules: [onlineShopping], fetch: hub.fetch, homeAssistant: o.ha, env });
  const tesco = await core.shops.addPreset('Tesco');
  return { core, provider, hub, tesco };
}

const link = (core: Core, shopId: string, automation = 'tesco') => call<ProviderView>(core, 'POST', '/providers', { type: 'tesco', shopId, automation });

describe('online shopping: Larder Automations', () => {
  it('tidies the hub address, port 8700 unless given', () => {
    expect(normaliseHubAddress('192.168.1.40')).toBe('http://192.168.1.40:8700');
    expect(normaliseHubAddress('mac-mini.local:9000/')).toBe('http://mac-mini.local:9000');
  });

  it('is set up with one address and token, lists its automations, and fills in waking the Mac', async () => {
    const { core, hub } = await setup();
    await expect(link(core, (await core.shops.list())[0]!.id)).rejects.toThrow('Set up Larder Automations first');
    const saved = await call<HubAnswer>(core, 'PUT', '/hub', { address: hub.address, token: hub.token });
    expect(saved.hub).toMatchObject({ url: 'http://192.168.1.40:8700', tokenHint: 'cret', status: null });
    expect(saved.hub).not.toHaveProperty('token');

    const r = await call<HubAnswer>(core, 'POST', '/hub/test', {});
    expect(r.message).toBe('Larder Automations 0.1.0 answered, running Tesco. Larder will wake the Mac with a magic packet to a8:20:66:00:00:01 when it doesn\'t answer.');
    expect(r.hub).toMatchObject({ status: { ok: true, extension: true }, wake: { mac: 'a8:20:66:00:00:01', broadcastAddress: '192.168.1.255' }, canWake: true });
    expect(r.automations).toEqual([{ id: 'tesco', name: 'Tesco', version: '0.2.0', running: true, providerId: null, shopId: null, shopName: null }]);

    // Saving again without a token keeps it.
    await call(core, 'PUT', '/hub', { address: '192.168.1.40:8700' });
    expect((await call<HubAnswer>(core, 'POST', '/hub/test', {})).hub?.status?.ok).toBe(true);
  });

  it('says what to do about a wrong token and a disconnected extension', async () => {
    const { core, hub } = await setup({ extension: false });
    await call(core, 'PUT', '/hub', { address: hub.address, token: 'wrong' });
    expect((await call<HubAnswer>(core, 'POST', '/hub/test', {})).message).toBe('Larder Automations didn\'t accept Larder\'s token. Copy the token from its menu (Copy token) into Settings → Larder Automations.');
    await call(core, 'PUT', '/hub', { address: hub.address, token: hub.token });
    const r = await call<HubAnswer>(core, 'POST', '/hub/test', {});
    expect(r.hub?.status).toMatchObject({ ok: false, extension: false });
    expect(r.message).toContain('The Larder Automations Chrome extension isn\'t connected.');
  });

  it('links an automation to a shop, which then shops through the hub', async () => {
    const { core, hub, provider, tesco } = await setup();
    await call(core, 'PUT', '/hub', { address: hub.address, token: hub.token });
    const p = await link(core, tesco.id);
    expect(p).toMatchObject({ automation: 'tesco', url: 'http://192.168.1.40:8700/automations/tesco', shopName: 'Tesco', isDefault: true });
    expect((await call<HubAnswer>(core, 'GET', '/hub')).automations[0]).toMatchObject({ id: 'tesco', providerId: p.id, shopName: 'Tesco' });

    // One shop per automation.
    const asda = await core.shops.create({ name: 'Asda' });
    await expect(link(core, asda.id)).rejects.toThrow('That automation already shops for Tesco. Unlink it there first.');

    const tested = await call<{ provider: ProviderView; message: string }>(core, 'POST', '/providers/:id/test', {}, { id: p.id });
    expect(tested.message).toBe('Tesco 0.1.0 is ready (contract 1.3). Larder will wake the Mac with a magic packet to 4c:32:75:12:34:56 when it doesn\'t answer.');
    expect((await call<HubAnswer>(core, 'GET', '/hub')).hub?.wake?.mac).toBe('4c:32:75:12:34:56');
    provider.state.slots = [{ id: 's17', start: '2026-10-30T17:00:00+00:00', end: '2026-10-30T18:00:00+00:00', price: 0, available: true }];
    expect((await core.assistant.call('list_slots', { when: 'friday' })).text).toContain('- 17:00–18:00, free (id s17)');

    // An automation the hub doesn't have answers in words.
    hub.state.automations = [];
    await expect(core.assistant.call('list_slots', { when: 'friday' })).rejects.toThrow('There\'s no automation "tesco".');

    // Forgetting the hub unlinks its shops.
    await call(core, 'DELETE', '/hub');
    expect((await call<{ providers: ProviderView[] }>(core, 'GET', '/providers')).providers).toEqual([]);
  });

  it('wakes the Mac when the hub doesn\'t answer, for any of its automations', async () => {
    const calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
    let hub: ReturnType<typeof fakeHub> | null = null;
    const ha = {
      appPath: async () => null,
      async callService(domain: string, service: string, data: Record<string, unknown>) {
        calls.push({ domain, service, data });
        if (domain === 'wake_on_lan') hub!.state.asleep = false;
      },
    } as unknown as HomeAssistantPort;
    const s = await setup({ ha });
    hub = s.hub;
    await call(s.core, 'PUT', '/hub', { address: hub.address, token: hub.token, wake: { mac: 'a8:20:66:00:00:01' }, sleepEntityId: 'script.sleep_mac' });
    await link(s.core, s.tesco.id);
    hub.state.asleep = true;
    expect((await call<HubAnswer>(s.core, 'POST', '/hub/test', {})).hub?.status?.ok).toBe(false);
    expect((await call<HubAnswer>(s.core, 'POST', '/hub/test', { wake: true })).message).toMatch(/^Woke the Mac\. Larder Automations 0\.1\.0 answered/);

    hub.state.asleep = true;
    expect((await s.core.assistant.call('provider_status', {})).text).toMatch(/^Woke it\. Tesco is ready/);
    expect(calls.filter((c) => c.domain === 'wake_on_lan').map((c) => c.data)).toEqual([{ mac: 'a8:20:66:00:00:01' }, { mac: 'a8:20:66:00:00:01' }]);
  });
});
