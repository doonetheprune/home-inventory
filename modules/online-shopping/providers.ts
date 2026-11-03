/**
 * Shopping providers: one per shop, each a small service on a machine on the
 * network that drives that shop's website. Larder keeps where each runs, its
 * token, how to wake the machine (through Home Assistant) and its last status.
 */
import { z } from 'zod';
import { Id, LarderError, NotFoundError, ValidationError, newId, type ModuleContext, type Shop } from '@larder/core';
import { ProviderError, normaliseAddress, providerClient, shortAddress, type ProviderClient } from './client';
import type { Health, Manifest } from './contract';

/** Types offered under "Add automated shopping provider". Any provider keeping to the contract works as "another shop". */
export const PROVIDER_TYPES = [
  { type: 'tesco', name: 'Tesco', shop: 'Tesco' },
  { type: 'other', name: 'Another shop (any Larder shopping provider)', shop: null },
] as const;
export const ProviderType = z.enum(['tesco', 'other']);

const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

export const WakeSettings = z.object({
  /** A switch, button or script in Home Assistant that wakes the machine… */
  entityId: z.string().trim().max(200).regex(/^[a-z_]+\.[a-z0-9_]+$/, 'Use an entity id like switch.mac_mini or script.wake_mac').nullable().default(null),
  /** …or its MAC address, for Home Assistant's wake_on_lan.send_magic_packet. */
  mac: z.string().trim().regex(MAC, 'Use a MAC address like 4c:32:75:12:34:56').nullable().default(null),
  /** Where the magic packet goes, e.g. 192.168.1.255. Optional. */
  broadcastAddress: z.string().trim().max(60).nullable().default(null),
  /** How long to wait for it to answer after waking. */
  timeoutSeconds: z.number().int().min(10).max(900).default(180),
});
export type WakeSettings = z.infer<typeof WakeSettings>;

export const ProviderStatus = z.object({
  checkedAt: z.string(),
  /** Running, logged in and its session works. */
  ok: z.boolean(),
  /** What's wrong or what to do, in words. Null when all is well. */
  message: z.string().nullable(),
  reachable: z.boolean(),
  loggedIn: z.boolean().nullable(),
  /** From its manifest. */
  name: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  contractVersion: z.string().nullable().default(null),
  currency: z.string().nullable().default(null),
  capabilities: z.array(z.string()).default([]),
  host: z.object({ mac: z.string().nullable(), address: z.string().nullable() }).nullable().default(null),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const Provider = z.object({
  id: Id,
  type: ProviderType,
  /** The Larder shop it serves. One provider per shop. */
  shopId: Id,
  /** Used when nobody names a shop. Only one is. */
  isDefault: z.boolean().default(false),
  /** e.g. http://192.168.1.231:8710 */
  url: z.string(),
  token: z.string(),
  wake: WakeSettings.nullable().default(null),
  /** A switch, button or script that puts the machine back to sleep after a shop. */
  sleepEntityId: z.string().nullable().default(null),
  /** Count loyalty prices and deals (Clubcard). */
  loyaltyPrices: z.boolean().default(true),
  status: ProviderStatus.nullable().default(null),
  createdAt: z.string(),
});
export type Provider = z.infer<typeof Provider>;

/** What the app sees: never the token. */
export const ProviderView = Provider.omit({ token: true }).extend({
  shopName: z.string(),
  /** The token's last four characters. */
  tokenHint: z.string(),
  canWake: z.boolean(),
});
export type ProviderView = z.infer<typeof ProviderView>;

export const ProviderInput = z.object({
  type: ProviderType,
  shopId: Id,
  isDefault: z.boolean().optional(),
  address: z.string().min(1).max(300),
  token: z.string().min(1).max(500),
  wake: WakeSettings.nullable().optional(),
  sleepEntityId: z.string().trim().max(200).regex(/^[a-z_]+\.[a-z0-9_]+$/, 'Use an entity id like switch.mac_mini').nullable().optional(),
  loyaltyPrices: z.boolean().optional(),
});
export const ProviderPatch = ProviderInput.partial();

/** What Home Assistant does to wake (or sleep) the machine with an entity. */
function actionFor(entityId: string, sleep: boolean): [string, string] {
  const domain = entityId.split('.')[0]!;
  switch (domain) {
    case 'switch': return ['switch', sleep ? 'turn_off' : 'turn_on'];
    case 'button': case 'input_button': return [domain, 'press'];
    case 'script': return ['script', 'turn_on'];
    case 'automation': return ['automation', 'trigger'];
    default: throw new ValidationError(`${entityId} isn't a switch, button, script or automation, so Larder can't use it to ${sleep ? 'put the machine to sleep' : 'wake the machine'}.`);
  }
}

export function createProviders(ctx: ModuleContext) {
  const store = ctx.collection<Provider>('providers');
  /** Shops being worked on now, so the machine isn't put to sleep under another job. */
  const busy = new Map<string, number>();
  // How often to ask after waking; tests shorten it, and the wait.
  const pollMs = Number(ctx.config.wake_poll_ms ?? 5000);
  const waitMs = (p: Provider) => (ctx.config.wake_timeout_ms ? Number(ctx.config.wake_timeout_ms) : (p.wake?.timeoutSeconds ?? 180) * 1000);

  const all = async () => (await store.list()).map((d) => Provider.parse(d.data)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const shopName = async (shopId: string) => (await ctx.core.shops.list()).find((s) => s.id === shopId)?.name ?? 'shop';
  const label = async (p: Provider) => `the ${await shopName(p.shopId)} provider`;

  async function view(p: Provider, shops?: Shop[]): Promise<ProviderView> {
    const name = (shops ?? (await ctx.core.shops.list())).find((s) => s.id === p.shopId)?.name ?? 'Shop removed';
    const { token, ...rest } = p;
    return { ...rest, shopName: name, tokenHint: token.slice(-4), canWake: !!(p.wake?.entityId || p.wake?.mac) };
  }

  async function get(id: string): Promise<Provider> {
    const p = await store.get(id);
    if (!p) throw new NotFoundError('Shopping provider', id);
    return Provider.parse(p);
  }

  async function save(p: Provider): Promise<Provider> {
    const others = await all();
    if (others.some((o) => o.id !== p.id && o.shopId === p.shopId)) throw new LarderError(`${await shopName(p.shopId)} already has a shopping provider. Change that one instead.`, 409, 'conflict');
    if (p.isDefault) for (const o of others) if (o.id !== p.id && o.isDefault) await store.put(o.id, { ...o, isDefault: false });
    await store.put(p.id, p);
    return p;
  }

  async function client(p: Provider): Promise<ProviderClient> {
    return providerClient(ctx.fetch, { url: p.url, token: p.token, label: await label(p) });
  }

  async function sendWake(p: Provider, sleep = false): Promise<void> {
    const ha = ctx.core.homeAssistant;
    const what = sleep ? 'put it to sleep' : 'wake it';
    if (!ha) throw new LarderError(`Larder can't reach Home Assistant to ${what}. As an add-on it always can; elsewhere set LARDER_HA_URL and LARDER_HA_TOKEN.`, 503, 'no_home_assistant');
    try {
      if (sleep) {
        const [domain, service] = actionFor(p.sleepEntityId!, true);
        await ha.callService(domain, service, { entity_id: p.sleepEntityId });
      } else if (p.wake?.entityId) {
        const [domain, service] = actionFor(p.wake.entityId, false);
        await ha.callService(domain, service, { entity_id: p.wake.entityId });
      } else if (p.wake?.mac) {
        await ha.callService('wake_on_lan', 'send_magic_packet', { mac: p.wake.mac, ...(p.wake.broadcastAddress ? { broadcast_address: p.wake.broadcastAddress } : {}) });
      }
    } catch (err) {
      if (err instanceof LarderError) throw err;
      const said = err instanceof Error ? err.message : String(err);
      const noWol = !sleep && !p.wake?.entityId && /wake_on_lan|not found/i.test(said);
      throw new LarderError(
        noWol
          ? `Home Assistant can't send a magic packet (${said}). Add the Wake on LAN integration in Home Assistant, or choose a switch or script to wake the machine instead.`
          : `Home Assistant couldn't ${what}: ${said}`,
        502, 'wake_failed',
      );
    }
  }

  /** Answers health, waking the machine first if it doesn't answer and waking is set up. */
  async function awake(p: Provider, o: { wake?: boolean; onWaking?: () => void } = {}): Promise<{ health: Health; woke: boolean }> {
    const c = await client(p);
    try {
      return { health: await c.health(), woke: false };
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'unreachable' || o.wake === false) throw err;
      if (!p.wake?.entityId && !p.wake?.mac) throw new ProviderError(`${err.message} To have Larder wake it, set up waking in Settings → Shopping providers.`, 'unreachable', 503);
    }
    o.onWaking?.();
    await sendWake(p);
    const timeout = waitMs(p);
    const until = Date.now() + timeout;
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        return { health: await c.health(), woke: true };
      } catch (err) {
        if (!(err instanceof ProviderError) || err.code !== 'unreachable') throw err;
      }
      if (Date.now() >= until) {
        const secs = p.wake?.timeoutSeconds ?? 180;
        const within = secs % 60 === 0 ? `${secs / 60} minute${secs === 60 ? '' : 's'}` : `${secs} seconds`;
        throw new ProviderError(`Couldn't wake ${await label(p)}: it didn't answer within ${within} of waking. Check the machine is plugged in and on the network, and that the provider starts by itself.`, 'wake_timeout', 503);
      }
    }
  }

  const healthProblem = (h: Health, name: string): string | null =>
    !h.ok ? (h.message ?? `The ${name} provider isn't ready.`)
      : !h.logged_in || !h.session_valid ? (h.message ?? `Log in to ${name} again in the provider's browser.`)
        : null;

  /** Health and manifest, saved as the provider's status. Fills in waking from the manifest when it isn't set up yet. */
  async function check(p: Provider, o: { wake?: boolean } = {}): Promise<{ provider: Provider; woke: boolean; filledWake: boolean }> {
    const name = await shopName(p.shopId);
    let status: ProviderStatus;
    let woke = false;
    let filledWake = false;
    let next = p;
    try {
      const a = await awake(p, { wake: o.wake ?? false });
      woke = a.woke;
      const m: Manifest = await (await client(p)).manifest();
      const problem = healthProblem(a.health, name);
      status = ProviderStatus.parse({
        checkedAt: ctx.core.now(), ok: !problem, message: problem, reachable: true, loggedIn: a.health.logged_in && a.health.session_valid,
        name: m.name, version: m.version, contractVersion: (m as { contract_version?: string }).contract_version ?? null, currency: m.currency, capabilities: m.capabilities, host: m.host,
      });
      if (!p.wake && m.host?.mac) {
        next = { ...next, wake: WakeSettings.parse({ mac: m.host.mac }) };
        filledWake = true;
      }
    } catch (err) {
      if (!(err instanceof LarderError)) throw err;
      status = ProviderStatus.parse({ ...(p.status ?? {}), checkedAt: ctx.core.now(), ok: false, message: err.message, reachable: err.code !== 'unreachable' && err.code !== 'wake_timeout', loggedIn: null });
    }
    next = { ...next, status };
    await store.put(next.id, next);
    return { provider: next, woke, filledWake };
  }

  /** Puts the machine back to sleep once nothing else is going on there. */
  async function sleepIfIdle(p: Provider): Promise<boolean> {
    if (!p.sleepEntityId || (busy.get(p.id) ?? 0) > 0) return false;
    const h = await (await client(p)).health().catch(() => null);
    if (!h || h.busy) return false;
    await sendWake(p, true);
    return true;
  }

  /** Runs `fn` with the provider marked busy, so it isn't put to sleep part way. */
  async function working<T>(p: Provider, fn: () => Promise<T>): Promise<T> {
    busy.set(p.id, (busy.get(p.id) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      busy.set(p.id, (busy.get(p.id) ?? 1) - 1);
    }
  }

  return {
    all,
    get,
    view,
    async views(): Promise<ProviderView[]> {
      const shops = await ctx.core.shops.list();
      return Promise.all((await all()).map((p) => view(p, shops)));
    },
    shopName,
    label,
    client,
    awake,
    check,
    sleepIfIdle,
    working,
    healthProblem,

    async forShop(shopId: string): Promise<Provider | null> {
      return (await all()).find((p) => p.shopId === shopId) ?? null;
    },

    /** The provider for a shop named the way people say it, or the default one. */
    async resolve(shop?: string | null): Promise<{ provider: Provider; shop: Shop }> {
      const providers = await all();
      if (!providers.length) throw new LarderError('No online shop is set up yet. Add one in Settings → Shopping providers.', 409, 'no_provider');
      if (!shop?.trim()) {
        const p = providers.find((x) => x.isDefault) ?? (providers.length === 1 ? providers[0] : undefined);
        if (!p) throw new LarderError(`Which shop? Larder can shop online at ${(await Promise.all(providers.map((x) => shopName(x.shopId)))).join(' or ')}.`, 400, 'which_shop');
        const s = (await ctx.core.shops.list()).find((x) => x.id === p.shopId);
        if (!s) throw new LarderError('The default shopping provider\'s shop has been removed. Choose its shop again in Settings → Shopping providers.', 409, 'no_provider');
        return { provider: p, shop: s };
      }
      const s = await ctx.core.resolve.shop(shop);
      const p = providers.find((x) => x.shopId === s.id);
      if (!p) throw new LarderError(`Larder can't shop online at ${s.name} yet. Add a shopping provider for it in Settings → Shopping providers.`, 409, 'no_provider');
      return { provider: p, shop: s };
    },

    async create(raw: z.input<typeof ProviderInput>): Promise<Provider> {
      const input = ProviderInput.parse(raw);
      if (!(await ctx.core.shops.list()).some((s) => s.id === input.shopId)) throw new NotFoundError('Shop', input.shopId);
      const first = !(await all()).length;
      return save(Provider.parse({
        id: newId(), type: input.type, shopId: input.shopId, isDefault: input.isDefault ?? first, url: normaliseAddress(input.address), token: input.token.trim(),
        wake: input.wake ?? null, sleepEntityId: input.sleepEntityId ?? null, loyaltyPrices: input.loyaltyPrices ?? true, status: null, createdAt: ctx.core.now(),
      }));
    },

    async update(id: string, raw: z.input<typeof ProviderPatch>): Promise<Provider> {
      const input = ProviderPatch.parse(raw);
      const cur = await get(id);
      const moved = (input.address !== undefined && normaliseAddress(input.address) !== cur.url) || (input.token !== undefined && input.token.trim() !== cur.token);
      return save(Provider.parse({
        ...cur,
        ...(input.type ? { type: input.type } : {}),
        ...(input.shopId ? { shopId: input.shopId } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        ...(input.address !== undefined ? { url: normaliseAddress(input.address) } : {}),
        ...(input.token !== undefined ? { token: input.token.trim() } : {}),
        ...(input.wake !== undefined ? { wake: input.wake } : {}),
        ...(input.sleepEntityId !== undefined ? { sleepEntityId: input.sleepEntityId } : {}),
        ...(input.loyaltyPrices !== undefined ? { loyaltyPrices: input.loyaltyPrices } : {}),
        // A new address or token needs testing again.
        ...(moved ? { status: null } : {}),
      }));
    },

    async remove(id: string): Promise<void> {
      const p = await get(id);
      await store.remove(id);
      const rest = await all();
      if (p.isDefault && rest.length === 1) await store.put(rest[0]!.id, { ...rest[0]!, isDefault: true });
    },

    /** "192.168.1.231:8710" */
    where: (p: Provider) => shortAddress(p.url),
  };
}
export type Providers = ReturnType<typeof createProviders>;
