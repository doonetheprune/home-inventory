/**
 * Home Assistant, through the Supervisor when Larder is an add-on, or
 * straight to Home Assistant given its address and a long-lived token.
 * Uses Home Assistant's own REST and websocket APIs, the ones its settings
 * pages use. Creating zones and automations needs an admin; the Supervisor
 * is one.
 */
import type { HomeAssistantPerson, HomeAssistantPhone, HomeAssistantPort, HomeAssistantZone } from '@larder/core';

export interface HomeAssistantOptions {
  /** "http://supervisor/core" for an add-on, or e.g. "http://homeassistant.local:8123". */
  url: string;
  token: string;
  /** As an add-on: the Supervisor's own API, to find the add-on's panel. */
  supervisor?: { url: string; token: string };
  fetch?: typeof fetch;
  /** Tests pass a stand-in. */
  WebSocket?: typeof WebSocket;
  timeoutMs?: number;
  /** How long to wait for a saved automation to load. */
  loadWaitMs?: number;
}

export class HomeAssistantError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

interface Socket {
  call<T = unknown>(command: Record<string, unknown>): Promise<T>;
  close(): void;
}

/** "shauns_phone" → "Shauns phone", when Home Assistant has no friendlier name. */
const humanise = (id: string) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** Home Assistant's slugify, near enough, for a zone's entity id. */
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function createHomeAssistant(o: HomeAssistantOptions): HomeAssistantPort {
  const doFetch = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = o.url.replace(/\/+$/, '');
  // The Supervisor serves Home Assistant's websocket at /core/websocket; Home Assistant itself at /api/websocket.
  const wsUrl = `${base.replace(/^http/, 'ws')}${base.endsWith('/core') ? '/websocket' : '/api/websocket'}`;
  const timeout = o.timeoutMs ?? 15_000;

  async function rest<T>(method: string, path: string, body?: unknown, url = base, token = o.token): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new HomeAssistantError(`Couldn't reach Home Assistant (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (res.status === 401 || res.status === 403) throw new HomeAssistantError(`Home Assistant refused (${res.status}). This needs an admin's access token.`, 'unauthorized');
    if (!res.ok) {
      // Home Assistant explains a rejected automation, e.g. "Message malformed: …".
      const said = await res.json().then((b: unknown) => { const m = (b as { message?: unknown } | null)?.message; return typeof m === 'string' ? m : ''; }, () => '');
      throw new HomeAssistantError(said ? `Home Assistant said: ${said}` : `Home Assistant answered ${res.status} to ${method} ${path}.`, res.status === 404 ? 'not_found' : undefined);
    }
    return (await res.json()) as T;
  }

  /** A signed-in websocket connection; each call waits for its own result. */
  function connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = new (o.WebSocket ?? WebSocket)(wsUrl);
      const waiting = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
      let id = 0;
      let open = false;
      const fail = (err: Error) => {
        for (const w of waiting.values()) w.reject(err);
        waiting.clear();
        if (!open) reject(err);
        socket.close();
      };
      const timer = setTimeout(() => fail(new HomeAssistantError('Home Assistant took too long to answer.')), timeout);
      socket.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string; id?: number; success?: boolean; result?: unknown; error?: { code?: string; message?: string } };
        if (msg.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: o.token }));
        else if (msg.type === 'auth_invalid') fail(new HomeAssistantError('Home Assistant didn\'t accept Larder\'s access token.', 'unauthorized'));
        else if (msg.type === 'auth_ok') {
          open = true;
          resolve({
            call: <T>(command: Record<string, unknown>) => new Promise<T>((res, rej) => {
              const n = ++id;
              waiting.set(n, { resolve: res as (r: unknown) => void, reject: rej });
              socket.send(JSON.stringify({ id: n, ...command }));
            }),
            close: () => {
              clearTimeout(timer);
              socket.close();
            },
          });
        } else if (msg.type === 'result' && msg.id !== undefined) {
          const w = waiting.get(msg.id);
          if (!w) return;
          waiting.delete(msg.id);
          if (msg.success) w.resolve(msg.result);
          else w.reject(new HomeAssistantError(msg.error?.message ?? 'Home Assistant refused.', msg.error?.code));
        }
      };
      socket.onerror = () => fail(new HomeAssistantError(`Couldn't reach Home Assistant at ${wsUrl}.`));
      socket.onclose = () => fail(new HomeAssistantError('Home Assistant closed the connection.'));
    });
  }

  return {
    async home() {
      const c = await rest<{ latitude: number; longitude: number; location_name: string }>('GET', '/api/config');
      return { latitude: c.latitude, longitude: c.longitude, name: c.location_name };
    },

    async people() {
      const states = await rest<Array<{ entity_id: string; attributes: { friendly_name?: string; device_trackers?: string[] } }>>('GET', '/api/states');
      const services = await rest<Array<{ domain: string; services: Record<string, unknown> }>>('GET', '/api/services');
      // Phones with the companion app have a notify action named after the phone.
      const mobile = Object.keys(services.find((d) => d.domain === 'notify')?.services ?? {}).filter((s) => s.startsWith('mobile_app_'));
      const friendly = (entityId: string) => states.find((s) => s.entity_id === entityId)?.attributes.friendly_name;
      const phones: HomeAssistantPhone[] = mobile.map((s) => {
        const device = s.slice('mobile_app_'.length);
        return { action: `notify.${s}`, name: friendly(`device_tracker.${device}`) ?? humanise(device) };
      });
      const people: HomeAssistantPerson[] = states
        .filter((s) => s.entity_id.startsWith('person.'))
        .map((s) => ({
          entityId: s.entity_id,
          name: s.attributes.friendly_name ?? humanise(s.entity_id.slice('person.'.length)),
          phones: (s.attributes.device_trackers ?? []).map((t) => `notify.mobile_app_${t.replace(/^device_tracker\./, '')}`).filter((a) => phones.some((p) => p.action === a)),
        }));
      return { people, phones };
    },

    async saveZones(zones: HomeAssistantZone[]) {
      const socket = await connect();
      try {
        const saved: Array<{ id: string; name: string }> = [];
        for (const z of zones) {
          const fields = { name: z.name, latitude: z.latitude, longitude: z.longitude, radius: z.radius, ...(z.icon ? { icon: z.icon } : {}) };
          let item: { id: string; name: string } | null = null;
          if (z.id) {
            // Update the zone Larder made before; if someone deleted it in Home Assistant, make it again.
            item = await socket.call<{ id: string; name: string }>({ type: 'zone/update', zone_id: z.id, ...fields }).catch((err: HomeAssistantError) => {
              if (err.code === 'not_found') return null;
              throw err;
            });
          }
          saved.push(item ?? (await socket.call<{ id: string; name: string }>({ type: 'zone/create', ...fields })));
        }
        const registry = await socket.call<Array<{ entity_id: string; platform: string; unique_id: string }>>({ type: 'config/entity_registry/list' });
        return saved.map((z) => ({ id: z.id, entityId: registry.find((e) => e.platform === 'zone' && e.unique_id === z.id)?.entity_id ?? `zone.${slug(z.name)}` }));
      } finally {
        socket.close();
      }
    },

    async saveAutomation(id, config) {
      await rest('POST', `/api/config/automation/config/${encodeURIComponent(id)}`, config);
      // Home Assistant reloads automations after it answers, so look for this one for a few seconds.
      const until = Date.now() + (o.loadWaitMs ?? 8000);
      for (;;) {
        const states = await rest<Array<{ entity_id: string; attributes: { id?: string } }>>('GET', '/api/states');
        const found = states.find((s) => s.entity_id.startsWith('automation.') && s.attributes.id === id);
        if (found) return { entityId: found.entity_id };
        if (Date.now() >= until) return { entityId: null };
        await new Promise((r) => setTimeout(r, 400));
      }
    },

    async removeZones(ids) {
      if (!ids.length) return;
      const socket = await connect();
      try {
        for (const id of ids) {
          await socket.call({ type: 'zone/delete', zone_id: id }).catch((err: HomeAssistantError) => {
            if (err.code !== 'not_found') throw err;
          });
        }
      } finally {
        socket.close();
      }
    },

    async removeAutomation(id) {
      await rest('DELETE', `/api/config/automation/config/${encodeURIComponent(id)}`).catch((err: HomeAssistantError) => {
        if (err.code !== 'not_found') throw err;
      });
    },

    async appPath() {
      if (!o.supervisor) return null;
      const info = await rest<{ data?: { slug?: string } }>('GET', '/addons/self/info', undefined, o.supervisor.url, o.supervisor.token).catch(() => null);
      return info?.data?.slug ? `/hassio/ingress/${info.data.slug}` : null;
    },
  };
}
