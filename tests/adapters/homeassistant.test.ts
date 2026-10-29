/**
 * The Home Assistant adapter, against a pretend Home Assistant that answers
 * the way the real one does (checked against Home Assistant 2026.2).
 */
import { describe, expect, it } from 'vitest';
import { createHomeAssistant, HomeAssistantError } from '../../src/adapters/homeassistant';

interface Sent { id?: number; type: string; [k: string]: unknown }

/** A websocket that signs in with "good" and answers each command with `answer`. */
function fakeSocket(answer: (cmd: Sent) => { success: true; result: unknown } | { success: false; error: { code: string; message: string } }, log: Sent[] = [], urls: string[] = []) {
  return class {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(url: string) {
      urls.push(url);
      setTimeout(() => this.receive({ type: 'auth_required' }));
    }
    private receive(msg: unknown) {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
    send(raw: string) {
      const cmd = JSON.parse(raw) as Sent;
      if (cmd.type === 'auth') return setTimeout(() => this.receive({ type: cmd.access_token === 'good' ? 'auth_ok' : 'auth_invalid' }));
      log.push(cmd);
      setTimeout(() => this.receive({ id: cmd.id, type: 'result', ...answer(cmd) }));
    }
    close() {}
  } as unknown as typeof WebSocket;
}

/** Answers REST calls from a table of "METHOD /path" → body (or a status number). */
function fakeFetch(routes: Record<string, unknown>, log: Array<{ method: string; url: string; body?: unknown; auth?: string }> = []) {
  return (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    log.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>).authorization });
    const hit = routes[`${method} ${u.pathname}`];
    const value = typeof hit === 'function' ? (hit as () => unknown)() : hit;
    if (value === undefined) return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
    if (typeof value === 'number') return new Response(JSON.stringify({ message: value === 400 ? 'Message malformed: extra keys not allowed' : 'Unauthorized' }), { status: value });
    return new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
}

const zoneStore = () => {
  const zones = new Map<string, Record<string, unknown>>();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return {
    zones,
    answer(cmd: Sent) {
      const { id: _id, type, zone_id, ...fields } = cmd;
      if (type === 'zone/create') {
        const id = slug(String(fields.name));
        zones.set(id, { id, ...fields });
        return { success: true as const, result: zones.get(id) };
      }
      if (type === 'zone/update') {
        if (!zones.has(String(zone_id))) return { success: false as const, error: { code: 'not_found', message: `Unable to find zone_id ${zone_id}` } };
        zones.set(String(zone_id), { id: zone_id, ...fields });
        return { success: true as const, result: zones.get(String(zone_id)) };
      }
      if (type === 'config/entity_registry/list') {
        // Home Assistant keeps an entity id when a zone is renamed, so it can differ from the name.
        return { success: true as const, result: [...zones.keys()].map((id) => ({ entity_id: id === 'aldi' ? 'zone.aldi_old_name' : `zone.${id}`, platform: 'zone', unique_id: id })) };
      }
      return { success: false as const, error: { code: 'unknown_command', message: 'Unknown command.' } };
    },
  };
};

describe('Home Assistant adapter', () => {
  it('makes zones, updates them by id, and makes them again if someone deleted them', async () => {
    const store = zoneStore();
    const sent: Sent[] = [];
    const urls: string[] = [];
    const ha = createHomeAssistant({ url: 'http://ha.local:8123/', token: 'good', WebSocket: fakeSocket((c) => store.answer(c), sent, urls) });

    const made = await ha.saveZones([{ name: 'Aldi', latitude: 53.44, longitude: -2.22, radius: 150, icon: 'mdi:cart' }, { name: 'Tesco Extra', latitude: 53.45, longitude: -2.21, radius: 200 }]);
    expect(urls[0]).toBe('ws://ha.local:8123/api/websocket');
    expect(made).toEqual([{ id: 'aldi', entityId: 'zone.aldi_old_name' }, { id: 'tesco_extra', entityId: 'zone.tesco_extra' }]);
    expect(sent[0]).toMatchObject({ type: 'zone/create', name: 'Aldi', latitude: 53.44, longitude: -2.22, radius: 150, icon: 'mdi:cart' });

    store.zones.delete('tesco_extra');
    sent.length = 0;
    const again = await ha.saveZones([{ id: 'aldi', name: 'Aldi', latitude: 53.441, longitude: -2.22, radius: 120 }, { id: 'tesco_extra', name: 'Tesco Extra', latitude: 53.45, longitude: -2.21, radius: 200 }]);
    expect(sent.map((c) => c.type)).toEqual(['zone/update', 'zone/update', 'zone/create', 'config/entity_registry/list']);
    expect(store.zones.get('aldi')).toMatchObject({ latitude: 53.441, radius: 120 });
    expect(again.map((z) => z.id)).toEqual(['aldi', 'tesco_extra']);
  });

  it('goes through the Supervisor as an add-on', async () => {
    const urls: string[] = [];
    const fetchLog: Array<{ method: string; url: string; auth?: string }> = [];
    const ha = createHomeAssistant({
      url: 'http://supervisor/core', token: 'good', supervisor: { url: 'http://supervisor', token: 'sup' },
      WebSocket: fakeSocket((c) => zoneStore().answer(c), [], urls),
      fetch: fakeFetch({ 'GET /addons/self/info': { result: 'ok', data: { slug: 'a1b2c3_larder' } } }, fetchLog),
    });
    await ha.saveZones([{ name: 'Lidl', latitude: 1, longitude: 2, radius: 100 }]);
    expect(urls[0]).toBe('ws://supervisor/core/websocket');
    expect(await ha.appPath()).toBe('/hassio/ingress/a1b2c3_larder');
    expect(fetchLog[0]).toMatchObject({ url: 'http://supervisor/addons/self/info', auth: 'Bearer sup' });
    expect(await createHomeAssistant({ url: 'http://ha:8123', token: 'good' }).appPath()).toBeNull();
  });

  it('says plainly when the token is wrong or not an admin', async () => {
    const bad = createHomeAssistant({ url: 'http://ha:8123', token: 'bad', WebSocket: fakeSocket(() => ({ success: true, result: null })) });
    await expect(bad.saveZones([{ name: 'X', latitude: 0, longitude: 0, radius: 100 }])).rejects.toMatchObject({ code: 'unauthorized' });

    const notAdmin = createHomeAssistant({ url: 'http://ha:8123', token: 'good', WebSocket: fakeSocket(() => ({ success: false, error: { code: 'unauthorized', message: 'Unauthorized' } })) });
    await expect(notAdmin.saveZones([{ name: 'X', latitude: 0, longitude: 0, radius: 100 }])).rejects.toMatchObject({ code: 'unauthorized' });

    const rest = createHomeAssistant({ url: 'http://ha:8123', token: 'bad', fetch: fakeFetch({ 'GET /api/config': 401 }) });
    const err = await rest.home().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HomeAssistantError);
    expect(err).toMatchObject({ code: 'unauthorized', message: expect.stringContaining('admin') });
  });

  it('finds the home location, people and their phones', async () => {
    const ha = createHomeAssistant({
      url: 'http://ha:8123', token: 'good',
      fetch: fakeFetch({
        'GET /api/config': { latitude: 53.4, longitude: -2.2, location_name: 'Home', elevation: 0 },
        'GET /api/states': [
          { entity_id: 'person.shaun', state: 'home', attributes: { friendly_name: 'Shaun', device_trackers: ['device_tracker.shauns_pixel', 'device_tracker.old_tablet'] } },
          { entity_id: 'person.sam', state: 'not_home', attributes: { device_trackers: [] } },
          { entity_id: 'device_tracker.shauns_pixel', state: 'home', attributes: { friendly_name: 'Shaun’s Pixel' } },
          { entity_id: 'zone.home', state: '2', attributes: {} },
        ],
        'GET /api/services': [
          { domain: 'light', services: { turn_on: {} } },
          { domain: 'notify', services: { notify: {}, persistent_notification: {}, mobile_app_shauns_pixel: {}, mobile_app_sams_iphone: {} } },
        ],
      }),
    });
    expect(await ha.home()).toEqual({ latitude: 53.4, longitude: -2.2, name: 'Home' });
    expect(await ha.people()).toEqual({
      people: [
        { entityId: 'person.shaun', name: 'Shaun', phones: ['notify.mobile_app_shauns_pixel'] },
        { entityId: 'person.sam', name: 'Sam', phones: [] },
      ],
      phones: [
        { action: 'notify.mobile_app_shauns_pixel', name: 'Shaun’s Pixel' },
        { action: 'notify.mobile_app_sams_iphone', name: 'Sams iphone' },
      ],
    });
  });

  it('saves an automation and waits for Home Assistant to load it', async () => {
    let loaded = false;
    const log: Array<{ method: string; url: string; body?: unknown }> = [];
    const ha = createHomeAssistant({
      url: 'http://ha:8123', token: 'good', loadWaitMs: 2000,
      fetch: fakeFetch({
        'POST /api/config/automation/config/larder_shop_arrivals': () => {
          setTimeout(() => (loaded = true), 300);
          return { result: 'ok' };
        },
        'GET /api/states': () => (loaded ? [{ entity_id: 'automation.larder_shopping_list_when_you_reach_a_shop', attributes: { id: 'larder_shop_arrivals' } }] : []),
      }, log),
    });
    expect(await ha.saveAutomation('larder_shop_arrivals', { alias: 'Larder' })).toEqual({ entityId: 'automation.larder_shopping_list_when_you_reach_a_shop' });
    expect(log[0]).toMatchObject({ method: 'POST', body: { alias: 'Larder' } });
  });

  it('says when Home Assistant saved an automation but did not load it, or turned it down', async () => {
    const quiet = createHomeAssistant({ url: 'http://ha:8123', token: 'good', loadWaitMs: 100, fetch: fakeFetch({ 'POST /api/config/automation/config/x': { result: 'ok' }, 'GET /api/states': [] }) });
    expect(await quiet.saveAutomation('x', {})).toEqual({ entityId: null });

    const strict = createHomeAssistant({ url: 'http://ha:8123', token: 'good', fetch: fakeFetch({ 'POST /api/config/automation/config/x': 400 }) });
    await expect(strict.saveAutomation('x', {})).rejects.toThrow('Home Assistant said: Message malformed: extra keys not allowed');
  });
});
