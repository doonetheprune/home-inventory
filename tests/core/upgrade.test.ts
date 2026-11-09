/**
 * Items saved by older versions, brought up to date when Larder starts
 * (products.upgradeStored, through the Storage port, after the modules start).
 */
import { describe, expect, it } from 'vitest';
import { defineModule, type LarderEvent, type Movement, type Product, type StockEntry } from '@larder/core';
import { createMemoryStorage } from '../../src/adapters/storage-memory';
import { makeCore, category } from '../helpers';

const at = '2026-10-20T09:00:00.000Z';
/** A record as 0.9.2 saved it: a pack, no pack size, Weight or needsCheck. */
const old = (p: Product, extra: Record<string, unknown>) => {
  const { packSize: _c, weight: _w, needsCheck: _n, ...rest } = p;
  return { ...rest, pack: null, ...extra } as unknown as Product;
};
const entry = (productId: string, quantity: number, extra: Partial<StockEntry> = {}): StockEntry => ({
  id: `${productId}-${quantity}-${extra.status ?? 'in_stock'}`, productId, variantId: null, quantity, placeId: null, currentPlaceId: null, movedAt: null, expiresOn: null, addedAt: at,
  status: 'in_stock', expected: null, charge: null, ...extra,
});
const moved = (productId: string, quantity: number): Movement => ({ id: `${productId}-m${quantity}`, productId, entryId: null, kind: 'add', quantity, fromPlaceId: null, toPlaceId: null, note: '', userId: null, at });

/** A module that listens for rescales, as pricing, purchases and the rest do. */
const heard: LarderEvent[] = [];
const listener = defineModule({ id: 'listener', name: 'Listener', version: '1.0.0', description: 'Hears rescales at start-up.', setup(ctx) { ctx.on('product.recounted', (e) => void heard.push(e)); } });

describe('items saved by 0.9.0 and before', () => {
  it('turns "each one lasts N days" into a usage, with a minimum that warns as early as before', async () => {
    const storage = createMemoryStorage();
    const first = await makeCore({ storage });
    const medicine = await category(first, 'Medicine');
    const made = await first.products.create({ name: 'Glucose sensor', unit: 'sensor', minQuantity: 1 });
    const lens = await first.products.create({ name: 'Contact lenses', unit: 'pair', categoryId: medicine.id });
    const plain = await first.products.create({ name: 'Toilet roll', unit: 'roll' });
    await storage.products.put(old(made, { usage: null, lastsDays: 14, autoUse: true, inUseSince: '2026-10-20' }));
    await storage.products.put(old(lens, { usage: null, lastsDays: 30, autoUse: false }));
    const { pack: _p, usage: _u, ...bare } = old(plain, {}) as Product & { pack?: unknown };
    await storage.products.put(bare as Product);

    const core = await makeCore({ storage });
    const sensor = await core.products.summary(made.id);
    // Warned 7 days ahead before: 1 left (14 days) kept it from low, so the minimum stays 1.
    expect([sensor.product.usage, sensor.product.minQuantity, sensor.product.inUseSince, sensor.inUseUntil]).toEqual([{ amount: 1, everyDays: 14, auto: true, unit: null }, 1, '2026-10-20', '2026-11-03']);
    // Medicine warns 30 days ahead: one 30-day pair left was low, so it's low below 2.
    const lenses = await core.products.summary(lens.id);
    expect([lenses.product.usage, lenses.product.minQuantity]).toEqual([{ amount: 1, everyDays: 30, auto: false, unit: null }, 2]);
    const stored = await storage.products.get(made.id);
    expect(stored && ('lastsDays' in stored || 'autoUse' in stored)).toBe(false);
    // Older records with no usage at all read as none.
    const roll = await core.products.summary(plain.id);
    expect([roll.product.usage, roll.product.packSize, roll.product.needsCheck, roll.runsOutOn]).toEqual([null, null, null, null]);
    expect(await core.products.upgradeStored()).toBe(0);
  });
});

describe('items saved by 0.9.2 (Counted in and Comes in)', () => {
  async function upgraded(records: (core: Awaited<ReturnType<typeof makeCore>>) => Promise<{ products: Product[]; entries?: StockEntry[]; movements?: Movement[] }>) {
    const storage = createMemoryStorage();
    const first = await makeCore({ storage });
    const r = await records(first);
    for (const p of r.products) await storage.products.put(p);
    await storage.applyStockChanges({ put: r.entries ?? [], movements: r.movements ?? [] });
    heard.length = 0;
    const core = await makeCore({ storage, modules: [listener] });
    return { core, storage };
  }

  it('turns kg into g and L into ml, with stock, orders, minimum, stock-up amount, usage and history', async () => {
    let peas = '';
    let oil = '';
    const { core, storage } = await upgraded(async (c) => {
      const p = await c.products.create({ name: 'Frozen peas', unit: 'bag' });
      const o = await c.products.create({ name: 'Heating oil', unit: 'bag' });
      peas = p.id;
      oil = o.id;
      return {
        products: [old(p, { unit: 'kg', minQuantity: 0.5, stockUpTo: 2, usage: { amount: 0.1, everyDays: 7, auto: false, unit: null } }), old(o, { unit: 'L', minQuantity: 300 })],
        entries: [entry(p.id, 1.6), entry(p.id, 1, { status: 'expected', expected: { source: 'Tesco', reference: null, eta: null, unitPrice: 5 } }), entry(o.id, 620)],
        movements: [moved(p.id, 1.6), moved(o.id, 620)],
      };
    });
    const s = await core.products.get(peas);
    expect([s.product.unit, s.product.minQuantity, s.product.stockUpTo, s.product.usage, s.product.needsCheck]).toEqual(['g', 500, 2000, { amount: 100, everyDays: 7, auto: false, unit: null }, null]);
    expect([s.inStock, s.expected]).toEqual([1600, 1000]);
    // A price per kg is a price per g now.
    expect(s.entries.find((e) => e.status === 'expected')?.expected?.unitPrice).toBe(0.005);
    expect(s.history.map((m) => [m.kind, m.quantity, m.note])).toEqual([['adjust', 0, 'Now counted in g'], ['add', 1600, '']]);
    const o = await core.products.get(oil);
    expect([o.product.unit, o.product.minQuantity, o.inStock, o.history.at(-1)?.quantity]).toEqual(['ml', 300000, 620000, 620000]);
    expect(heard.map((e) => e.data)).toEqual([
      { productId: peas, name: 'Frozen peas', from: 'kg', to: 'g', factor: 1000 },
      { productId: oil, name: 'Heating oil', from: 'L', to: 'ml', factor: 1000 },
    ]);
    // Running it again changes nothing.
    expect(await core.products.upgradeStored()).toBe(0);
    expect((await storage.stock.listByProduct(peas)).map((e) => e.quantity).sort()).toEqual([1000, 1600]);
  });

  it('turns a pack round: tea bags in boxes of 20 are bought in boxes of 20 tea bags', async () => {
    let sleep = '';
    const { core } = await upgraded(async (c) => {
      const p = await c.products.create({ name: 'Twinings Sleep', unit: 'tea bag' });
      sleep = p.id;
      return {
        products: [old(p, { pack: { name: 'box', holds: 20 }, minQuantity: 28, stockUpTo: 60, usage: { amount: 1, everyDays: 1, auto: true, unit: null }, inUseSince: '2026-10-27', size: { amount: 1.5, unit: 'g' } })],
        entries: [entry(p.id, 80), entry(p.id, 20, { status: 'pending', expected: { source: 'Tesco', reference: null, eta: null, unitPrice: 0.05 } })],
        movements: [moved(p.id, 80)],
      };
    });
    const s = await core.products.get(sleep);
    expect([s.product.unit, s.product.packSize, s.product.weight, s.product.minQuantity, s.product.stockUpTo, s.product.usage]).toEqual([
      'box', { amount: 20, unit: 'tea bag' }, { amount: 30, unit: 'g' }, 1.4, 3, { amount: 1, everyDays: 1, auto: true, unit: 'tea bag' }]);
    expect([s.inStock, s.pending]).toEqual([4, 1]);
    expect(s.entries.find((e) => e.status === 'pending')?.expected?.unitPrice).toBe(1);
    expect(s.product.needsCheck).toBe('Now counted in boxes of 20 tea bags. If you count them one by one instead, change Bought in and correct the count.');
    expect(s.history.map((m) => [m.kind, m.quantity, m.note])).toEqual([['adjust', 0, 'Now bought in boxes of 20 tea bags'], ['add', 4, '']]);
    expect((await core.adapters.storage.products.get(sleep) as Record<string, unknown>).pack ?? null).toBeNull();
    expect(heard.map((e) => e.data)).toEqual([{ productId: sleep, name: 'Twinings Sleep', from: 'tea bag', to: 'box', factor: 0.05 }]);
    expect((await core.products.list({ status: 'to_tidy' })).map((x) => x.product.name)).toContain('Twinings Sleep');
    expect(await core.products.upgradeStored()).toBe(0);
    expect((await core.products.summary(sleep)).inStock).toBe(4);
  });

  it('counts a pack of things counted one by one in pieces, and flags units that are not on the list', async () => {
    const ids: Record<string, string> = {};
    const { core } = await upgraded(async (c) => {
      const make = async (name: string, extra: Record<string, unknown>) => {
        const p = await c.products.create({ name, unit: 'each' });
        ids[name] = p.id;
        return old(p, extra);
      };
      return {
        products: [
          await make('Pens', { unit: 'each', pack: { name: 'pack', holds: 5 } }),
          await make('Whole milk', { unit: '4 pint bottle' }),
          await make('Cups', { unit: 'Cups', pack: { name: 'sleeve', holds: 50 } }),
          await make('Loo roll', { unit: 'Rolls' }),
          await make('Dishwasher tabs', { unit: 'tabs' }),
          await make('Crisps', { unit: 'pkt' }),
          await make('Bananas', { unit: '' }),
        ],
        entries: [entry('x', 1)],
      };
    });
    const get = async (name: string) => (await core.products.summary(ids[name]!)).product;
    expect(await get('Pens')).toMatchObject({ unit: 'pack', packSize: { amount: 5, unit: 'piece' }, needsCheck: 'Now counted in packs of 5 pieces. If you count them one by one instead, change Bought in and correct the count.' });
    expect(await get('Whole milk')).toMatchObject({ unit: '4 pint bottle', packSize: null, needsCheck: '"4 pint bottle" isn\'t on the unit list. Pick what it\'s bought in, and its pack size.' });
    expect(await get('Cups')).toMatchObject({ unit: 'sleeve', packSize: { amount: 50, unit: 'cups' }, needsCheck: '"sleeve" isn\'t on the unit list. Pick what it\'s bought in, and its pack size.' });
    expect((await Promise.all(['Loo roll', 'Dishwasher tabs', 'Crisps', 'Bananas'].map(get))).map((p) => [p.unit, p.needsCheck])).toEqual([['roll', null], ['tablet', null], ['packet', null], ['each', null]]);
    // Flagged items still work.
    expect((await core.stock.add({ productId: ids['Whole milk']!, quantity: 2 })).inStock).toBe(2);
    expect(await core.products.upgradeStored()).toBe(0);
  });
});
