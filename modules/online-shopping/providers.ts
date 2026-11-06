/**
 * Shopping providers: one per shop, each a small service on a machine on the
 * network that drives that shop's website. Most are automations on the
 * Larder Automations hub (hub.ts), which gives their address, token and how to
 * wake the Mac; one can also be reached at an address of its own. Larder keeps
 * that, how to wake the machine (through Home Assistant) and its last status.
 */
import { z } from 'zod';
import { Id, LarderError, NotFoundError, ValidationError, newId, type ModuleContext, type Shop } from '@larder/core';
import { ProviderError, normaliseAddress, providerClient, shortAddress, type ProviderClient } from './client';
import type { Health, Manifest } from './contract';
import type { HubStore } from './hub';
import { WakeSettings, wakeMachine } from './wake';

export { WakeSettings };

/** Types offered under "Add automated shopping provider". Any provider keeping to the contract works as "another shop". */
export const PROVIDER_TYPES = [
  { type: 'tesco', name: 'Tesco', shop: 'Tesco' },
  { type: 'other', name: 'Another shop (any Larder shopping provider)', shop: null },
] as const;
export const ProviderType = z.enum(['tesco', 'other']);

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
  /** False when the shop has no delivery or collection slots at all. */
  usesSlots: z.boolean().default(true),
});
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const Provider = z.object({
  id: Id,
  type: ProviderType,
  /** The Larder shop it serves. One provider per shop. */
  shopId: Id,
  /** Used when nobody names a shop. Only one is. */
  isDefault: z.boolean().default(false),
  /** The Larder Automations automation it is (e.g. "tesco"), reached through the hub; null for one at its own address. */
  automation: z.string().nullable().default(null),
  /** e.g. http://192.168.1.231:8710. Empty for an automation (the hub's address is used). */
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

const AutomationId = z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/, 'An automation id is like "tesco"');

export const ProviderInput = z.object({
  type: ProviderType,
  shopId: Id,
  isDefault: z.boolean().optional(),
  /** An automation on Larder Automations (e.g. "tesco")… */
  automation: AutomationId.nullable().optional(),
  /** …or where a provider of its own runs, with its token. */
  address: z.string().min(1).max(300).optional(),
  token: z.string().min(1).max(500).optional(),
  wake: WakeSettings.nullable().optional(),
  sleepEntityId: z.string().trim().max(200).regex(/^[a-z_]+\.[a-z0-9_]+$/, 'Use an entity id like switch.mac_mini').nullable().optional(),
  loyaltyPrices: z.boolean().optional(),
});
export const ProviderPatch = ProviderInput.partial();

/** Where a provider is reached, and how its machine is woken: its own, or the hub's for an automation. */
interface Reach { url: string; token: string; wake: WakeSettings | null; sleepEntityId: string | null; hub: boolean }

export function createProviders(ctx: ModuleContext, hub: HubStore) {
  const store = ctx.collection<Provider>('providers');
  /** Shops being worked on now, so the machine isn't put to sleep under another job. */
  const busy = new Map<string, number>();
  // How often to ask after waking; tests shorten it, and the wait.
  const pollMs = Number(ctx.config.wake_poll_ms ?? 5000);
  const waitMs = (r: Reach) => (ctx.config.wake_timeout_ms ? Number(ctx.config.wake_timeout_ms) : (r.wake?.timeoutSeconds ?? 180) * 1000);

  const all = async () => (await store.list()).map((d) => Provider.parse(d.data)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const shopName = async (shopId: string) => (await ctx.core.shops.list()).find((s) => s.id === shopId)?.name ?? 'shop';
  const label = async (p: Provider) => `the ${await shopName(p.shopId)} provider`;

  async function reach(p: Provider): Promise<Reach> {
    if (!p.automation) return { url: p.url, token: p.token, wake: p.wake, sleepEntityId: p.sleepEntityId, hub: false };
    const h = await hub.get();
    if (!h) throw new LarderError(`${cap(await label(p))} runs on Larder Automations, which isn't set up. Add it in Settings → Larder Automations.`, 409, 'no_provider');
    return { url: `${h.url}/automations/${encodeURIComponent(p.automation)}`, token: h.token, wake: h.wake, sleepEntityId: h.sleepEntityId, hub: true };
  }

  async function view(p: Provider, shops?: Shop[]): Promise<ProviderView> {
    const name = (shops ?? (await ctx.core.shops.list())).find((s) => s.id === p.shopId)?.name ?? 'Shop removed';
    const r = await reach(p).catch(() => null);
    const { token, ...rest } = p;
    // An automation shows the hub's address and waking, which it uses.
    const shown = r?.hub ? { url: r.url, wake: r.wake, sleepEntityId: r.sleepEntityId } : {};
    const wake = r?.wake ?? p.wake;
    return { ...rest, ...shown, shopName: name, tokenHint: p.automation ? '' : token.slice(-4), canWake: !!(wake?.entityId || wake?.mac) };
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
    const r = await reach(p);
    return providerClient(ctx.fetch, { url: r.url, token: r.token, label: await label(p), hub: r.hub });
  }

  async function sendWake(p: Provider, sleep = false): Promise<void> {
    await wakeMachine(ctx, await reach(p), sleep);
  }

  /** Answers health, waking the machine first if it doesn't answer and waking is set up. */
  async function awake(p: Provider, o: { wake?: boolean; onWaking?: () => void } = {}): Promise<{ health: Health; woke: boolean }> {
    const r = await reach(p);
    const c = await client(p);
    try {
      return { health: await c.health(), woke: false };
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'unreachable' || o.wake === false) throw err;
      if (!r.wake?.entityId && !r.wake?.mac) throw new ProviderError(`${err.message} To have Larder wake it, set up waking in Settings → ${r.hub ? 'Larder Automations' : 'Online shops'}.`, 'unreachable', 503);
    }
    o.onWaking?.();
    await sendWake(p);
    const timeout = waitMs(r);
    const until = Date.now() + timeout;
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        return { health: await c.health(), woke: true };
      } catch (err) {
        if (!(err instanceof ProviderError) || err.code !== 'unreachable') throw err;
      }
      if (Date.now() >= until) {
        const secs = r.wake?.timeoutSeconds ?? 180;
        const within = secs % 60 === 0 ? `${secs / 60} minute${secs === 60 ? '' : 's'}` : `${secs} seconds`;
        throw new ProviderError(r.hub
          ? `Couldn't wake ${await label(p)}: Larder Automations didn't answer within ${within} of waking the Mac. Check the Mac is plugged in and on the network, and that Larder Automations starts at login.`
          : `Couldn't wake ${await label(p)}: it didn't answer within ${within} of waking. Check the machine is plugged in and on the network, and that the provider starts by itself.`, 'wake_timeout', 503);
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
        name: m.name, version: m.version, contractVersion: (m as { contract_version?: string }).contract_version ?? null, currency: m.currency, capabilities: m.capabilities, host: m.host, usesSlots: m.uses_slots,
      });
      if (m.host?.mac) {
        // An automation's machine is the hub's Mac: its waking is the hub's.
        const h = p.automation ? await hub.get() : null;
        if (h && !h.wake) {
          await hub.update(h, { wake: WakeSettings.parse({ mac: m.host.mac }) });
          filledWake = true;
        } else if (!p.automation && !p.wake) {
          next = { ...next, wake: WakeSettings.parse({ mac: m.host.mac }) };
          filledWake = true;
        }
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
    const r = await reach(p);
    // Every automation shares the hub's Mac, so none may be working.
    const sharing = r.hub ? (await all()).filter((o) => o.automation) : [p];
    if (!r.sleepEntityId || sharing.some((o) => (busy.get(o.id) ?? 0) > 0)) return false;
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
    reach,
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
      if (!providers.length) throw new LarderError('No online shop is set up yet. Set up Larder Automations in Settings, then link its automations to your shops.', 409, 'no_provider');
      if (!shop?.trim()) {
        const p = providers.find((x) => x.isDefault) ?? (providers.length === 1 ? providers[0] : undefined);
        if (!p) throw new LarderError(`Which shop? Larder can shop online at ${(await Promise.all(providers.map((x) => shopName(x.shopId)))).join(' or ')}.`, 400, 'which_shop');
        const s = (await ctx.core.shops.list()).find((x) => x.id === p.shopId);
        if (!s) throw new LarderError('The default shopping provider\'s shop has been removed. Choose its shop again in Settings → Larder Automations.', 409, 'no_provider');
        return { provider: p, shop: s };
      }
      const s = await ctx.core.resolve.shop(shop);
      const p = providers.find((x) => x.shopId === s.id);
      if (!p) throw new LarderError(`Larder can't shop online at ${s.name} yet. Link a Larder Automations automation to it in Settings.`, 409, 'no_provider');
      return { provider: p, shop: s };
    },

    async create(raw: z.input<typeof ProviderInput>): Promise<Provider> {
      const input = ProviderInput.parse(raw);
      if (!(await ctx.core.shops.list()).some((s) => s.id === input.shopId)) throw new NotFoundError('Shop', input.shopId);
      const first = !(await all()).length;
      const where = await whereFrom(input.automation ?? null, input.address, input.token, null);
      return save(Provider.parse({
        id: newId(), type: input.type, shopId: input.shopId, isDefault: input.isDefault ?? first, ...where,
        wake: input.wake ?? null, sleepEntityId: input.sleepEntityId ?? null, loyaltyPrices: input.loyaltyPrices ?? true, status: null, createdAt: ctx.core.now(),
      }));
    },

    async update(id: string, raw: z.input<typeof ProviderPatch>): Promise<Provider> {
      const input = ProviderPatch.parse(raw);
      const cur = await get(id);
      const automation = input.automation !== undefined ? input.automation : cur.automation;
      const where = automation
        ? await whereFrom(automation, undefined, undefined, cur)
        : input.address !== undefined || input.token !== undefined || cur.automation
          ? await whereFrom(null, input.address ?? (cur.automation ? undefined : cur.url), input.token ?? (cur.automation ? undefined : cur.token), cur)
          : { automation: null, url: cur.url, token: cur.token };
      const moved = where.automation !== cur.automation || where.url !== cur.url || where.token !== cur.token;
      return save(Provider.parse({
        ...cur,
        ...(input.type ? { type: input.type } : {}),
        ...(input.shopId ? { shopId: input.shopId } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        ...where,
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

  /** An automation on the hub (needs the hub, and one shop per automation), or an address and token of its own. */
  async function whereFrom(automation: string | null, address: string | undefined, token: string | undefined, cur: Provider | null): Promise<Pick<Provider, 'automation' | 'url' | 'token'>> {
    if (automation) {
      if (!(await hub.get())) throw new ValidationError('Set up Larder Automations first (its address and token), then link its automations to shops.');
      const other = (await all()).find((o) => o.automation === automation && o.id !== cur?.id);
      if (other) throw new LarderError(`That automation already shops for ${await shopName(other.shopId)}. Unlink it there first.`, 409, 'conflict');
      return { automation, url: '', token: '' };
    }
    if (!address?.trim()) throw new ValidationError('Give the address the provider runs at, e.g. 192.168.1.231:8710.');
    if (!token?.trim()) throw new ValidationError('Give the provider\'s token (its AUTH_TOKEN).');
    return { automation: null, url: normaliseAddress(address), token: token.trim() };
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export type Providers = ReturnType<typeof createProviders>;
