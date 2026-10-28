import { beforeEach, describe, expect, it } from 'vitest';
import { makeCore, category, type TestCore } from '../helpers';

describe('stock', () => {
  let core: TestCore;
  let fridge: string;
  let garage: string;
  let shed: string;
  let kitchen: string;

  beforeEach(async () => {
    core = await makeCore();
    kitchen = (await core.places.create({ name: 'Kitchen' })).id;
    fridge = (await core.places.create({ name: 'Fridge', parentId: kitchen })).id;
    garage = (await core.places.create({ name: 'Garage' })).id;
    shed = (await core.places.create({ name: 'Shed', code: 'S2-3' })).id;
  });

  it('adds stock with an expiry worked out from the shelf life', async () => {
    const milk = await core.products.create({ name: 'Milk', unit: 'bottle', shelfLifeDays: 7, defaultPlaceId: fridge });
    const s = await core.stock.add({ productId: milk.id, quantity: 2 });
    expect(s.inStock).toBe(2);
    expect(s.nextExpiry).toBe('2026-11-04');
    expect(s.daysToExpiry).toBe(7);
    expect(s.places[0]?.path).toBe('Kitchen › Fridge');
  });

  it('merges identical batches and keeps different expiries apart', async () => {
    const beans = await core.products.create({ name: 'Baked beans', unit: 'tin', defaultPlaceId: kitchen });
    await core.stock.add({ productId: beans.id, quantity: 2 });
    await core.stock.add({ productId: beans.id, quantity: 3 });
    await core.stock.add({ productId: beans.id, quantity: 1, expiresOn: '2027-01-01' });
    const d = await core.products.get(beans.id);
    expect(d.inStock).toBe(6);
    expect(d.entries).toHaveLength(2);
  });

  it('uses the soonest-expiring stock first and says when there is not enough', async () => {
    const yog = await core.products.create({ name: 'Yoghurt', unit: 'pot', defaultPlaceId: fridge });
    await core.stock.add({ productId: yog.id, quantity: 2, expiresOn: '2026-11-10' });
    await core.stock.add({ productId: yog.id, quantity: 2, expiresOn: '2026-10-30' });
    const s = await core.stock.use({ productId: yog.id, quantity: 3 });
    expect(s.inStock).toBe(1);
    expect(s.nextExpiry).toBe('2026-11-10');
    await expect(core.stock.use({ productId: yog.id, quantity: 5 })).rejects.toThrow('only 1 pot');
  });

  it('flags low stock, counting expected deliveries, and fires low/restocked events', async () => {
    const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll', minQuantity: 9 });
    await core.stock.add({ productId: loo.id, quantity: 10 });
    let s = await core.stock.use({ productId: loo.id, quantity: 6 });
    expect(s.status.low).toBe(true);
    expect(core.events.log.some((e) => e.type === 'stock.low')).toBe(true);
    s = await core.stock.expect({ productId: loo.id, quantity: 18, source: 'Tesco delivery', eta: '2026-10-29' });
    expect(s.status.low).toBe(false);
    expect(s.expected).toBe(18);
    expect(core.events.log.some((e) => e.type === 'stock.restocked')).toBe(true);
  });

  it('turns an expected delivery into real stock when it arrives', async () => {
    const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
    const beans = await core.products.create({ name: 'Beans', unit: 'tin', shelfLifeDays: 700 });
    await core.stock.expect({ productId: loo.id, quantity: 18, source: 'Tesco delivery' });
    await core.stock.expect({ productId: beans.id, quantity: 4, source: 'Tesco delivery' });
    await core.stock.expect({ productId: beans.id, quantity: 2, source: 'Aldi' });
    expect((await core.stock.deliveries()).map((d) => [d.source, d.itemCount])).toEqual([['Aldi', 1], ['Tesco delivery', 2]]);
    const r = await core.stock.arrive({ source: 'Tesco delivery' });
    expect(r.arrived).toBe(2);
    const b = await core.products.summary(beans.id);
    expect(b.inStock).toBe(4);
    expect(b.expected).toBe(2);
    expect(b.nextExpiry).toBe('2028-09-27'); // 700 days on, 2028 is a leap year
  });

  it('marks part of a delivery as arrived when scanning items', async () => {
    const tins = await core.products.create({ name: 'Tomatoes', unit: 'tin' });
    await core.stock.expect({ productId: tins.id, quantity: 4, source: 'Tesco delivery' });
    await core.stock.arrive({ productId: tins.id, quantity: 1 });
    const s = await core.products.summary(tins.id);
    expect([s.inStock, s.expected]).toEqual([1, 3]);
  });

  it('moves things out of place temporarily and back again', async () => {
    const drill = await core.products.create({ name: 'Cordless drill', defaultPlaceId: shed });
    await core.stock.add({ productId: drill.id, quantity: 1 });
    let s = await core.stock.move({ productId: drill.id, toPlaceId: kitchen });
    expect(s.status.outOfPlace).toBe(true);
    expect(s.places[0]?.name).toBe('Shed');
    expect(s.nowIn[0]?.name).toBe('Kitchen');
    const shedContents = await core.places.contents(shed);
    expect(shedContents.items[0]).toMatchObject({ outOfPlace: true, nowIn: { name: 'Kitchen' } });
    const kitchenContents = await core.places.contents(kitchen);
    expect(kitchenContents.visitors[0]?.usualPlace?.name).toBe('Shed');
    s = await core.stock.returnHome({ productId: drill.id });
    expect(s.status.outOfPlace).toBe(false);
  });

  it('moving something back to its usual place clears out-of-place', async () => {
    const drill = await core.products.create({ name: 'Drill', defaultPlaceId: shed });
    await core.stock.add({ productId: drill.id, quantity: 1 });
    await core.stock.move({ productId: drill.id, toPlaceId: kitchen });
    const s = await core.stock.move({ productId: drill.id, toPlaceId: shed });
    expect(s.status.outOfPlace).toBe(false);
  });

  it('moves part of a batch permanently to a new usual place', async () => {
    const tins = await core.products.create({ name: 'Paint', unit: 'tin', defaultPlaceId: garage });
    await core.stock.add({ productId: tins.id, quantity: 5 });
    const s = await core.stock.move({ productId: tins.id, toPlaceId: shed, quantity: 2, mode: 'permanent' });
    expect(s.status.outOfPlace).toBe(false);
    expect(s.places.map((p) => p.name)).toEqual(['Garage', 'Shed']);
    const d = await core.products.get(tins.id);
    expect(d.entries.map((e) => [e.place?.name, e.quantity])).toEqual(expect.arrayContaining([['Garage', 3], ['Shed', 2]]));
  });

  it('splits rechargeables into charged and flat', async () => {
    const aa = await core.products.create({ name: 'AA batteries', rechargeable: true, minQuantity: 8 });
    expect(aa.unit).toBe('battery');
    await core.stock.add({ productId: aa.id, quantity: 10 });
    let s = await core.stock.use({ productId: aa.id, quantity: 4 });
    expect([s.charged, s.flat, s.inStock]).toEqual([6, 4, 10]);
    expect(s.status.low).toBe(false);
    s = await core.stock.charge({ productId: aa.id, quantity: 3 });
    expect([s.charged, s.flat]).toEqual([9, 1]);
    await expect(core.stock.use({ productId: aa.id, quantity: 10 })).rejects.toThrow('charged');
  });

  it('clears the wish list and shopping list flags when stock is added', async () => {
    const bank = await core.products.create({ name: 'Power bank', wish: true });
    const s = await core.stock.add({ productId: bank.id, quantity: 1 });
    expect(s.product.wish).toBe(false);
    const p = await core.products.create({ name: 'Foil', onShoppingList: true });
    expect((await core.stock.add({ productId: p.id, quantity: 1 })).product.onShoppingList).toBe(false);
  });

  it('renews a renewal, restarting the clock', async () => {
    const renewals = await category(core, 'Renewals');
    const ins = await core.products.create({ name: 'House insurance', categoryId: renewals.id, shelfLifeDays: 365 });
    await core.stock.add({ productId: ins.id, quantity: 1, expiresOn: '2026-11-15' });
    let s = await core.products.summary(ins.id);
    expect(s.status.expiringSoon).toBe(true); // Renewals warn 30 days ahead
    s = await core.stock.renew(ins.id);
    expect([s.inStock, s.nextExpiry, s.status.expiringSoon]).toEqual([1, '2027-10-28', false]);
  });

  it('records history for every change', async () => {
    const p = await core.products.create({ name: 'Eggs', unit: 'egg' });
    await core.stock.add({ productId: p.id, quantity: 6 });
    await core.stock.use({ productId: p.id, quantity: 2 });
    const d = await core.products.get(p.id);
    expect(d.history.map((h) => [h.kind, h.quantity])).toEqual([['use', -2], ['add', 6]]);
  });

  it('edits and removes single batches', async () => {
    const p = await core.products.create({ name: 'Rice', unit: 'kg' });
    await core.stock.add({ productId: p.id, quantity: 2 });
    const [e] = (await core.products.get(p.id)).entries;
    let s = await core.stock.updateEntry(e!.id, { quantity: 1.5, expiresOn: '2027-03-01' });
    expect([s.inStock, s.nextExpiry]).toEqual([1.5, '2027-03-01']);
    s = await core.stock.removeEntry(e!.id);
    expect(s.inStock).toBe(0);
  });
});
