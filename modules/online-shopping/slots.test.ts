import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
import onlineShopping from './index';
import { fakeProvider } from './test-provider';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = <T = unknown>(core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'online-shopping' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params, userId: null }) as Promise<T>;

async function setup() {
  const shop = fakeProvider();
  const core = await makeCore({ modules: [onlineShopping], fetch: shop.fetch, env: { LARDER_MODULE_ONLINE_SHOPPING_JOB_POLL_MS: '5' } });
  const tesco = await core.shops.addPreset('Tesco');
  const provider = await call<{ id: string }>(core, 'POST', '/providers', { type: 'tesco', shopId: tesco.id, address: '192.168.1.231:8710', token: 'secret' });
  shop.state.slots = [
    { id: 's17', start: '2026-10-30T17:00:00+00:00', end: '2026-10-30T18:00:00+00:00', price: 0, available: true },
    { id: 's18', start: '2026-10-30T18:00:00+00:00', end: '2026-10-30T19:00:00+00:00', price: 1.5, available: true },
    { id: 's19', start: '2026-10-30T19:00:00+00:00', end: '2026-10-30T20:00:00+00:00', price: 0, available: false },
  ];
  return { core, shop, tesco, provider };
}

describe('online shopping: delivery slots and "do me a shop"', () => {
  it('starts a shop by asking when, then lists the free slots for that day', async () => {
    const { core, shop } = await setup();
    expect((await core.assistant.call('start_shop', {})).text).toBe('Tesco is ready.\nAsk when they\'d like it delivered (e.g. "tomorrow evening"), then call start_shop again with when.');
    const r = await core.assistant.call('start_shop', { when: 'friday evening' });
    expect(r.text).toBe([
      'Tesco is ready.',
      'Friday 30 October, evening (17:00 onwards) at Tesco:',
      '- 17:00–18:00, free (id s17)',
      '- 18:00–19:00, £1.50 (id s18)',
      'Say the day back to the person so a misread shows, suggest one, and book it with book_slot once they agree.',
      'After booking, fill the basket with fill_basket.',
    ].join('\n'));
    expect(shop.state.log.find((l) => l.path.startsWith('/slots'))?.path).toBe('/slots?when=friday+evening');
    await core.assistant.call('list_slots', { when: '2026-10-30' });
    expect(shop.state.log.filter((l) => l.path.startsWith('/slots')).at(-1)?.path).toBe('/slots?date=2026-10-30');
  });

  it('books a listed slot, and the shop that follows is for that day', async () => {
    const { core, shop, tesco } = await setup();
    await expect(core.assistant.call('book_slot', { slot_id: 's17' })).rejects.toThrow('Larder doesn\'t know that slot. List the slots again (list_slots), then book one from that list.');
    await core.assistant.call('list_slots', { when: 'friday' });
    const b = await core.assistant.call('book_slot', { slot_id: 's17' });
    expect(b.text).toBe('Booked Friday 30 October, 17:00–18:00 at Tesco (ref TSC-1234). It\'s held until 11:00 on 2026-10-28 unless the order is checked out. Next: fill_basket.');
    expect(core.events.log.find((e) => e.type === 'online-shopping.slot_booked')?.data).toMatchObject({ shop: 'Tesco', reference: 'TSC-1234' });
    expect((await call<{ booking: { slotId: string } }>(core, 'GET', '/shops/:shopId/booking', undefined, { shopId: tesco.id })).booking.slotId).toBe('s17');
    expect((await core.assistant.call('start_shop', {})).text).toContain('A slot is already booked: Friday 30 October, 17:00–18:00 (ref TSC-1234).');

    // An offer that starts on the delivery day counts (10 in stock, up to 36: two 24-packs); the delivery is expected that day.
    shop.listing('1002', 'Andrex Toilet Tissue 24 Rolls', { amount: 24, unit: 'each' }, 9, { loyalty_price: 6, loyalty_price_valid: { from: '2026-10-30', until: null } });
    const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll', minQuantity: 4, stockUpTo: 12 });
    await core.stock.add({ productId: loo.id, quantity: 10 });
    await core.assistant.call('link_listing', { item: 'toilet roll', id_or_link: '1002' });
    await core.assistant.call('set_buying_rules', { item: 'toilet roll', target_price: 0.3, offer_stock_up_to: 36 });
    const filled = await core.assistant.call('fill_basket', {});
    expect(filled.text.split('\n')[0]).toBe('Added 1 item to your Tesco basket, about £12.00, for delivery Friday 30 October, 17:00–18:00:');
    expect(filled.text).toContain('Delivery slot booked: Friday 30 October, 17:00–18:00 (ref TSC-1234).');
    const entry = (await core.products.get(loo.id)).entries.find((e) => e.status === 'pending');
    // The basket's price goes with the order, for the purchase history when it arrives.
    expect(entry?.expected).toEqual({ source: 'Tesco delivery', reference: 'TSC-1234', eta: '2026-10-30', unitPrice: 0.25 });
  });

  it('books a slot from a day looked at before another (the app shows a few days)', async () => {
    const { core, shop, tesco } = await setup();
    const slots = (when: string) => core.modules.routes().find((r) => r.moduleId === 'online-shopping' && r.route.path === '/shops/:shopId/slots')!.route.handler({ body: undefined, query: { when }, params: { shopId: tesco.id }, userId: null });
    await slots('2026-10-30');
    const friday = shop.state.slots;
    shop.state.slots = [{ id: 's31', start: '2026-10-31T09:00:00+00:00', end: '2026-10-31T10:00:00+00:00', price: 0, available: true }];
    await slots('2026-10-31');
    shop.state.slots = [...friday, ...shop.state.slots];
    const r = await call<{ message: string }>(core, 'POST', '/shops/:shopId/book', { slotId: 's17' }, { shopId: tesco.id });
    expect(r.message).toMatch(/^Booked Friday 30 October, 17:00–18:00 at Tesco/);
  });

  it('passes on a slot that has gone, and a provider that can\'t book', async () => {
    const { core, shop } = await setup();
    await core.assistant.call('list_slots', { when: 'friday' });
    shop.state.slots[0]!.available = false;
    await expect(core.assistant.call('book_slot', { slot_id: 's17' })).rejects.toThrow('That slot has gone. List the slots again.');

    shop.state.capabilities = ['favourites'];
    const p = (await call<{ providers: Array<{ id: string }> }>(core, 'GET', '/providers')).providers[0]!;
    await call(core, 'POST', '/providers/:id/test', {}, { id: p.id });
    await expect(core.assistant.call('list_slots', { when: 'friday' })).rejects.toThrow('The Tesco provider can\'t book delivery slots. Book one on the shop\'s website.');
    expect((await core.assistant.call('start_shop', { when: 'friday' })).text).toContain('can\'t book slots, so book one on Tesco\'s website');
  });
});
