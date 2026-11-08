import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../../src/adapters/storage-memory';
import { makeCore, saveAs092 } from '../../tests/helpers';
import purchases, { type PurchaseRecord, type SpendingReport } from './index';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = (core: Core, method: string, path: string, { body, query = {}, params = {} }: { body?: unknown; query?: Record<string, string>; params?: Record<string, string> } = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'purchases' && r.route.method === method && r.route.path === path)!.route.handler({ body, query, params, userId: null });
/** Purchases are recorded from events, which are handled just after the change. */
const settle = () => new Promise((r) => setTimeout(r, 20));
const history = async (core: Core, productId: string) => (await call(core, 'GET', '/item/:productId', { params: { productId } })) as PurchaseRecord[];

async function setup() {
  const core = await makeCore({ modules: [purchases] });
  const aldi = await core.shops.create({ name: 'Aldi' });
  const tesco = await core.shops.create({ name: 'Tesco' });
  const butter = await core.products.create({ name: 'Butter', unit: 'pack' });
  const oats = await core.products.create({ name: 'Oat milk', unit: 'carton' });
  return { core, aldi, tesco, butter, oats };
}

describe('purchase history', () => {
  it('keeps what was ticked off at a shop, and a receipt with its photo and date', async () => {
    const { core, aldi, butter } = await setup();
    await core.shopping.purchase({ shopId: aldi.id, items: [{ productId: butter.id, quantity: 2, price: 3.2 }] });
    await settle();
    expect(await history(core, butter.id)).toEqual([
      expect.objectContaining({ name: 'Butter', quantity: 2, unit: 'pack', price: 3.2, currency: 'GBP', shopId: aldi.id, shop: 'Aldi', how: 'shop', on: '2026-10-28' }),
    ]);

    await core.shopping.purchase({ shopId: aldi.id, items: [{ productId: butter.id, quantity: 1 }], evidence: { source: 'Receipt', receiptFileId: 'photo-1', boughtOn: '2026-10-26', note: 'Read by Claude' } });
    await settle();
    const [, receipt] = await history(core, butter.id);
    expect(receipt).toMatchObject({ how: 'receipt', on: '2026-10-26', price: null, evidence: { receiptFileId: 'photo-1', source: 'Receipt', note: 'Read by Claude' } });
    // Stock came in as usual.
    expect((await core.products.summary(butter.id)).inStock).toBe(3);
  });

  it('keeps online orders when they arrive, with the order and its price', async () => {
    const { core, tesco, oats } = await setup();
    await core.stock.expect({ productId: oats.id, quantity: 6, source: 'Tesco delivery', reference: 'TESCO-1', eta: '2026-10-30', price: 9 });
    core.clock.set('2026-10-30T09:00:00.000Z');
    // Part of it first, then the rest: each with its share of the price.
    await core.stock.arrive({ productId: oats.id, quantity: 2 });
    await core.stock.arrive({ source: 'Tesco delivery' });
    await settle();
    const rows = (await history(core, oats.id)).sort((a, b) => a.quantity - b.quantity);
    expect(rows.map((r) => [r.quantity, r.price, r.shop, r.how, r.on])).toEqual([[2, 3, 'Tesco', 'order', '2026-10-30'], [4, 6, 'Tesco', 'order', '2026-10-30']]);
    expect(rows[0]!.evidence).toMatchObject({ source: 'Tesco delivery', reference: 'TESCO-1', orderedOn: '2026-10-28' });
    expect(rows[0]!.shopId).toBe(tesco.id);
  });

  it('keeps an order\'s price when a pending basket is confirmed by the order email', async () => {
    const { core, oats } = await setup();
    await core.stock.expect({ productId: oats.id, quantity: 3, source: 'Tesco delivery', pending: true });
    await core.stock.expect({ productId: oats.id, quantity: 3, source: 'Tesco delivery', reference: 'TESCO-2', price: 4.5 });
    await core.stock.arrive({ source: 'Tesco delivery' });
    await settle();
    expect((await history(core, oats.id)).map((r) => [r.quantity, r.price, r.evidence.reference])).toEqual([[3, 4.5, 'TESCO-2']]);
  });

  it('reports spending by shop, item and month, and can be corrected', async () => {
    const { core, aldi, tesco, butter, oats } = await setup();
    await core.shopping.purchase({ shopId: aldi.id, items: [{ productId: butter.id, quantity: 2, price: 3.2 }, { productId: oats.id, quantity: 1 }] });
    core.clock.set('2026-11-03T09:00:00.000Z');
    await core.shopping.purchase({ shopId: tesco.id, items: [{ productId: butter.id, quantity: 1, price: 1.75 }, { productId: oats.id, quantity: 2, price: 3 }] });
    await settle();
    const r = (await call(core, 'GET', '/report')) as SpendingReport;
    expect([r.total, r.count, r.unpriced]).toEqual([7.95, 4, 1]);
    expect(r.byShop).toEqual([{ shop: 'Aldi', total: 3.2, count: 2 }, { shop: 'Tesco', total: 4.75, count: 2 }].sort((a, b) => b.total - a.total));
    expect(r.byItem.map((x) => [x.name, x.quantity, x.total])).toEqual([['Butter', 3, 4.95], ['Oat milk', 3, 3]]);
    expect(r.byMonth).toEqual([{ month: '2026-10', total: 3.2, count: 2 }, { month: '2026-11', total: 4.75, count: 2 }]);
    expect(((await call(core, 'GET', '/report', { query: { from: '2026-11-01' } })) as SpendingReport).total).toBe(4.75);

    // The oat milk was £1.40, and the receipt's photo turned up later.
    const oatsBought = (await history(core, oats.id)).find((x) => x.shop === 'Aldi')!;
    const fixed = (await call(core, 'PATCH', '/:id', { params: { id: oatsBought.id }, body: { price: 1.4, evidence: { receiptFileId: 'photo-2' } } })) as PurchaseRecord;
    expect([fixed.price, fixed.how, fixed.evidence.receiptFileId]).toEqual([1.4, 'shop', 'photo-2']);
    expect(((await call(core, 'GET', '/report')) as SpendingReport).unpriced).toBe(0);
    await call(core, 'DELETE', '/:id', { params: { id: oatsBought.id } });
    expect(await history(core, oats.id)).toHaveLength(1);
    // Stock isn't touched.
    expect((await core.products.summary(oats.id)).inStock).toBe(3);

    const sensor = await core.automation.read();
    expect(sensor.purchases_this_month).toMatchObject({ state: 4.75, attributes: { purchases: 2, shops: { Tesco: 4.75 } } });
  });

  it('follows an item the upgrade turns round, from tea bags into boxes', async () => {
    const storage = createMemoryStorage();
    const before = await makeCore({ modules: [purchases], storage });
    const tea = await before.products.create({ name: 'Sleep tea', unit: 'tea bag' });
    await before.shopping.purchase({ items: [{ productId: tea.id, quantity: 40, price: 6 }] });
    await settle();
    // Saved by 0.9.2 as counted in tea bags, in boxes of 20: 0.10.0 buys it in boxes, each containing 20 tea bags.
    await saveAs092(storage, (await before.products.summary(tea.id)).product, { unit: 'tea bag', pack: { name: 'box', holds: 20 } });
    const core = await makeCore({ modules: [purchases], storage });
    await settle();
    expect((await history(core, tea.id)).map((r) => [r.quantity, r.unit, r.price])).toEqual([[2, 'box', 6]]);
    // Corrected: it was 3 boxes.
    await core.assistant.call('change_purchase', { item: 'sleep tea', quantity: 3 });
    expect((await history(core, tea.id)).map((r) => r.quantity)).toEqual([3]);
  });

  it('answers assistants', async () => {
    const { core, aldi, tesco, butter, oats } = await setup();
    await core.shopping.purchase({ shopId: aldi.id, items: [{ productId: butter.id, quantity: 2, price: 3.2 }] });
    await core.stock.expect({ productId: oats.id, quantity: 2, source: 'Tesco delivery', reference: 'T-9', price: 3 });
    core.clock.set('2026-11-03T09:00:00.000Z');
    await core.stock.arrive({ source: 'Tesco delivery' });
    await core.shopping.purchase({ shopId: tesco.id, items: [{ productId: butter.id, quantity: 1, price: 1.75 }], evidence: { source: 'Receipt', receiptFileId: 'p' } });
    await settle();

    expect((await core.assistant.call('purchase_history', { item: 'butter' })).text).toBe([
      '- 2026-11-03: 1 pack, £1.75 at Tesco (receipt photo)',
      '- 2026-10-28: 2 packs, £3.20 at Aldi',
      'In all: £4.95 on 2 purchases.',
    ].join('\n'));
    expect((await core.assistant.call('purchase_history', { shop: 'tesco' })).text).toContain('2 cartons of Oat milk, £3.00 at Tesco (order T-9, ordered 2026-10-28)');
    expect((await core.assistant.call('spending', {})).text).toBe(['£4.75 on 2 purchases between 2026-11-01 and 2026-11-03.', 'Most spent on: Oat milk £3.00, Butter £1.75.'].join('\n'));
    expect((await core.assistant.call('spending', { from: '2026-10-01' })).text).toContain('By shop: Tesco £4.75, Aldi £3.20.');

    expect((await core.assistant.call('change_purchase', { item: 'butter', on: '2026-10-28', price: 3 })).text).toBe('Changed: 2026-10-28: 2 packs of Butter, £3.00 at Aldi.');
    expect((await core.assistant.call('remove_purchase', { item: 'butter' })).text).toBe('Removed from the history: 2026-11-03: 1 pack of Butter, £1.75 at Tesco (receipt photo).');
    await expect(core.assistant.call('change_purchase', { item: 'butter', on: '2026-01-01', price: 1 })).rejects.toThrow('There\'s no purchase of Butter on 2026-01-01 in the history.');
  });
});
