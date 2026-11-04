/**
 * Larder Automations: the hub on a Mac that runs the household's shopping
 * automations (Tesco, then others). Larder knows one address and one token
 * for it; each automation is reached at `/automations/<id>/…` and linked to
 * a Larder shop as a provider. Waking and sleeping the Mac belong to the hub,
 * so every automation on it shares them.
 */
import { z } from 'zod';
import { LarderError, ValidationError, type ModuleContext } from '@larder/core';
import { ProviderError, shortAddress } from './client';
import { WakeSettings } from './wake';

/** The hub's port unless given. */
export const HUB_PORT = 8700;

export const HubAutomation = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable().default(null),
  /** Its own server answers (from the hub's /status). Null when unknown. */
  running: z.boolean().nullable().default(null),
});
export type HubAutomation = z.infer<typeof HubAutomation>;

export const HubStatus = z.object({
  checkedAt: z.string(),
  ok: z.boolean(),
  /** What's wrong or what to do, in words. Null when all is well. */
  message: z.string().nullable(),
  reachable: z.boolean(),
  version: z.string().nullable().default(null),
  /** The Chrome extension is connected to the hub. */
  extension: z.boolean().nullable().default(null),
  automations: z.array(HubAutomation).default([]),
});
export type HubStatus = z.infer<typeof HubStatus>;

export const Hub = z.object({
  /** e.g. http://192.168.1.231:8700 */
  url: z.string(),
  token: z.string(),
  wake: WakeSettings.nullable().default(null),
  sleepEntityId: z.string().nullable().default(null),
  status: HubStatus.nullable().default(null),
});
export type Hub = z.infer<typeof Hub>;

export const HubView = Hub.omit({ token: true }).extend({ tokenHint: z.string(), canWake: z.boolean() });
export type HubView = z.infer<typeof HubView>;

const EntityId = z.string().trim().max(200).regex(/^[a-z_]+\.[a-z0-9_]+$/, 'Use an entity id like switch.mac_mini or script.sleep_mac');

export const HubInput = z.object({
  address: z.string().min(1).max(300),
  /** Leave out to keep the saved one. */
  token: z.string().min(1).max(500).optional(),
  wake: WakeSettings.nullable().optional(),
  sleepEntityId: EntityId.nullable().optional(),
});

/** "192.168.1.231", "mac-mini.local:8700" or "http://…" → "http://192.168.1.231:8700". */
export function normaliseHubAddress(raw: string): string {
  const given = raw.trim().replace(/\/+$/, '');
  if (!given) throw new LarderError('Give the address of the Mac Larder Automations runs on, e.g. 192.168.1.231:8700.', 400, 'invalid');
  const withScheme = /^[a-z]+:\/\//i.test(given) ? given : `http://${given}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new LarderError(`"${raw}" isn't an address Larder can use. Give it like 192.168.1.231:8700.`, 400, 'invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LarderError('The address must start with http:// or https://.', 400, 'invalid');
  if (u.username || u.password) throw new LarderError('Put the token in its own box, not in the address.', 400, 'invalid');
  return `${u.protocol}//${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : String(HUB_PORT))}`;
}

const Health = z.object({ ok: z.boolean(), hub_version: z.string().nullable().default(null) });
const Automations = z.object({ automations: z.array(z.object({ id: z.string(), name: z.string(), version: z.string().nullable().default(null) })) });
const Status = z.object({
  extension: z.object({ connected: z.boolean() }).partial().nullable().default(null),
  mac: z.object({ network: z.object({ mac: z.string().nullable(), broadcast: z.string().nullable().default(null) }).nullable() }).nullable().default(null),
  automations: z.array(z.object({ id: z.string(), running: z.boolean().optional() })).default([]),
});

export function createHub(ctx: ModuleContext) {
  const settings = ctx.collection<Hub>('settings');

  async function get(): Promise<Hub | null> {
    const h = await settings.get('hub');
    return h ? Hub.parse(h) : null;
  }

  const view = (h: Hub): HubView => {
    const { token, ...rest } = h;
    return { ...rest, tokenHint: token.slice(-4), canWake: !!(h.wake?.entityId || h.wake?.mac) };
  };

  /** Asks the hub itself (not an automation). */
  async function ask<S extends z.ZodType>(h: Hub, schema: S, path: string, timeoutMs = 8000): Promise<z.output<S>> {
    let res: Response;
    try {
      res = await ctx.fetch(`${h.url}${path}`, { headers: { authorization: `Bearer ${h.token}`, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ProviderError(`Couldn't reach Larder Automations at ${shortAddress(h.url)}. Is the Mac on and Larder Automations running?`, 'unreachable', 503);
    }
    if (res.status === 401) throw new ProviderError('Larder Automations didn\'t accept Larder\'s token. Copy the token from its menu (Copy token) into Settings → Larder Automations.', 'unauthorised');
    const json = await res.json().catch(() => null);
    const parsed = schema.safeParse(json);
    if (!res.ok || !parsed.success) throw new ProviderError(`What answered at ${shortAddress(h.url)} isn't Larder Automations. Check the address (port ${HUB_PORT} unless you changed it).`, 'bad_answer');
    return parsed.data;
  }

  return {
    get,
    view,
    ask,

    async save(raw: z.input<typeof HubInput>): Promise<Hub> {
      const input = HubInput.parse(raw);
      const cur = await get();
      if (!cur && !input.token) throw new ValidationError('Paste the hub\'s token (Copy token in the Larder Automations menu).');
      const url = normaliseHubAddress(input.address);
      const token = input.token?.trim() ?? cur!.token;
      const moved = !cur || cur.url !== url || cur.token !== token;
      const next = Hub.parse({
        url, token,
        wake: input.wake !== undefined ? input.wake : (cur?.wake ?? null),
        sleepEntityId: input.sleepEntityId !== undefined ? input.sleepEntityId : (cur?.sleepEntityId ?? null),
        // A new address or token needs testing again.
        status: moved ? null : (cur?.status ?? null),
      });
      await settings.put('hub', next);
      return next;
    },

    async remove(): Promise<void> {
      await settings.remove('hub');
    },

    /** Its status after a test, or waking filled in from what the Mac says. */
    async update(h: Hub, patch: Partial<Pick<Hub, 'status' | 'wake'>>): Promise<Hub> {
      const next = Hub.parse({ ...h, ...patch });
      await settings.put('hub', next);
      return next;
    },

    /** Health, the automations it runs, and (from its status) whether the extension is connected and the Mac's network card for waking. */
    async probe(h: Hub): Promise<{ status: HubStatus; mac: { mac: string; broadcast: string | null } | null }> {
      const health = await ask(h, Health, '/health');
      const list = await ask(h, Automations, '/automations');
      const status = await ask(h, Status, '/status', 15_000).catch(() => null);
      const running = new Map(status?.automations.map((a) => [a.id, a.running ?? null]) ?? []);
      const extension = status?.extension?.connected ?? null;
      const automations = list.automations.map((a) => HubAutomation.parse({ ...a, running: running.get(a.id) ?? null }));
      const message = !automations.length ? 'No automations yet. Install one (larder-provider-tesco) on the Mac; it registers itself.'
        : extension === false ? 'The Larder Automations Chrome extension isn\'t connected. Open Chrome on the Mac (the menu\'s Install the Chrome extension… shows how).'
          : null;
      const net = status?.mac?.network;
      return {
        status: HubStatus.parse({ checkedAt: ctx.core.now(), ok: health.ok && !message, message, reachable: true, version: health.hub_version, extension, automations }),
        mac: net?.mac ? { mac: net.mac, broadcast: net.broadcast ?? null } : null,
      };
    },
  };
}
export type HubStore = ReturnType<typeof createHub>;

