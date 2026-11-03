import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
import onlineShopping from './index';
import type { Run } from './shop';
import { fakeProvider } from './test-provider';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = <T = unknown>(core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'online-shopping' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params, userId: null }) as Promise<T>;

async function setup(env: Record<string, string> = {}) {
  const shop = fakeProvider();
  const core = await makeCore({ modules: [onlineShopping], fetch: shop.fetch, env: { LARDER_MODULE_ONLINE_SHOPPING_JOB_POLL_MS: '5', ...env } });
  const tesco = await core.shops.addPreset('Tesco');
  await call(core, 'POST', '/providers', { type: 'tesco', shopId: tesco.id, address: '192.168.1.231:8710', token: 'secret' });

  // The spec's loo roll: minimum 4, stock up to 12, 36 on offer, 3 in stock; 9 rolls £4.50, 24 rolls £9 (£7.50 Clubcard).
  shop.listing('1001', 'Tesco Soft Toilet Tissue 9 Rolls', { amount: 9, unit: 'each' }, 4.5);
  shop.listing('1002', 'Andrex Toilet Tissue 24 Rolls', { amount: 24, unit: 'each' }, 9, { loyalty_price: 7.5 });
  shop.listing('2001', 'Tesco Bananas Loose', { amount: 1, unit: 'each' }, 0.2, { available: false, error: 'out_of_stock' });
  shop.listing('3001', 'Oatly Barista 1L', { amount: 1, unit: 'l' }, 2.1);
  const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll', minQuantity: 4, stockUpTo: 12 });
  await core.stock.add({ productId: loo.id, quantity: 3 });
  await core.assistant.call('link_listing', { item: 'toilet roll', id_or_link: '1001' });
  await core.assistant.call('link_listing', { item: 'toilet roll', id_or_link: '1002' });
  await core.assistant.call('set_buying_rules', { item: 'toilet roll', target_price: 0.32, offer_stock_up_to: 36 });

  await core.products.create({ name: 'Bananas', unit: 'each', minQuantity: 5, preferredShopIds: [tesco.id] });
  await core.assistant.call('link_listing', { item: 'bananas', id_or_link: '2001' });
  await core.products.create({ name: 'Oat milk', unit: 'carton', minQuantity: 2, preferredShopIds: [tesco.id] });
  await core.assistant.call('link_listing', { item: 'oat milk', id_or_link: '3001', pack_quantity: 1 });
  shop.state.listings.get('3001')!.error = 'listing_dead';
  await core.products.create({ name: 'Fish fingers', unit: 'pack', minQuantity: 1, preferredShopIds: [tesco.id] });
  return { core, shop, tesco, loo };
}

describe('online shopping: planning and filling a basket', () => {
  it('plans without adding anything, and says what needs a look', async () => {
    const { core, shop } = await setup();
    const r = await core.assistant.call('plan_basket', {});
    expect(r.text).toBe([
      'Planned: 1 item at Tesco, about £12.00:',
      '- Toilet roll: 1 × Tesco Soft Toilet Tissue 9 Rolls + 1 × Andrex Toilet Tissue 24 Rolls = 33 rolls, £12.00; on offer at £0.313 a roll (target £0.32 a roll), up to 36 rolls',
      'On offer: Toilet roll.',
      'Unavailable: Bananas (out of stock).',
      'Gone from Tesco, link the new one: Oat milk (Oatly Barista 1L).',
      'Low but not linked to a Tesco product: Fish fingers.',
    ].join('\n'));
    expect(shop.state.basket.size).toBe(0);
    // Every candidate's listings, items in name order; Fish fingers has none and isn't asked about.
    expect(shop.state.log.find((l) => l.path === '/quote')?.body).toEqual({ listing_ids: ['2001', '3001', '1001', '1002'] });
    // The gone listing is marked for relinking on the item.
    const oat = await core.resolve.product('oat milk');
    const f = oat.fields['online-shopping'] as { shops: Record<string, { listings: Array<{ deadSince: string | null }> }> };
    expect(Object.values(f.shops)[0]!.listings[0]!.deadSince).toBe('2026-10-28T09:00:00.000Z');
  });

  it('fills the basket as a pending order, announces it, and doesn\'t buy it twice', async () => {
    const { core, shop, loo } = await setup();
    const r = await core.assistant.call('fill_basket', { shop: 'tesco' });
    expect(r.text.split('\n')[0]).toBe('Added 1 item to your Tesco basket, about £12.00:');
    expect(r.text).toContain('No delivery slot is booked yet.\nCheck the basket on Tesco\'s website and pay there. Until then it\'s a pending "Tesco delivery" order in Larder (not bought again, not on its way yet): confirm it once you\'ve checked out (the order email does too), or remove it if you don\'t go ahead.');
    expect([...shop.state.basket]).toEqual([['1001', 1], ['1002', 1]]);
    expect(await core.products.summary(loo.id)).toMatchObject({ inStock: 3, expected: 0, pending: 33 });
    expect(await core.stock.deliveries()).toEqual([]);
    expect((await core.stock.pendingOrders())[0]).toMatchObject({ source: 'Tesco delivery', itemCount: 1, quantity: 33 });
    const event = core.events.log.find((e) => e.type === 'online-shopping.basket_filled');
    expect(event?.data).toMatchObject({ shop: 'Tesco', items: 1, total: 12, relink: 1, pending_order: 'Tesco delivery' });

    // The pending order counts: the next plan doesn't buy it again.
    const again = await core.assistant.call('plan_basket', {});
    expect(again.text.split('\n')[0]).toBe('Nothing needs buying at Tesco right now.');

    // Checked out: confirmed, it's on its way.
    expect((await core.assistant.call('confirm_order', { source: 'Tesco delivery' })).text).toBe('Confirmed, on the way: Toilet roll.');
    expect(await core.products.summary(loo.id)).toMatchObject({ expected: 33, pending: 0 });
  });

  it('a pending order that didn\'t go ahead is removed, and bought next time', async () => {
    const { core, shop, loo } = await setup();
    await core.assistant.call('fill_basket', {});
    shop.state.basket.clear();
    expect((await core.assistant.call('cancel_order', { source: 'tesco delivery' })).text).toBe('Removed from the pending order: Toilet roll.');
    expect(await core.products.summary(loo.id)).toMatchObject({ inStock: 3, expected: 0, pending: 0 });
    expect((await core.assistant.call('plan_basket', {})).text.split('\n')[0]).toBe('Planned: 1 item at Tesco, about £12.00:');
  });

  it('the order email confirms the pending order rather than adding it again', async () => {
    const { core, loo } = await setup();
    await core.assistant.call('fill_basket', {});
    const r = await core.assistant.call('add_expected', { item: 'toilet roll', quantity: 33, source: 'Tesco', reference: 'TSC-998', eta: '2026-10-30' });
    expect(r.text).toBe('Toilet roll: 33 rolls in the pending order confirmed, now on the way.');
    const entries = (await core.products.get(loo.id)).entries.filter((e) => e.status !== 'in_stock');
    expect(entries.map((e) => [e.status, e.quantity, e.expected])).toEqual([['expected', 33, { source: 'Tesco delivery', reference: 'TSC-998', eta: '2026-10-30' }]]);
  });

  it('only buys what belongs on that shop\'s list, and says which linked items are bought elsewhere', async () => {
    const { core, shop } = await setup();
    const aldi = await core.shops.addPreset('Aldi');
    shop.listing('5001', 'Tesco Free Range Eggs 6 Pack', { amount: 6, unit: 'each' }, 1.9);
    const eggs = await core.products.create({ name: 'Eggs', unit: 'egg', minQuantity: 6 });
    await core.assistant.call('link_listing', { item: 'eggs', id_or_link: '5001' });
    await core.products.update(eggs.id, { preferredShopIds: [aldi.id] });
    const r = await core.assistant.call('plan_basket', {});
    expect(r.text).not.toContain('- Eggs');
    expect(r.text).toContain('Low and linked at Tesco, but bought elsewhere (add Tesco to its shops to buy it here): Eggs (Aldi).');
  });

  it('buys things put on the list by hand, once', async () => {
    const { core, shop } = await setup();
    shop.listing('6001', 'Tesco Kitchen Roll 2 Rolls', { amount: 2, unit: 'each' }, 1.5);
    const roll = await core.products.create({ name: 'Kitchen roll', unit: 'roll', minQuantity: 1, stockUpTo: 4 });
    await core.stock.add({ productId: roll.id, quantity: 3 });
    await core.assistant.call('link_listing', { item: 'kitchen roll', id_or_link: '6001' });
    await core.products.setOnList(roll.id, true);
    const filled = await core.assistant.call('fill_basket', {});
    expect(filled.text).toContain('- Kitchen roll: 1 × Tesco Kitchen Roll 2 Rolls = 2 rolls, £1.50; on the list by hand');
    expect((await core.products.summary(roll.id)).product.onShoppingList).toBe(false);
    expect((await core.assistant.call('plan_basket', {})).text.split('\n')[0]).toBe('Nothing needs buying at Tesco right now.');
  });

  it('stops and says so when the shop needs the person to log in', async () => {
    const { core, shop } = await setup();
    shop.state.loggedIn = false;
    const r = await core.assistant.call('fill_basket', {});
    expect(r.text).toBe('The shop at Tesco stopped: Log in to Tesco again in the Larder Chrome.');
    expect(core.events.log.find((e) => e.type === 'online-shopping.failed')?.data).toMatchObject({ shop: 'Tesco', code: 'login_expired', needs_you: true });
  });

  it('answers "still working" when it takes a while, and one shop at a time', async () => {
    const { core, shop } = await setup({ LARDER_MODULE_ONLINE_SHOPPING_TOOL_WAIT_MS: '0' });
    shop.state.delayMs = 10;
    const first = await core.assistant.call('fill_basket', {});
    expect(first.text).toMatch(/^Still working at Tesco: .* \(started just now\)\. Ask again in a minute with shop_status \(job_id .+\)\.$/);
    const second = await core.assistant.call('plan_basket', {});
    expect(second.text).toMatch(/^A shop is already running at Tesco: /);
    const id = (first.data as { job_id: string }).job_id;
    await new Promise((res) => setTimeout(res, 300));
    const done = await core.assistant.call('shop_status', { job_id: id });
    expect(done.text.split('\n')[0]).toBe('Added 1 item to your Tesco basket, about £12.00:');
    expect((await call<{ run: Run }>(core, 'GET', '/shops/:shopId/latest', undefined, { shopId: (await core.resolve.shop('tesco')).id })).run.id).toBe(id);
  });

  it('keeps the multibuy allowance as a household setting', async () => {
    const { core } = await setup();
    expect(await call(core, 'GET', '/options')).toEqual({ multibuyOverPercent: 25 });
    expect(await call(core, 'PUT', '/options', { multibuyOverPercent: 50 })).toEqual({ multibuyOverPercent: 50 });
  });
});
