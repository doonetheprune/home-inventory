/**
 * Talks to one shopping provider over the contract: HTTP and JSON with the
 * shared token. Every answer is checked against the contract, and every
 * failure becomes a ProviderError whose message says what to do.
 */
import { z } from 'zod';
import { LarderError } from '@larder/core';
import {
  Basket, BasketAddResult, Booking, CONTRACT_MAJOR, ErrorBody, FavouriteList, Health, Job, Manifest, Product, Quote, SlotList,
  type BasketLine, type QuoteLine,
} from './contract';

/**
 * A provider's error, or not reaching it. `code` is the contract's code
 * (listing_dead, login_expired, bot_challenge…) or one of Larder's own:
 * unreachable, unauthorised, contract_mismatch, bad_answer.
 */
export class ProviderError extends LarderError {
  constructor(message: string, code: string, status = 502) {
    super(message, status, code);
    this.name = 'ProviderError';
  }
}

/** Codes that stop a whole shop and need the person (log in again, solve a challenge). */
export const STOPPING = new Set(['login_expired', 'bot_challenge']);

export interface ProviderAddress {
  /** e.g. "http://192.168.1.231:8710". */
  url: string;
  token: string;
  /** For messages, e.g. "the Tesco provider". */
  label: string;
}

const MINUTE = 60_000;

/** "192.168.1.231:8710", "mac-mini.local" or "http://…" → "http://192.168.1.231:8710" (port 8710 unless given). */
export function normaliseAddress(raw: string): string {
  const given = raw.trim().replace(/\/+$/, '');
  if (!given) throw new LarderError('Give the address the provider runs at, e.g. 192.168.1.231:8710.', 400, 'invalid');
  const withScheme = /^[a-z]+:\/\//i.test(given) ? given : `http://${given}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new LarderError(`"${raw}" isn't an address Larder can use. Give it like 192.168.1.231:8710.`, 400, 'invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LarderError('The address must start with http:// or https://.', 400, 'invalid');
  if (u.username || u.password) throw new LarderError('Put the token in its own box, not in the address.', 400, 'invalid');
  return `${u.protocol}//${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '8710')}${u.pathname === '/' ? '' : u.pathname}`;
}

/** Where it runs, for messages: "192.168.1.231:8710". */
export const shortAddress = (url: string) => url.replace(/^https?:\/\//, '');

export function providerClient(doFetch: typeof fetch, p: ProviderAddress) {
  async function call<S extends z.ZodType>(schema: S, method: string, path: string, body?: unknown, timeoutMs = MINUTE): Promise<z.output<S>> {
    let res: Response;
    try {
      res = await doFetch(`${p.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${p.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ProviderError(
        timedOut
          ? `${cap(p.label)} at ${shortAddress(p.url)} took too long to answer.`
          : `Couldn't reach ${p.label} at ${shortAddress(p.url)}. Is the machine on and the provider running?`,
        'unreachable', 503,
      );
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || typeof json !== 'object') throw new ProviderError(`${cap(p.label)} at ${shortAddress(p.url)} didn't answer like a Larder shopping provider. Check the address.`, 'bad_answer');
    const version = typeof json.contract_version === 'string' ? json.contract_version : null;
    if (!version) throw new ProviderError(`${cap(p.label)} at ${shortAddress(p.url)} didn't answer like a Larder shopping provider. Check the address.`, 'bad_answer');
    if (Number(version.split('.')[0]) !== CONTRACT_MAJOR) {
      throw new ProviderError(`${cap(p.label)} speaks contract ${version}, and this Larder understands ${CONTRACT_MAJOR}.x. Update whichever is older so they match.`, 'contract_mismatch');
    }
    if (!res.ok) {
      const e = ErrorBody.safeParse(json.error);
      if (res.status === 401 || e.data?.code === 'unauthorised') throw new ProviderError(`${cap(p.label)} didn't accept Larder's token. Check the token in Settings → Shopping providers matches the provider's AUTH_TOKEN.`, 'unauthorised');
      if (e.success) throw new ProviderError(e.data.message, e.data.code, res.status >= 400 && res.status < 600 ? res.status : 502);
      throw new ProviderError(`${cap(p.label)} answered ${res.status} to ${method} ${path.split('?')[0]}.`, 'provider_error');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ProviderError(`${cap(p.label)} sent an answer Larder couldn't read (${parsed.error.issues[0]?.path.join('.') || 'body'}: ${parsed.error.issues[0]?.message}).`, 'bad_answer');
    return parsed.data;
  }

  return {
    health: () => call(Health, 'GET', '/health', undefined, 8000),
    manifest: () => call(Manifest.extend({ contract_version: z.string() }), 'GET', '/manifest', undefined, 15_000),
    slots: (q: { when?: string; date?: string }) => call(SlotList, 'GET', `/slots?${new URLSearchParams(q.date ? { date: q.date } : { when: q.when ?? '' })}`, undefined, 3 * MINUTE),
    book: async (slotId: string) => (await call(z.object({ booking: Booking }), 'POST', '/slots/book', { slot_id: slotId }, 3 * MINUTE)).booking,
    /** Live prices, in the order asked. Up to 200 at a time; more are asked in batches. */
    async quote(listingIds: string[]): Promise<QuoteLine[]> {
      const out: QuoteLine[] = [];
      for (let i = 0; i < listingIds.length; i += 200) {
        const batch = listingIds.slice(i, i + 200);
        out.push(...(await call(Quote, 'POST', '/quote', { listing_ids: batch }, 20 * MINUTE)).quotes);
      }
      return out;
    },
    favourites: (refresh: boolean) => call(FavouriteList, 'GET', `/favourites?refresh=${refresh}`, undefined, 20 * MINUTE),
    addFavourite: async (idOrLink: string) => (await call(z.object({ product: Product }), 'POST', '/favourites', { id_or_link: idOrLink }, 3 * MINUTE)).product,
    product: async (idOrLink: string) => (await call(z.object({ product: Product }), 'GET', `/products/${encodeURIComponent(idOrLink)}`, undefined, 3 * MINUTE)).product,
    search: async (q: string) => (await call(z.object({ results: z.array(Product) }), 'GET', `/search?${new URLSearchParams({ q })}`, undefined, 3 * MINUTE)).results,
    basketAdd: async (lines: BasketLine[]) => (await call(z.object({ job: Job }), 'POST', '/basket/add', { lines })).job,
    basket: async () => (await call(z.object({ basket: Basket }), 'GET', '/basket', undefined, 3 * MINUTE)).basket,
    job: async (id: string) => (await call(z.object({ job: Job }), 'GET', `/jobs/${encodeURIComponent(id)}`)).job,
    /** Waits for a job to finish, checking every few seconds. */
    async waitFor(id: string, o: { pollMs?: number; timeoutMs?: number; onProgress?: () => void } = {}) {
      const until = Date.now() + (o.timeoutMs ?? 30 * MINUTE);
      for (;;) {
        const job = await call(z.object({ job: Job }), 'GET', `/jobs/${encodeURIComponent(id)}`).then((r) => r.job);
        if (job.status === 'succeeded' || job.status === 'failed') return job;
        if (Date.now() > until) throw new ProviderError(`${cap(p.label)} is still working on it after ${Math.round((o.timeoutMs ?? 30 * MINUTE) / MINUTE)} minutes. Check the basket on the shop's website.`, 'provider_error');
        await new Promise((r) => setTimeout(r, o.pollMs ?? 3000));
      }
    },
  };
}
export type ProviderClient = ReturnType<typeof providerClient>;
export { BasketAddResult };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
