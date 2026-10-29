import { describe, expect, it } from 'vitest';
import type { HomeAssistantPort, HomeAssistantZone } from '@larder/core';
import { makeCore } from '../../tests/helpers';
import shopLocations, { AUTOMATION_ID, type Branch } from './index';
import { namePattern, overpassQuery } from './osm';
import { scalar, toYaml } from './yaml';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = <T = unknown>(core: Core, method: string, path: string, opts: { body?: unknown; query?: unknown; params?: Record<string, string> } = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'shop-locations' && r.route.method === method && r.route.path === path)!.route
    .handler({ body: opts.body, query: opts.query ?? {}, params: opts.params ?? {}, userId: null }) as Promise<T>;

const HOME = { latitude: 53.44321, longitude: -2.22187 };

/** A pretend Overpass and Nominatim. Records what was sent. */
function maps() {
  const sent: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.hostname === 'overpass.test') {
      const query = new URLSearchParams(String(init?.body)).get('data')!;
      sent.push(query);
      const aldi = { type: 'node', id: 1, lat: 53.4452, lon: -2.219, tags: { shop: 'supermarket', name: 'Aldi', brand: 'Aldi', 'addr:street': 'Wilmslow Road', 'addr:housenumber': '12', 'addr:suburb': 'Rusholme', 'addr:postcode': 'M14 5TQ' } };
      return Response.json({
        elements: [
          aldi,
          { type: 'way', id: 2, center: { lat: 53.46, lon: -2.23 }, tags: { shop: 'supermarket', name: 'ALDI', 'addr:street': 'Oxford Road' } },
          { type: 'node', id: 3, lat: 53.6, lon: -2.22, tags: { shop: 'supermarket', name: 'Aldi' } },
          { type: 'node', id: 4, lat: 53.444, lon: -2.222, tags: { shop: 'vacant', name: 'Aldi' } },
          aldi,
        ],
      });
    }
    if (u.hostname === 'nominatim.test') {
      sent.push(url);
      return Response.json(u.searchParams.get('q') === 'M14 5TQ' ? [{ lat: '53.4433', lon: '-2.2219', display_name: 'M14 5TQ, Rusholme, Manchester, Greater Manchester, England, United Kingdom' }] : []);
    }
    throw new Error(`No network in tests (${url})`);
  }) as unknown as typeof fetch;
  return { fetch: fake, sent };
}

/** A pretend Home Assistant: zones and automations in memory. */
function homeAssistant(o: { refuse?: boolean; loads?: boolean; home?: { latitude: number; longitude: number } } = {}) {
  const zones = new Map<string, HomeAssistantZone>();
  const automations = new Map<string, Record<string, unknown>>();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const port: HomeAssistantPort = {
    home: async () => ({ ...(o.home ?? HOME), name: 'Home' }),
    people: async () => ({
      people: [{ entityId: 'person.shaun', name: 'Shaun', phones: ['notify.mobile_app_shauns_pixel'] }, { entityId: 'person.sam', name: 'Sam', phones: [] }],
      phones: [{ action: 'notify.mobile_app_shauns_pixel', name: 'Shaun’s Pixel' }, { action: 'notify.mobile_app_sams_iphone', name: 'Sam’s iPhone' }],
    }),
    async saveZones(list) {
      if (o.refuse) throw Object.assign(new Error('Unauthorized'), { code: 'unauthorized' });
      return list.map((z) => {
        const id = z.id && zones.has(z.id) ? z.id : slug(z.name);
        zones.set(id, { ...z, id });
        return { id, entityId: `zone.${id}` };
      });
    },
    async saveAutomation(id, config) {
      automations.set(id, config);
      return { entityId: o.loads === false ? null : 'automation.larder_shopping_list_when_you_reach_a_shop' };
    },
    async removeZones(ids) {
      for (const id of ids) zones.delete(id);
    },
    async removeAutomation(id) {
      automations.delete(id);
    },
    appPath: async () => '/hassio/ingress/abc_larder',
  };
  return { port, zones, automations };
}

async function setup(o: { ha?: ReturnType<typeof homeAssistant> } = {}) {
  const m = maps();
  const core = await makeCore({ modules: [shopLocations], fetch: m.fetch, homeAssistant: o.ha?.port, env: { LARDER_MODULE_SHOP_LOCATIONS_OVERPASS_URL: 'https://overpass.test/api/interpreter', LARDER_MODULE_SHOP_LOCATIONS_NOMINATIM_URL: 'https://nominatim.test/search' } });
  const aldi = await core.shops.addPreset('Aldi');
  return { core, aldi, sent: m.sent };
}

interface Nearby { home: { source: string }; results: Array<{ osmId: string; name: string; street: string; address: string; latitude: number; longitude: number; distance: number; saved: boolean }> }

async function saveNearby(core: Core, shopId: string) {
  const found = await call<Nearby>(core, 'GET', '/nearby', { query: { shopId, within: 5000 } });
  return call<Branch[]>(core, 'POST', '/branches', { body: { shopId, branches: found.results } });
}

describe('shop locations: the map', () => {
  it('matches shop names the way they are written on the map', () => {
    const test = (shop: string, name: string) => new RegExp(namePattern(shop), 'i').test(name);
    expect(test('Aldi', 'ALDI')).toBe(true);
    expect(test('Aldi', 'Waldis Cafe')).toBe(false);
    expect(test("Sainsbury's", 'Sainsburys Local')).toBe(true);
    expect(test("Sainsbury's", 'Sainsbury’s')).toBe(true);
    expect(test('Co-op', 'The Co-operative Food')).toBe(true);
    expect(test('M&S', 'Marks and Spencer Simply Food')).toBe(true);
    expect(test('B&Q', 'B & Q')).toBe(true);
  });

  it('sends home rounded to about 1 km, and searches that much further', () => {
    const q = overpassQuery('Aldi', HOME, 5000);
    expect(q).toContain('(around:6000,53.44,-2.22)');
    expect(q).not.toContain('53.443');
  });

  it('finds branches near Home Assistant\'s home, nearest first, and saves them once', async () => {
    const { core, aldi, sent } = await setup({ ha: homeAssistant() });
    const found = await call<Nearby>(core, 'GET', '/nearby', { query: { shopId: aldi.id, within: 5000 } });
    expect(sent[0]).toContain('53.44,-2.22');
    expect(found.home.source).toBe('home-assistant');
    expect(found.results.map((r) => [r.osmId, r.name, r.address, r.saved])).toEqual([
      ['node/1', 'Aldi', '12 Wilmslow Road, Rusholme, M14 5TQ', false],
      ['way/2', 'ALDI', 'Oxford Road', false],
    ]);
    expect(found.results[0]!.distance).toBeGreaterThan(150);
    expect(found.results[0]!.distance).toBeLessThan(400);

    const saved = await saveNearby(core, aldi.id);
    expect(saved.map((b) => [b.name, b.radius, b.zoneId])).toEqual([['ALDI, Oxford Road', 150, null], ['Aldi, Wilmslow Road', 150, null]]);
    // Finding them again marks them saved, and saving again doesn't add them twice.
    expect((await call<Nearby>(core, 'GET', '/nearby', { query: { shopId: aldi.id, within: 5000 } })).results.every((r) => r.saved)).toBe(true);
    expect(await saveNearby(core, aldi.id)).toHaveLength(2);
  });

  it('looks up a postcode when Home Assistant isn\'t there to say where home is', async () => {
    const { core, aldi } = await setup();
    await expect(call(core, 'GET', '/nearby', { query: { shopId: aldi.id, within: 5000 } })).rejects.toMatchObject({ code: 'no_home' });
    await expect(call(core, 'PUT', '/home', { body: { query: 'Atlantis' } })).rejects.toThrow('The map doesn\'t know "Atlantis". Try a postcode.');
    const home = await call<{ label: string; source: string }>(core, 'PUT', '/home', { body: { query: 'M14 5TQ' } });
    expect(home).toMatchObject({ label: 'M14 5TQ, Rusholme, Manchester', source: 'search' });
    expect((await call<Nearby>(core, 'GET', '/nearby', { query: { shopId: aldi.id, within: 5000 } })).results).toHaveLength(2);
    expect(await call(core, 'GET', '/status')).toMatchObject({ home: { source: 'search' }, homeAssistant: { connected: false }, branches: 0 });
  });
});

describe('shop locations: Home Assistant', () => {
  it('makes zones, then updates the same ones', async () => {
    const ha = homeAssistant();
    const { core, aldi } = await setup({ ha });
    await saveNearby(core, aldi.id);
    expect(await call(core, 'POST', '/zones', { body: {} })).toMatchObject({ made: 2, updated: 0, automationUpdated: false, message: 'Home Assistant: made 2 zones.' });
    expect([...ha.zones.values()].map((z) => [z.name, z.radius, z.icon])).toEqual([['ALDI, Oxford Road', 150, 'mdi:cart'], ['Aldi, Wilmslow Road', 150, 'mdi:cart']]);

    const [oxford] = await call<Branch[]>(core, 'GET', '/branches', { query: { shopId: aldi.id } });
    expect(oxford).toMatchObject({ zoneId: 'aldi_oxford_road', zoneEntityId: 'zone.aldi_oxford_road', zoneCurrent: true });
    expect(await call(core, 'PATCH', '/branches/:id', { params: { id: oxford!.id }, body: { name: 'Big Aldi', radius: 250 } })).toMatchObject({ zoneCurrent: false });
    expect(await call(core, 'POST', '/zones', { body: { shopId: aldi.id } })).toMatchObject({ made: 0, updated: 2 });
    expect(ha.zones.get('aldi_oxford_road')).toMatchObject({ name: 'Big Aldi', radius: 250 });
  });

  it('makes the arrival automation: one trigger per person and branch, with the shop and phone', async () => {
    const ha = homeAssistant();
    const { core, aldi } = await setup({ ha });
    await saveNearby(core, aldi.id);
    await expect(call(core, 'POST', '/automation')).rejects.toThrow('Choose whose phone gets the alert first.');

    // Shaun has one phone, so it's chosen for him; Sam has none.
    const alerts = await call<{ people: Array<{ entityId: string; phone: string | null; phones: unknown[] }> }>(core, 'GET', '/alerts');
    expect(alerts.people.map((p) => [p.entityId, p.phone, p.phones.length])).toEqual([['person.shaun', 'notify.mobile_app_shauns_pixel', 1], ['person.sam', null, 0]]);
    await call(core, 'PUT', '/alerts', { body: { people: alerts.people.map(({ entityId, phone }) => ({ entityId, name: '', phone })) } });

    const r = await call<{ entityId: string; loaded: boolean; message: string }>(core, 'POST', '/automation');
    expect(r).toMatchObject({ loaded: true, entityId: 'automation.larder_shopping_list_when_you_reach_a_shop', message: 'Made 2 zones. Saved the arrival automation in Home Assistant.' });
    const config = ha.automations.get(AUTOMATION_ID)!;
    expect(config.triggers).toEqual([
      { trigger: 'zone', entity_id: 'person.shaun', zone: 'zone.aldi_oxford_road', event: 'enter', variables: { shop_id: aldi.id, shop: 'Aldi', phone: 'notify.mobile_app_shauns_pixel' } },
      { trigger: 'zone', entity_id: 'person.shaun', zone: 'zone.aldi_wilmslow_road', event: 'enter', variables: { shop_id: aldi.id, shop: 'Aldi', phone: 'notify.mobile_app_shauns_pixel' } },
    ]);
    expect(config.actions).toEqual([
      { action: 'larder.shopping_list_for', data: { shop: '{{ shop_id }}' }, response_variable: 'list' },
      { condition: 'template', value_template: "{{ list['items'] | count > 0 }}" },
      { action: '{{ phone }}', data: { title: '{{ shop }}', message: '{{ list.message }}', data: { tag: 'larder-{{ shop_id }}', url: '/hassio/ingress/abc_larder', clickAction: '/hassio/ingress/abc_larder' } } },
    ]);

    // Sam borrows the iPhone: the automation follows without pressing anything.
    expect(await call(core, 'PUT', '/alerts', { body: { people: [{ entityId: 'person.shaun', phone: 'notify.mobile_app_shauns_pixel' }, { entityId: 'person.sam', phone: 'notify.mobile_app_sams_iphone' }] } })).toEqual({ automationUpdated: true });
    expect(ha.automations.get(AUTOMATION_ID)!.triggers).toHaveLength(4);
  });

  it('keeps zones and the automation in step when branches and shops go', async () => {
    const ha = homeAssistant();
    const { core, aldi } = await setup({ ha });
    const lidl = await core.shops.addPreset('Lidl');
    const [oxford] = await saveNearby(core, aldi.id);
    await saveNearby(core, lidl.id);
    await call(core, 'PUT', '/alerts', { body: { people: [{ entityId: 'person.shaun', phone: 'notify.mobile_app_shauns_pixel' }] } });
    await call(core, 'POST', '/automation');
    expect(ha.zones.size).toBe(4);

    expect(await call(core, 'DELETE', '/branches/:id', { params: { id: oxford!.id } })).toEqual({ message: 'ALDI, Oxford Road removed, and its zone in Home Assistant.' });
    expect(ha.zones.has('aldi_oxford_road')).toBe(false);
    expect(ha.automations.get(AUTOMATION_ID)!.triggers).toHaveLength(3);

    // Changing what a shop sells leaves Home Assistant alone; removing it takes its branches and zones away.
    const sent = ha.automations.get(AUTOMATION_ID);
    await core.shops.update(lidl.id, { sells: [] });
    expect(ha.automations.get(AUTOMATION_ID)).toBe(sent);
    await core.shops.remove(lidl.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(await call<Branch[]>(core, 'GET', '/branches')).toHaveLength(1);
    expect([...ha.zones.keys()]).toEqual(['aldi_wilmslow_road']);
    expect(ha.automations.get(AUTOMATION_ID)!.triggers).toHaveLength(1);

    expect(await call(core, 'DELETE', '/automation')).toMatchObject({ message: expect.stringContaining('Arrival alerts are off') });
    expect(ha.automations.size).toBe(0);
  });

  it('says what to do when Home Assistant refuses, isn\'t there, or doesn\'t load the automation', async () => {
    const refusing = await setup({ ha: homeAssistant({ refuse: true }) });
    await saveNearby(refusing.core, refusing.aldi.id);
    await expect(call(refusing.core, 'POST', '/zones', { body: {} })).rejects.toMatchObject({ status: 502, code: 'home_assistant_refused', message: expect.stringContaining('needs an admin\'s access token') });

    const alone = await setup();
    await call(alone.core, 'PUT', '/home', { body: { latitude: HOME.latitude, longitude: HOME.longitude } });
    await saveNearby(alone.core, alone.aldi.id);
    await expect(call(alone.core, 'POST', '/zones', { body: {} })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Copy the YAML') });

    const ha = homeAssistant({ loads: false });
    const quiet = await setup({ ha });
    await saveNearby(quiet.core, quiet.aldi.id);
    await call(quiet.core, 'PUT', '/alerts', { body: { people: [{ entityId: 'person.shaun', phone: 'notify.mobile_app_shauns_pixel' }] } });
    expect(await call(quiet.core, 'POST', '/automation')).toMatchObject({ loaded: false, message: expect.stringContaining('automation: !include automations.yaml') });
  });

  it('writes the zones and automation as YAML to paste in', async () => {
    const { core, aldi } = await setup();
    await call(core, 'PUT', '/home', { body: { latitude: HOME.latitude, longitude: HOME.longitude } });
    await saveNearby(core, aldi.id);
    const y = await call<{ zones: string; automation: string; placeholders: boolean }>(core, 'GET', '/yaml');
    expect(y.zones).toContain([
      'zone:',
      '  - name: ALDI, Oxford Road',
      '    latitude: 53.46',
      '    longitude: -2.23',
      '    radius: 150',
      '    icon: mdi:cart',
      '  - name: Aldi, Wilmslow Road',
    ].join('\n'));
    expect(y.placeholders).toBe(true);
    expect(y.automation).toContain('# Change person.your_name and notify.mobile_app_your_phone');
    expect(y.automation).toContain([
      'triggers:',
      '  - trigger: zone',
      '    entity_id: person.your_name',
      '    zone: zone.aldi_oxford_road',
      '    event: enter',
      '    variables:',
      `      shop_id: ${scalar(aldi.id)}`,
      '      shop: Aldi',
      '      phone: notify.mobile_app_your_phone',
    ].join('\n'));
    expect(y.automation).toContain('  - action: "{{ phone }}"');
    expect(y.automation).toContain('conditions: []');
  });
});

describe('YAML', () => {
  it('quotes only what YAML would read differently', () => {
    expect(['Aldi, Wilmslow Road', 'on', 'Yes', '12', "Sainsbury's", '{{ shop }}', 'a: b', 'mdi:cart'].map(scalar)).toEqual([
      'Aldi, Wilmslow Road', '"on"', '"Yes"', '"12"', '"Sainsbury\'s"', '"{{ shop }}"', '"a: b"', 'mdi:cart',
    ]);
    expect(toYaml({ a: [{ b: 1, c: [] }, 'x'], d: {} }, ['note'])).toBe('# note\na:\n  - b: 1\n    c: []\n  - x\nd: {}\n');
  });
});
