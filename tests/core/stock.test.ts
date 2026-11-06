import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../../src/adapters/storage-memory';
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

  it('applies changes made at the same time one after another, so none is lost', async () => {
    const roll = await core.products.create({ name: 'Toilet roll', unit: 'roll', defaultPlaceId: kitchen });
    await core.stock.add({ productId: roll.id, quantity: 5 });
    await Promise.all([core.stock.use({ productId: roll.id, quantity: 1 }), core.stock.use({ productId: roll.id, quantity: 1 }), core.stock.add({ productId: roll.id, quantity: 2 })]);
    expect((await core.products.summary(roll.id)).inStock).toBe(5);
    // Product updates too: neither field is lost.
    await Promise.all([core.products.update(roll.id, { fields: { a: 1 } }), core.products.update(roll.id, { fields: { b: 2 } }), core.stock.use({ productId: roll.id, quantity: 1 })]);
    const p = (await core.products.summary(roll.id)).product;
    expect(p.fields).toMatchObject({ a: 1, b: 2 });
    // A failed change doesn't hold up the next.
    await expect(core.stock.use({ productId: roll.id, quantity: 99 })).rejects.toThrow();
    expect((await core.stock.use({ productId: roll.id, quantity: 1 })).inStock).toBe(3);
  });

  it('says when something is already where it is being moved to', async () => {
    const drill = await core.products.create({ name: 'Cordless drill', defaultPlaceId: shed });
    await core.stock.add({ productId: drill.id, quantity: 1 });
    await core.stock.move({ productId: drill.id, toPlaceId: kitchen, mode: 'temporary' });
    await expect(core.stock.move({ productId: drill.id, toPlaceId: kitchen, mode: 'temporary' })).rejects.toThrow('Cordless drill is already in Kitchen.');
    const empty = await core.products.create({ name: 'Head torch' });
    await expect(core.stock.move({ productId: empty.id, toPlaceId: kitchen, mode: 'temporary' })).rejects.toThrow("There's no head torch to move.");
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

  describe('pending orders', () => {
    it('count towards stock and the shopping list, but are not on the way until confirmed', async () => {
      const tesco = await core.shops.addPreset('Tesco');
      const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll', minQuantity: 9, stockUpTo: 12, preferredShopIds: [tesco.id] });
      await core.stock.add({ productId: loo.id, quantity: 2 });
      const s = await core.stock.expect({ productId: loo.id, quantity: 9, source: 'Tesco delivery', pending: true });
      expect(s).toMatchObject({ inStock: 2, expected: 0, pending: 9, status: { low: false, hasExpected: false } });
      expect((await core.shopping.forShop(tesco.id)).count).toBe(0);
      expect(await core.stock.deliveries()).toEqual([]);
      expect(await core.stock.pendingOrders()).toEqual([{ source: 'Tesco delivery', eta: null, itemCount: 1, quantity: 9, since: '2026-10-28T09:00:00.000Z' }]);
      expect((await core.home.dashboard()).pendingOrders).toHaveLength(1);

      const r = await core.stock.confirmOrders({ source: 'tesco delivery' });
      expect(r.confirmed).toBe(1);
      expect(r.products[0]).toMatchObject({ expected: 9, pending: 0 });
      expect(await core.stock.pendingOrders()).toEqual([]);
    });

    it('can be removed when they did not go ahead, and things are low again', async () => {
      const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll', minQuantity: 9 });
      await core.stock.expect({ productId: loo.id, quantity: 9, source: 'Tesco delivery', pending: true });
      const r = await core.stock.cancelOrders({ productId: loo.id });
      expect(r.products[0]).toMatchObject({ pending: 0, status: { low: true } });
      await expect(core.stock.cancelOrders({ source: 'Tesco delivery' })).rejects.toThrow('Nothing from Tesco delivery is waiting to be confirmed.');
    });

    it('an order email for the same shop confirms what is pending rather than adding it again', async () => {
      const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
      await core.stock.expect({ productId: loo.id, quantity: 9, source: 'Tesco delivery', pending: true });
      // Only 6 went ahead, plus 3 more added on the website; and an Aldi order doesn't touch it.
      await core.stock.expect({ productId: loo.id, quantity: 2, source: 'Aldi' });
      const s = await core.stock.expect({ productId: loo.id, quantity: 6, source: 'Tesco order', reference: 'T-1', eta: '2026-10-30' });
      expect(s).toMatchObject({ expected: 8, pending: 3 });
      const d = await core.products.get(loo.id);
      expect(d.entries.map((e) => [e.status, e.quantity, e.expected?.source, e.expected?.reference]).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
        ['expected', 2, 'Aldi', null], ['expected', 6, 'Tesco delivery', 'T-1'], ['pending', 3, 'Tesco delivery', null],
      ]);
    });

    it('arrive with a delivery: all of it if nothing was confirmed, else only what was', async () => {
      const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
      const beans = await core.products.create({ name: 'Beans', unit: 'tin' });
      await core.stock.expect({ productId: loo.id, quantity: 9, source: 'Tesco delivery', pending: true });
      await core.stock.expect({ productId: beans.id, quantity: 4, source: 'Tesco delivery', pending: true });
      expect(await core.stock.arrive({ source: 'Tesco delivery' })).toMatchObject({ arrived: 2, pendingLeft: 0 });

      await core.stock.expect({ productId: loo.id, quantity: 9, source: 'Tesco delivery', pending: true });
      await core.stock.expect({ productId: beans.id, quantity: 4, source: 'Tesco delivery', pending: true });
      await core.stock.confirmOrders({ productId: beans.id });
      const r = await core.stock.arrive({ source: 'Tesco delivery' });
      expect(r).toMatchObject({ arrived: 1, pendingLeft: 1 });
      expect(await core.products.summary(loo.id)).toMatchObject({ inStock: 9, pending: 9 });
      // Scanning it in: it's here, so it was ordered.
      await core.stock.arrive({ productId: loo.id, quantity: 9 });
      expect(await core.products.summary(loo.id)).toMatchObject({ inStock: 18, pending: 0 });
    });
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

  it('arrives only what was due by a date, so a later order from the same shop stays on the way', async () => {
    const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
    const beans = await core.products.create({ name: 'Beans', unit: 'tin' });
    await core.stock.expect({ productId: loo.id, quantity: 9, source: 'Tesco delivery', eta: '2026-11-06' });
    await core.stock.expect({ productId: beans.id, quantity: 4, source: 'Tesco delivery', eta: '2026-11-13' });
    expect((await core.stock.arrive({ source: 'Tesco delivery', dueBy: '2026-11-06' })).arrived).toBe(1);
    expect((await core.products.summary(loo.id)).inStock).toBe(9);
    expect((await core.products.summary(beans.id)).expected).toBe(4);
    await expect(core.stock.arrive({ source: 'Tesco delivery', dueBy: '2026-11-06' })).rejects.toThrow('Nothing is expected from Tesco delivery.');
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

  it('lets flat batteries be used once a product stops being rechargeable', async () => {
    const aa = await core.products.create({ name: 'AA batteries', rechargeable: true });
    await core.stock.add({ productId: aa.id, quantity: 4 });
    await core.stock.use({ productId: aa.id, quantity: 3 });
    await core.products.update(aa.id, { rechargeable: false });
    const s = await core.stock.use({ productId: aa.id, quantity: 4 });
    expect(s.inStock).toBe(0);
  });

  it('renewing records what it replaced and keeps the count', async () => {
    const filters = await core.products.create({ name: 'Water filter', shelfLifeDays: 60 });
    await core.stock.add({ productId: filters.id, quantity: 2, expiresOn: '2026-11-01' });
    const s = await core.stock.renew(filters.id);
    expect([s.inStock, s.nextExpiry]).toEqual([2, '2026-12-27']);
    const kinds = (await core.products.get(filters.id)).history.map((h) => [h.kind, h.quantity]);
    expect(kinds).toEqual(expect.arrayContaining([['remove', -2], ['add', 2]]));
  });

  it('keeps separate orders from the same shop apart', async () => {
    const ink = await core.products.create({ name: 'Printer ink', unit: 'cartridge' });
    await core.stock.expect({ productId: ink.id, quantity: 2, source: 'Amazon', reference: 'ORDER-1', eta: '2026-11-02' });
    await core.stock.expect({ productId: ink.id, quantity: 3, source: 'Amazon', reference: 'ORDER-2', eta: '2026-11-02' });
    const refs = (await core.products.get(ink.id)).entries.map((e) => e.expected?.reference).sort();
    expect(refs).toEqual(['ORDER-1', 'ORDER-2']);
  });

  it('asks which product when only part of a delivery has arrived', async () => {
    const beans = await core.products.create({ name: 'Beans', unit: 'tin' });
    const rice = await core.products.create({ name: 'Rice', unit: 'kg' });
    await core.stock.expect({ productId: beans.id, quantity: 4, source: 'Tesco' });
    await core.stock.expect({ productId: rice.id, quantity: 3, source: 'Tesco' });
    await expect(core.stock.arrive({ source: 'Tesco', quantity: 1 })).rejects.toThrow('which product');
    expect((await core.products.summary(beans.id)).expected).toBe(4);
  });
});

describe('to tidy', () => {
  it('lists owned items with stock that has no place, or no type, for tidying after a quick scan', async () => {
    const core = await makeCore();
    const food = await category(core, 'Food');
    const shelf = await core.places.create({ name: 'Pantry' });
    const tidy = await core.products.create({ name: 'Tidy beans', categoryId: food.id });
    await core.stock.add({ productId: tidy.id, quantity: 2, placeId: shelf.id });
    const noPlace = await core.products.create({ name: 'Scanned soup', categoryId: food.id });
    await core.stock.add({ productId: noPlace.id, quantity: 1 });
    const noType = await core.products.create({ name: 'Mystery jar' });
    await core.products.create({ name: 'Wanted lamp', wish: true });

    const names = (await core.products.list({ status: 'to_tidy' })).map((s) => s.product.name);
    expect(names).toEqual(['Mystery jar', 'Scanned soup']);
    // Putting it somewhere tidies it.
    await core.products.update(noType.id, { categoryId: food.id });
    const entry = (await core.products.get(noPlace.id)).entries[0]!;
    await core.stock.updateEntry(entry.id, { placeId: shelf.id });
    expect(await core.products.list({ status: 'to_tidy' })).toEqual([]);
  });
});

describe('places an item is kept in', () => {
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
    shed = (await core.places.create({ name: 'Shed' })).id;
  });

  it('keeps an item in each place it has been, at 0 once it runs out there, until it is taken off', async () => {
    const pesto = await core.products.create({ name: 'Green pesto', unit: 'jar' });
    await core.stock.add({ productId: pesto.id, quantity: 1, placeId: kitchen });
    await core.stock.add({ productId: pesto.id, quantity: 1, placeId: garage });
    const counts = async () => (await core.products.summary(pesto.id)).stockByPlace.map((x) => [x.name, x.quantity]);
    expect(await counts()).toEqual([['Garage', 1], ['Kitchen', 1]]);

    // Running out in the garage leaves it there at 0, and on the garage's page.
    await core.stock.use({ productId: pesto.id, quantity: 1, placeId: garage });
    expect(await counts()).toEqual([['Kitchen', 1], ['Garage', 0]]);
    expect((await core.places.contents(garage)).items.map((i) => [i.summary.product.name, i.quantity])).toEqual([['Green pesto', 0]]);

    // More can go back; a temporary move doesn't make the shed one of its places.
    await core.stock.add({ productId: pesto.id, quantity: 2, placeId: garage });
    await core.stock.move({ productId: pesto.id, toPlaceId: shed, fromPlaceId: kitchen, mode: 'temporary' });
    expect(await counts()).toEqual([['Garage', 2], ['Kitchen', 1]]);

    // Moved somewhere else for good: the kitchen is left behind.
    await core.stock.returnHome({ productId: pesto.id });
    await core.stock.move({ productId: pesto.id, toPlaceId: fridge, fromPlaceId: kitchen, mode: 'permanent' });
    expect(await counts()).toEqual([['Garage', 2], ['Fridge', 1]]);

    // Taken off by hand at 0, and when a place is removed.
    await core.stock.use({ productId: pesto.id, quantity: 1, placeId: fridge });
    const kept = (await core.products.summary(pesto.id)).product.keptInPlaceIds;
    await core.products.update(pesto.id, { keptInPlaceIds: kept.filter((x) => x !== fridge) });
    expect(await counts()).toEqual([['Garage', 2]]);
    await core.stock.use({ productId: pesto.id, quantity: 2, placeId: garage });
    await core.places.remove(garage);
    expect(await counts()).toEqual([]);
    expect((await core.products.summary(pesto.id)).product.keptInPlaceIds).toEqual([]);
  });

  it('reads items saved before kept places existed', async () => {
    const storage = createMemoryStorage();
    core = await makeCore({ storage });
    kitchen = (await core.places.create({ name: 'Kitchen' })).id;
    const p = await core.products.create({ name: 'Old jam', unit: 'jar' });
    const { keptInPlaceIds: _, ...old } = (await storage.products.get(p.id))!;
    await storage.products.put(old as typeof p);
    await core.stock.add({ productId: p.id, quantity: 1, placeId: kitchen });
    expect((await core.products.summary(p.id)).stockByPlace.map((x) => x.name)).toEqual(['Kitchen']);
  });

  it('tells assistants and Home Assistant how many are in each place', async () => {
    const pesto = await core.products.create({ name: 'Green pesto', unit: 'jar' });
    await core.stock.add({ productId: pesto.id, quantity: 1, placeId: kitchen });
    expect((await core.automation.run('find_item', { item: 'green pesto' })).message).toBe('Green pesto: 1 jar in stock. In Kitchen.');
    await core.stock.add({ productId: pesto.id, quantity: 2, placeId: garage });
    await core.stock.add({ productId: pesto.id, quantity: 1, placeId: shed });
    await core.stock.use({ productId: pesto.id, quantity: 1, placeId: shed });
    expect((await core.automation.run('find_item', { item: 'green pesto' })).message).toBe('Green pesto: 3 jars in stock. 2 jars in Garage, 1 jar in Kitchen and none in Shed.');
    expect((await core.assistant.call('search', { query: 'pesto' })).text).toContain('Green pesto: 3 jars, 2 jars in Garage, 1 jar in Kitchen and none in Shed');
    const item = await core.assistant.call('get_item', { item: 'green pesto' });
    expect(item.text).toContain('2 jars in Garage, 1 jar in Kitchen and none in Shed.');
    expect(item.data?.places).toEqual([{ place: 'Garage', quantity: 2 }, { place: 'Kitchen', quantity: 1 }, { place: 'Shed', quantity: 0 }]);
  });
});
