/**
 * Shop locations: where each shop's branches are, as zones in Home Assistant,
 * and an automation there that sends a shop's list to your phone when you arrive.
 *
 * Branches come from OpenStreetMap, searched around home (Home Assistant's
 * home location, or a postcode). Larder makes the zones and the automation
 * through Home Assistant's own API when it can; it always offers the same as
 * YAML to paste in by hand.
 */
import { z } from 'zod';
import { defineModule, LarderError, newId, ValidationError, type CoreApi, type HomeAssistantPerson, type HomeAssistantPhone, type HomeAssistantPort, type Shop } from '@larder/core';
import { findBranches, geocode, NOMINATIM_URL, OVERPASS_URLS, type FoundBranch } from './osm';
import { toYaml } from './yaml';

export const AUTOMATION_ID = 'larder_shop_arrivals';

export const Branch = z.object({
  id: z.string(),
  shopId: z.string(),
  /** Where it came from on OpenStreetMap ("node/123"), so searching again finds the same branch. */
  osmId: z.string().nullable().default(null),
  /** Also the zone's name in Home Assistant, e.g. "Aldi, Wilmslow Road". */
  name: z.string().min(1).max(80),
  address: z.string().max(200).default(''),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** The zone's radius in metres. */
  radius: z.number().int().min(25).max(2000).default(150),
  /** The zone Larder made for it in Home Assistant. */
  zoneId: z.string().nullable().default(null),
  zoneEntityId: z.string().nullable().default(null),
  /** The zone in Home Assistant matches this branch (false after a change, until zones are made again). */
  zoneCurrent: z.boolean().default(false),
}).meta({ id: 'ShopBranch' });
export type Branch = z.infer<typeof Branch>;

const Home = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  label: z.string().max(200),
  /** home-assistant: Home Assistant's home location. search: a postcode or town. device: a phone or browser's location. */
  source: z.enum(['home-assistant', 'search', 'device']),
}).meta({ id: 'ShopLocationsHome' });
type Home = z.infer<typeof Home>;

const AlertPerson = z.object({
  entityId: z.string().regex(/^person\.[a-z0-9_]+$/, 'should look like person.sam'),
  name: z.string().max(80).default(''),
  /** The phone's notify action, e.g. notify.mobile_app_sams_phone, or null for no alert. */
  phone: z.string().regex(/^notify\.[a-z0-9_]+$/, 'should look like notify.mobile_app_sams_phone').nullable(),
});
const Alerts = z.object({
  people: z.array(AlertPerson).max(20).default([]),
  /** Only send an alert when there's something on that shop's list. */
  onlyWithItems: z.boolean().default(true),
  /** Set once Larder has made the automation in Home Assistant. */
  automationEntityId: z.string().nullable().default(null),
  savedAt: z.string().nullable().default(null),
});
type Alerts = z.infer<typeof Alerts>;

const Found = z.object({ osmId: z.string(), name: z.string(), street: z.string(), address: z.string(), latitude: z.number(), longitude: z.number(), distance: z.number(), saved: z.boolean() });
const Phone = z.object({ action: z.string(), name: z.string() });
const AlertsView = z.object({
  connected: z.boolean(),
  people: z.array(AlertPerson.extend({ phones: z.array(Phone) })),
  phones: z.array(Phone),
  onlyWithItems: z.boolean(),
  automation: z.object({ entityId: z.string().nullable(), savedAt: z.string().nullable() }).nullable(),
});
const Done = z.object({ message: z.string() });

// Routes that change Home Assistant are for household admins: as the add-on, Larder acts there as the Supervisor.
const NOT_CONNECTED = 'Larder isn\'t connected to Home Assistant, so it can\'t make zones or automations itself. Copy the YAML below into Home Assistant instead. (As a Home Assistant add-on Larder connects by itself; elsewhere, set LARDER_HA_URL and LARDER_HA_TOKEN.)';

/** Home Assistant's slugify, near enough: the entity id a YAML zone called `name` gets. */
export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** "Aldi, Wilmslow Road", or "Tesco Express, Oxford Road". */
export function branchName(found: Pick<FoundBranch, 'name' | 'street'>, taken: string[]): string {
  const base = (found.street ? `${found.name}, ${found.street}` : found.name).slice(0, 76);
  let name = base;
  for (let n = 2; taken.some((t) => t.toLowerCase() === name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

export interface ArrivalOptions {
  branches: Branch[];
  shops: Shop[];
  people: Array<{ entityId: string; phone: string | null }>;
  onlyWithItems: boolean;
  /** Where Larder opens in Home Assistant, so tapping the alert opens it. */
  appPath: string | null;
  /** Larder saves and updates it itself (rather than someone pasting the YAML in). */
  managed: boolean;
}

/** The automation: one trigger per person and branch, each saying which shop and which phone. */
export function arrivalAutomation(o: ArrivalOptions): Record<string, unknown> {
  const people = o.people.filter((p) => p.phone);
  const triggers = people.flatMap((p) =>
    o.branches.flatMap((b) => {
      const shop = o.shops.find((s) => s.id === b.shopId);
      if (!shop) return [];
      return [{ trigger: 'zone', entity_id: p.entityId, zone: b.zoneEntityId ?? `zone.${slug(b.name)}`, event: 'enter', variables: { shop_id: shop.id, shop: shop.name, phone: p.phone } }];
    }),
  );
  return {
    alias: 'Larder: shopping list when you reach a shop',
    description: `Made by Larder. When someone arrives at a shop, sends what to get there to their phone. ${o.managed ? 'Change it in Larder (Shop locations): Larder replaces it when shops, branches or alerts change.' : 'When shops or branches change, copy it again from Larder (Shop locations).'}`,
    mode: 'parallel',
    max: 10,
    triggers,
    conditions: [],
    actions: [
      { action: 'larder.shopping_list_for', data: { shop: '{{ shop_id }}' }, response_variable: 'list' },
      ...(o.onlyWithItems ? [{ condition: 'template', value_template: "{{ list['items'] | count > 0 }}" }] : []),
      {
        action: '{{ phone }}',
        data: {
          title: '{{ shop }}',
          message: '{{ list.message }}',
          // Opens Larder when tapped (url on iPhone, clickAction on Android); tag replaces an older alert for the same shop.
          data: { tag: 'larder-{{ shop_id }}', ...(o.appPath ? { url: o.appPath, clickAction: o.appPath } : {}) },
        },
      },
    ],
  };
}

/** The zones as a `zone:` list for configuration.yaml. */
export function zonesYaml(branches: Branch[]): string {
  return toYaml(
    { zone: branches.map((b) => ({ name: b.name, latitude: b.latitude, longitude: b.longitude, radius: b.radius, icon: 'mdi:cart' })) },
    ['Shop branches from Larder. Add this to configuration.yaml (if it already has a zone: list, add these', 'entries to it), then restart Home Assistant. Skip it if Larder made the zones for you.'],
  );
}

export default defineModule({
  id: 'shop-locations',
  name: 'Shop locations',
  description: 'Finds shops\' branches near home, makes them zones in Home Assistant, and sends a shop\'s list to your phone when you get there.',
  version: '1.0.0',
  setup(ctx) {
    const core: CoreApi = ctx.core;
    const branches = ctx.collection<Branch>('branches');
    const settings = ctx.collection<Record<string, unknown>>('settings');
    // Your own Overpass server(s) instead of the public ones, comma-separated.
    const overpassUrls = ctx.config.overpass_url ? ctx.config.overpass_url.split(',').map((u) => u.trim()).filter(Boolean) : OVERPASS_URLS;
    const nominatimUrl = ctx.config.nominatim_url || NOMINATIM_URL;

    const allBranches = async () => (await branches.list()).map((b) => Branch.parse(b.data)).sort((a, b) => a.name.localeCompare(b.name));
    const alerts = async (): Promise<Alerts> => Alerts.parse((await settings.get('alerts')) ?? {});
    const savedHome = async () => {
      const h = await settings.get('home');
      return h ? Home.parse(h) : null;
    };

    function ha(): HomeAssistantPort {
      if (!core.homeAssistant) throw new LarderError(NOT_CONNECTED, 409, 'no_home_assistant');
      return core.homeAssistant;
    }
    /** Runs a Home Assistant call, turning its failures into something to show. */
    async function inHA<T>(what: string, fn: (h: HomeAssistantPort) => Promise<T>): Promise<T> {
      const h = ha();
      try {
        return await fn(h);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if ((err as { code?: string }).code === 'unauthorized') {
          throw new LarderError(`Home Assistant wouldn't let Larder ${what}: that needs an admin's access token. Copy the YAML instead, or give Larder an admin's token.`, 502, 'home_assistant_refused');
        }
        throw new LarderError(`Couldn't ${what} in Home Assistant. ${message}`, 502, 'home_assistant');
      }
    }

    async function home(): Promise<Home | null> {
      const saved = await savedHome();
      if (saved || !core.homeAssistant) return saved;
      const h = await core.homeAssistant.home().catch(() => null);
      // A Home Assistant that was never told where home is says 0, 0.
      if (!h || (h.latitude === 0 && h.longitude === 0)) return null;
      return { latitude: h.latitude, longitude: h.longitude, label: 'Home Assistant\'s home location', source: 'home-assistant' };
    }

    async function shopFor(id: string): Promise<Shop> {
      return core.shops.get(id);
    }

    /** Makes or updates zones in Home Assistant for these branches and remembers which zone is whose. */
    async function makeZones(list: Branch[]): Promise<{ made: number; updated: number }> {
      if (!list.length) return { made: 0, updated: 0 };
      const saved = await inHA('make zones', (h) => h.saveZones(list.map((b) => ({ id: b.zoneId, name: b.name, latitude: b.latitude, longitude: b.longitude, radius: b.radius, icon: 'mdi:cart' }))));
      let made = 0;
      for (const [i, b] of list.entries()) {
        const z = saved[i]!;
        if (z.id !== b.zoneId) made++;
        await branches.put(b.id, { ...b, zoneId: z.id, zoneEntityId: z.entityId, zoneCurrent: true });
      }
      return { made, updated: list.length - made };
    }

    let appPath: string | null | undefined;
    async function automationConfig(a: Alerts, managed = true): Promise<Record<string, unknown>> {
      // The add-on's panel doesn't move, so ask once.
      if (appPath === undefined && core.homeAssistant) appPath = await core.homeAssistant.appPath().catch(() => undefined);
      return arrivalAutomation({ branches: await allBranches(), shops: await core.shops.list(), people: a.people, onlyWithItems: a.onlyWithItems, appPath: appPath ?? null, managed });
    }

    /** Saves the automation in Home Assistant. Says when Home Assistant saved it but didn't load it. */
    async function saveAutomation(a: Alerts): Promise<{ entityId: string | null; message: string }> {
      const config = await automationConfig(a);
      if (!(config.triggers as unknown[]).length) {
        await inHA('remove the arrival automation', (h) => h.removeAutomation(AUTOMATION_ID));
        await settings.put('alerts', { ...a, automationEntityId: null, savedAt: null });
        return { entityId: null, message: 'Nobody gets alerts now, so Larder removed its automation from Home Assistant.' };
      }
      const { entityId } = await inHA('save the arrival automation', (h) => h.saveAutomation(AUTOMATION_ID, config));
      await settings.put('alerts', { ...a, automationEntityId: entityId, savedAt: core.now() });
      await settings.put('sent', { automation: JSON.stringify(config) });
      if (!entityId) {
        return { entityId, message: 'Home Assistant saved the automation but hasn\'t loaded it. That happens when configuration.yaml doesn\'t have the line "automation: !include automations.yaml". Add it and restart Home Assistant.' };
      }
      return { entityId, message: 'Saved the arrival automation in Home Assistant.' };
    }

    /** Keeps the automation in step after branches, shops or alerts change, once Larder has made it. */
    async function syncAutomation(): Promise<boolean> {
      const a = await alerts();
      if (!a.savedAt || !core.homeAssistant) return false;
      // Most shop changes (what it sells) don't touch the automation: leave Home Assistant alone then.
      const sent = (await settings.get('sent'))?.automation;
      if (sent === JSON.stringify(await automationConfig(a))) return false;
      await saveAutomation(a);
      return true;
    }

    ctx.on('shop.changed', async (event) => {
      const id = String(event.data.id ?? '');
      const gone = await core.shops.get(id).then(() => false, () => true);
      try {
        if (gone) {
          const theirs = (await allBranches()).filter((b) => b.shopId === id);
          for (const b of theirs) await branches.remove(b.id);
          const zones = theirs.flatMap((b) => (b.zoneId ? [b.zoneId] : []));
          if (zones.length && core.homeAssistant) await core.homeAssistant.removeZones(zones);
        }
        // The automation names the shop, so a rename or removal changes it.
        await syncAutomation();
      } catch (err) {
        ctx.log.warn('Couldn\'t update Home Assistant after a shop changed', { err: err instanceof Error ? err.message : String(err) });
      }
    });

    ctx.addRoute({
      method: 'GET', path: '/status', summary: 'Where home is, and whether Larder can reach Home Assistant',
      response: z.object({ home: Home.nullable(), homeAssistant: z.object({ connected: z.boolean(), problem: z.string().nullable() }), branches: z.number(), zones: z.number() }),
      async handler() {
        let problem: string | null = null;
        if (core.homeAssistant) problem = await core.homeAssistant.home().then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err)));
        const all = await allBranches();
        return { home: await home(), homeAssistant: { connected: !!core.homeAssistant && !problem, problem }, branches: all.length, zones: all.filter((b) => b.zoneId).length };
      },
    });

    ctx.addRoute({
      method: 'PUT', path: '/home', summary: 'Say where home is: a postcode or town to look up, or a position',
      description: 'Only needed when Home Assistant doesn\'t know, or to search from somewhere else. The search text goes to OpenStreetMap\'s Nominatim.',
      body: z.union([z.object({ query: z.string().min(2).max(120) }), z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), label: z.string().max(200).optional() })]),
      response: Home,
      async handler({ body }) {
        const b = body as { query: string } | { latitude: number; longitude: number; label?: string };
        let h: Home;
        if ('query' in b) {
          const hit = await geocode(ctx.fetch, b.query, nominatimUrl).catch((err: unknown) => {
            throw new LarderError(`Couldn't look that up on the map. ${err instanceof Error ? err.message : ''}`.trim(), 502, 'map_unavailable');
          });
          if (!hit) throw new ValidationError(`The map doesn't know "${b.query}". Try a postcode.`);
          h = { latitude: hit.latitude, longitude: hit.longitude, label: hit.label, source: 'search' };
        } else {
          h = { latitude: b.latitude, longitude: b.longitude, label: b.label ?? 'This device\'s location', source: 'device' };
        }
        await settings.put('home', h);
        return h;
      },
    });

    ctx.addRoute({
      method: 'DELETE', path: '/home', summary: 'Forget the home set here and use Home Assistant\'s again',
      response: z.object({ home: Home.nullable() }),
      async handler() {
        await settings.remove('home');
        return { home: await home() };
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/nearby', summary: 'Branches of a shop near home, from OpenStreetMap, nearest first',
      description: 'Home\'s position is rounded to about 1 km before it is sent.',
      query: z.object({ shopId: z.string().min(1), within: z.coerce.number().int().min(500).max(50_000).default(5000).describe('Metres from home') }),
      response: z.object({ home: Home, results: z.array(Found) }),
      async handler({ query }) {
        const q = query as { shopId: string; within: number };
        const shop = await shopFor(q.shopId);
        const h = await home();
        if (!h) throw new LarderError('Larder doesn\'t know where home is yet. Set it on the Shop locations page.', 409, 'no_home');
        const found = await findBranches(ctx.fetch, shop.name, h, q.within, overpassUrls).catch((err: unknown) => {
          throw new LarderError(`Couldn't search the map. ${err instanceof Error ? err.message : ''}`.trim(), 502, 'map_unavailable');
        });
        const saved = new Set((await allBranches()).filter((b) => b.shopId === shop.id).map((b) => b.osmId));
        return { home: h, results: found.map((f) => ({ ...f, saved: saved.has(f.osmId) })) };
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/branches', summary: 'Saved branches, for one shop or all',
      query: z.object({ shopId: z.string().optional() }),
      response: z.array(Branch),
      async handler({ query }) {
        const { shopId } = query as { shopId?: string };
        return (await allBranches()).filter((b) => !shopId || b.shopId === shopId);
      },
    });

    ctx.addRoute({
      method: 'POST', path: '/branches', summary: 'Save branches of a shop (from /nearby, or typed in)',
      description: 'A branch found again by its OpenStreetMap id is updated rather than added twice.',
      body: z.object({
        shopId: z.string().min(1),
        branches: z.array(z.object({
          osmId: z.string().max(40).nullable().optional(),
          name: z.string().min(1).max(80),
          street: z.string().max(120).optional(),
          address: z.string().max(200).optional(),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          radius: z.number().int().min(25).max(2000).optional(),
        })).min(1).max(25),
      }),
      response: z.array(Branch),
      async handler({ body }) {
        const b = body as { shopId: string; branches: Array<{ osmId?: string | null; name: string; street?: string; address?: string; latitude: number; longitude: number; radius?: number }> };
        const shop = await shopFor(b.shopId);
        const all = await allBranches();
        for (const f of b.branches) {
          const same = f.osmId ? all.find((x) => x.shopId === shop.id && x.osmId === f.osmId) : undefined;
          if (same) {
            const moved = same.latitude !== f.latitude || same.longitude !== f.longitude;
            await branches.put(same.id, { ...same, address: f.address ?? same.address, latitude: f.latitude, longitude: f.longitude, zoneCurrent: same.zoneCurrent && !moved });
            continue;
          }
          const branch = Branch.parse({ id: newId(), shopId: shop.id, osmId: f.osmId ?? null, name: branchName({ name: f.name, street: f.street ?? '' }, all.map((x) => x.name)), address: f.address ?? '', latitude: f.latitude, longitude: f.longitude, radius: f.radius ?? 150 });
          all.push(branch);
          await branches.put(branch.id, branch);
        }
        return (await allBranches()).filter((x) => x.shopId === shop.id);
      },
    });

    ctx.addRoute({
      method: 'PATCH', path: '/branches/:id', admin: true, summary: 'Rename a branch or change its zone\'s size',
      params: z.object({ id: z.string() }),
      body: z.object({ name: z.string().min(1).max(80).optional(), radius: z.number().int().min(25).max(2000).optional() }),
      response: Branch,
      async handler({ params, body }) {
        const cur = await branches.get((params as { id: string }).id);
        if (!cur) throw new LarderError('That branch has gone.', 404, 'not_found');
        const patch = body as { name?: string; radius?: number };
        const next = Branch.parse({ ...cur, ...patch, zoneCurrent: false });
        await branches.put(next.id, next);
        return next;
      },
    });

    ctx.addRoute({
      method: 'DELETE', path: '/branches/:id', admin: true, summary: 'Forget a branch, and remove its zone from Home Assistant if Larder made one',
      params: z.object({ id: z.string() }),
      response: Done,
      async handler({ params }) {
        const cur = await branches.get((params as { id: string }).id);
        if (!cur) throw new LarderError('That branch has gone.', 404, 'not_found');
        await branches.remove(cur.id);
        if (cur.zoneId && core.homeAssistant) {
          await inHA('remove the zone', (h) => h.removeZones([cur.zoneId!]));
          await syncAutomation();
          return { message: `${cur.name} removed, and its zone in Home Assistant.` };
        }
        return { message: `${cur.name} removed.` };
      },
    });

    ctx.addRoute({
      method: 'POST', path: '/zones', admin: true, summary: 'Make (or update) a zone in Home Assistant for each saved branch',
      description: 'Updates the arrival automation too, once Larder has made it, so new branches send alerts.',
      body: z.object({ shopId: z.string().optional() }),
      response: z.object({ made: z.number(), updated: z.number(), automationUpdated: z.boolean(), message: z.string() }),
      async handler({ body }) {
        const { shopId } = body as { shopId?: string };
        const list = (await allBranches()).filter((b) => !shopId || b.shopId === shopId);
        if (!list.length) throw new ValidationError('There are no branches to make zones for. Find some on the Shops page first.');
        const { made, updated } = await makeZones(list);
        const automationUpdated = await syncAutomation();
        const parts = [made && `made ${made} zone${made === 1 ? '' : 's'}`, updated && `updated ${updated}`].filter(Boolean).join(' and ');
        return { made, updated, automationUpdated, message: `Home Assistant: ${parts}.${automationUpdated ? ' The arrival alert knows about them.' : ''}` };
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/alerts', summary: 'Who gets an alert on reaching a shop, and on which phone',
      description: 'People and phones come from Home Assistant: a phone is a companion app with a notify action.',
      response: AlertsView,
      async handler() {
        const a = await alerts();
        let found: { people: HomeAssistantPerson[]; phones: HomeAssistantPhone[] } | null = null;
        if (core.homeAssistant) found = await core.homeAssistant.people().catch(() => null);
        const people = found
          ? found.people.map((p) => {
              const saved = a.people.find((s) => s.entityId === p.entityId);
              // Someone with one phone gets alerts on it, until they say otherwise.
              return { entityId: p.entityId, name: p.name, phones: found!.phones.filter((ph) => p.phones.includes(ph.action)), phone: saved ? saved.phone : (p.phones[0] ?? null) };
            })
          : a.people.map((p) => ({ ...p, phones: [] }));
        return { connected: !!found, people, phones: found?.phones ?? [], onlyWithItems: a.onlyWithItems, automation: a.savedAt ? { entityId: a.automationEntityId, savedAt: a.savedAt } : null };
      },
    });

    ctx.addRoute({
      method: 'PUT', path: '/alerts', admin: true, summary: 'Choose who gets an alert and on which phone',
      description: 'Updates the automation in Home Assistant too, once Larder has made it.',
      body: z.object({ people: z.array(AlertPerson).max(20), onlyWithItems: z.boolean().optional() }),
      response: z.object({ automationUpdated: z.boolean() }),
      async handler({ body }) {
        const b = body as { people: Array<z.infer<typeof AlertPerson>>; onlyWithItems?: boolean };
        const a = await alerts();
        await settings.put('alerts', { ...a, people: b.people, onlyWithItems: b.onlyWithItems ?? a.onlyWithItems });
        return { automationUpdated: await syncAutomation() };
      },
    });

    ctx.addRoute({
      method: 'POST', path: '/automation', admin: true, summary: 'Make (or replace) the arrival automation in Home Assistant',
      description: `Saved as automation id ${AUTOMATION_ID}. Makes zones first for any branch that doesn't have one.`,
      body: z.object({}).optional(),
      response: z.object({ entityId: z.string().nullable(), loaded: z.boolean(), message: z.string() }),
      async handler() {
        ha();
        const a = await alerts();
        const all = await allBranches();
        if (!all.length) throw new ValidationError('There are no branches yet. On the Shops page, find nearby branches for a shop first.');
        if (!a.people.some((p) => p.phone)) throw new ValidationError('Choose whose phone gets the alert first.');
        const { made } = await makeZones(all.filter((b) => !b.zoneId || !b.zoneCurrent));
        const r = await saveAutomation(a);
        return { entityId: r.entityId, loaded: !!r.entityId, message: made ? `Made ${made} zone${made === 1 ? '' : 's'}. ${r.message}` : r.message };
      },
    });

    ctx.addRoute({
      method: 'DELETE', path: '/automation', admin: true, summary: 'Remove the arrival automation from Home Assistant',
      response: Done,
      async handler() {
        await inHA('remove the arrival automation', (h) => h.removeAutomation(AUTOMATION_ID));
        await settings.put('alerts', { ...(await alerts()), automationEntityId: null, savedAt: null });
        return { message: 'Arrival alerts are off: Larder removed its automation from Home Assistant.' };
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/yaml', summary: 'The zones and the arrival automation as YAML, to add to Home Assistant by hand',
      response: z.object({ zones: z.string(), automation: z.string(), placeholders: z.boolean() }),
      async handler() {
        const a = await alerts();
        const withPhones = a.people.filter((p) => p.phone);
        // Without anyone chosen yet, show the shape with names to change.
        const placeholders = !withPhones.length;
        const people = placeholders ? [{ entityId: 'person.your_name', name: '', phone: 'notify.mobile_app_your_phone' }] : withPhones;
        const config = await automationConfig({ ...a, people }, false);
        const automation = toYaml(config, [
          'In Home Assistant: Settings → Automations & scenes → Create automation → Create new automation,',
          'then ⋮ → Edit in YAML, and paste this in place of what is there.',
          ...(placeholders ? ['Change person.your_name and notify.mobile_app_your_phone to your own (Developer tools → Actions lists the notify ones).'] : []),
        ]);
        return { zones: zonesYaml(await allBranches()), automation, placeholders };
      },
    });
  },
});
