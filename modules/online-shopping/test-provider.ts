/**
 * A pretend shopping provider for tests, answering the way the contract says
 * (checked against larder-provider-tesco's conformance suite). It can be
 * asleep, logged out, or speak another contract version.
 */
import type { Deal, Product } from './contract';

export interface FakeListing extends Product {
  available?: boolean;
  error?: 'listing_dead' | 'out_of_stock' | null;
  deal?: Deal | null;
}

export function fakeProvider(o: { token?: string; version?: string; host?: { mac: string | null; address: string | null } | null } = {}) {
  const state = {
    asleep: false,
    loggedIn: true,
    /** Milliseconds each answer takes, to look like a real shop. */
    delayMs: 0,
    version: o.version ?? '1.3',
    capabilities: ['loyalty_prices', 'multibuys', 'slot_booking', 'favourites', 'add_favourites', 'search'],
    listings: new Map<string, FakeListing>(),
    favourites: [] as string[],
    basket: new Map<string, number>(),
    jobs: new Map<string, Record<string, unknown>>(),
    slots: [] as Array<{ id: string; start: string; end: string; price: number; available: boolean }>,
    booked: null as string | null,
    log: [] as Array<{ method: string; path: string; body?: unknown }>,
  };
  const token = o.token ?? 'secret';
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify({ contract_version: state.version, ...body }), { status, headers: { 'content-type': 'application/json' } });
  const error = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
  const product = (l: FakeListing): Product => ({ listing_id: l.listing_id, name: l.name, pack_size: l.pack_size, price: l.price, loyalty_price: l.loyalty_price, loyalty_price_valid: l.loyalty_price_valid ?? null, link: l.link, image_urls: l.image_urls });
  const find = (idOrLink: string) => state.listings.get(idOrLink) ?? [...state.listings.values()].find((l) => l.link === idOrLink);

  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    if (state.asleep) throw new TypeError('fetch failed');
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    state.log.push({ method, path: url.pathname + url.search, body });
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${token}`) return error(401, 'unauthorised', 'Wrong token.');
    const path = url.pathname;

    if (method === 'GET' && path === '/health') return reply(200, { ok: true, logged_in: state.loggedIn, session_valid: state.loggedIn, busy: false, message: state.loggedIn ? null : 'Log in to Tesco again in the Larder Chrome.' });
    if (method === 'GET' && path === '/manifest') return reply(200, { provider: 'tesco', name: 'Tesco', version: '0.1.0', currency: 'GBP', capabilities: state.capabilities, host: o.host === undefined ? { mac: '4c:32:75:12:34:56', address: '192.168.1.231' } : o.host });
    if (!state.loggedIn) return error(503, 'login_expired', 'Log in to Tesco again in the Larder Chrome, then try again.');

    if (method === 'GET' && path === '/slots') {
      const date = url.searchParams.get('date') ?? '2026-10-30';
      return reply(200, { date, described: `Friday 30 October${url.searchParams.get('when')?.includes('evening') ? ', evening (17:00 onwards)' : ''}`, window: null, slots: state.slots });
    }
    if (method === 'POST' && path === '/slots/book') {
      const slot = state.slots.find((s) => s.id === body?.slot_id && s.available);
      if (!slot) return error(409, 'slot_unavailable', 'That slot has gone. List the slots again.');
      state.booked = slot.id;
      return reply(200, { booking: { slot_id: slot.id, booking_reference: 'TSC-1234', reserved_until: '2026-10-28T11:00:00Z' } });
    }
    if (method === 'POST' && path === '/quote') {
      const ids = (body?.listing_ids as string[]) ?? [];
      return reply(200, {
        quotes: ids.map((id) => {
          const l = state.listings.get(id);
          if (!l || l.error === 'listing_dead') return { listing_id: id, available: false, error: 'listing_dead', name: null, pack_size: null, price: null, loyalty_price: null, loyalty_price_valid: null, price_per_unit: null, deal: null };
          const best = l.loyalty_price ?? l.price ?? 0;
          return {
            listing_id: id, available: l.available !== false, error: l.available === false ? 'out_of_stock' : null, name: l.name, pack_size: l.pack_size, price: l.price, loyalty_price: l.loyalty_price, loyalty_price_valid: l.loyalty_price_valid ?? null,
            price_per_unit: l.pack_size ? { price: best / l.pack_size.amount, unit: l.pack_size.unit } : null, deal: l.deal ?? null,
          };
        }),
      });
    }
    if (method === 'GET' && path === '/favourites') return reply(200, { fetched_at: '2026-10-28T08:00:00.000Z', stale: false, stale_reason: null, favourites: state.favourites.map((id) => product(state.listings.get(id)!)) });
    if (method === 'POST' && path === '/favourites') {
      const l = find(String(body?.id_or_link));
      if (!l) return error(404, 'listing_dead', 'Tesco has no product with that code or link.');
      if (!state.favourites.includes(l.listing_id)) state.favourites.push(l.listing_id);
      return reply(200, { product: product(l) });
    }
    if (method === 'GET' && path.startsWith('/products/')) {
      const l = find(decodeURIComponent(path.slice('/products/'.length)));
      return l ? reply(200, { product: product(l) }) : error(404, 'listing_dead', 'Tesco has no product with that code or link.');
    }
    if (method === 'GET' && path === '/search') return reply(200, { results: [...state.listings.values()].filter((l) => l.name.toLowerCase().includes((url.searchParams.get('q') ?? '').toLowerCase())).map(product) });
    if (method === 'POST' && path === '/basket/add') {
      const lines = (body?.lines as Array<{ listing_id: string; quantity: number }>) ?? [];
      const added: typeof lines = [];
      const failed: Array<Record<string, unknown>> = [];
      for (const line of lines) {
        const l = state.listings.get(line.listing_id);
        if (!l || l.error === 'listing_dead') failed.push({ ...line, error: 'listing_dead', message: 'That product has gone from Tesco.' });
        else if (l.available === false) failed.push({ ...line, error: 'out_of_stock', message: 'Out of stock at Tesco.' });
        else {
          state.basket.set(line.listing_id, (state.basket.get(line.listing_id) ?? 0) + line.quantity);
          added.push(line);
        }
      }
      const id = `job${state.jobs.size + 1}`;
      const job = { id, kind: 'basket_add', status: 'succeeded', created_at: '2026-10-28T09:00:00Z', finished_at: '2026-10-28T09:00:05Z', result: { added, failed }, error: null };
      state.jobs.set(id, job);
      return reply(202, { job: { ...job, status: 'queued', finished_at: null, result: null } });
    }
    if (method === 'GET' && path.startsWith('/jobs/')) {
      const job = state.jobs.get(path.slice('/jobs/'.length));
      return job ? reply(200, { job }) : error(404, 'not_found', 'No such job.');
    }
    if (method === 'GET' && path === '/basket') {
      const lines = [...state.basket.entries()].map(([id, quantity]) => ({ listing_id: id, name: state.listings.get(id)?.name ?? id, quantity, price: (state.listings.get(id)?.price ?? 0) * quantity }));
      return reply(200, { basket: { lines, total: lines.reduce((n, l) => n + l.price, 0) } });
    }
    return error(404, 'not_found', `No route ${method} ${path}.`);
  }) as unknown as typeof globalThis.fetch;

  /** Adds a product to the pretend shop. */
  function listing(id: string, name: string, pack: { amount: number; unit: 'kg' | 'l' | 'each' } | null, price: number, extra: Partial<FakeListing> = {}): FakeListing {
    const l: FakeListing = { listing_id: id, name, pack_size: pack, price, loyalty_price: null, loyalty_price_valid: null, link: `https://www.tesco.com/groceries/en-GB/products/${id}`, image_urls: [`https://digitalcontent.api.tesco.com/v2/media/ghs/${id}.jpeg`], ...extra };
    state.listings.set(id, l);
    return l;
  }

  return { fetch, state, listing, url: 'http://192.168.1.231:8710', token };
}
