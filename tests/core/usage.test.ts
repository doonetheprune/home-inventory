/**
 * How fast things are used ("we use 1 tea bag a day", "1 sensor every 14
 * days"), the pack they come in ("a box of 80"), Larder taking them out of
 * stock by itself, counting what's inside a box, and opened-not-finished.
 */
import { describe, expect, it } from 'vitest';
import type { Product } from '@larder/core';
import { createMemoryStorage } from '../../src/adapters/storage-memory';
import { makeCore, category } from '../helpers';

const tea = { name: 'Tea bags', unit: 'tea bag', pack: { name: 'box', holds: 20 } };

describe('how fast things are used', () => {
  it('works out when they run out: 3 sensors used one every 2 weeks last 6 weeks', async () => {
    const core = await makeCore();
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', usage: { amount: 1, everyDays: 14, auto: false } });
    await core.stock.add({ productId: sensor.id, quantity: 3 });
    let s = await core.products.summary(sensor.id);
    expect([s.inUse, s.inUseUntil, s.runsOutOn, s.daysToRunOut, s.status.low]).toEqual([false, null, '2026-12-09', 42, false]);

    // Larder doesn't take them out, so Use starts one today; it's out of stock but lasts its 14 days.
    s = await core.stock.use({ productId: sensor.id, quantity: 1 });
    expect(s.product.inUseSince).toBe('2026-10-28');
    expect([s.inStock, s.inUse, s.inUseUntil, s.runsOutOn]).toEqual([2, true, '2026-11-11', '2026-12-09']);
    expect((await core.products.get(sensor.id)).history[0]).toMatchObject({ kind: 'use', quantity: -1 });

    core.clock.set('2026-11-02T09:00:00.000Z');
    s = await core.products.summary(sensor.id);
    expect([s.inUseUntil, s.runsOutOn, s.daysToRunOut]).toEqual(['2026-11-11', '2026-12-09', 37]);

    // Its days are up and the next wasn't started: the 2 left count from today.
    core.clock.set('2026-11-15T09:00:00.000Z');
    s = await core.products.summary(sensor.id);
    expect([s.inUse, s.inUseUntil, s.runsOutOn]).toEqual([false, null, '2026-12-13']);

    // Started on a different day than it was recorded: the date can be changed.
    await core.products.update(sensor.id, { inUseSince: '2026-11-12' });
    s = await core.products.summary(sensor.id);
    expect([s.inUseUntil, s.runsOutOn]).toEqual(['2026-11-26', '2026-12-24']);

    // Several a day, or fractions: 20 tea bags at 3 a day last 6 whole days.
    const bags = await core.products.create({ ...tea, usage: { amount: 3, everyDays: 1, auto: false } });
    s = await core.stock.add({ productId: bags.id, quantity: 20 });
    expect([s.runsOutOn, s.daysToRunOut]).toEqual(['2026-11-21', 6]);
  });

  it('is low only below its minimum, counting what is on order, however soon it runs out', async () => {
    const core = await makeCore();
    const boots = await core.shops.create({ name: 'Boots' });
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', usage: { amount: 1, everyDays: 14, auto: false }, minQuantity: 1, preferredShopIds: [boots.id], stockUpTo: 3 });
    await core.stock.add({ productId: sensor.id, quantity: 1 });
    let s = await core.stock.use({ productId: sensor.id, quantity: 1 });
    // The last one is in use: low (below 1 left) and on the list, but not out while it has days left.
    expect([s.inStock, s.inUse, s.status.low, s.status.runningOut]).toEqual([0, true, true, false]);
    const reasons = async () => (await core.shopping.forShop(boots.id)).groups.flatMap((g) => g.items).map((i) => [i.summary.product.name, i.quantity, i.reason]);
    expect(await reasons()).toEqual([['Glucose sensor', 3, 'low']]);

    // Its days are up with none left: out.
    core.clock.set('2026-11-11T09:00:00.000Z');
    expect(await reasons()).toEqual([['Glucose sensor', 3, 'out']]);

    // Two on the way: not low, so not bought twice.
    s = await core.stock.expect({ productId: sensor.id, quantity: 2, source: 'Boots' });
    expect(s.status.low).toBe(false);

    // No minimum, no warning: running out soon alone doesn't make it low any more.
    const lenses = await core.products.create({ name: 'Contact lenses', unit: 'pair', usage: { amount: 1, everyDays: 30, auto: false }, categoryId: (await category(core, 'Medicine')).id });
    s = await core.stock.add({ productId: lenses.id, quantity: 1 });
    expect([s.daysToRunOut, s.status.low]).toEqual([30, false]);
  });

  it('leaves everything else alone', async () => {
    const core = await makeCore();
    const rolls = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
    await core.stock.add({ productId: rolls.id, quantity: 4 });
    let s = await core.stock.use({ productId: rolls.id, quantity: 1 });
    expect([s.product.inUseSince, s.inUse, s.inUseUntil, s.runsOutOn, s.daysToRunOut]).toEqual([null, false, null, null, null]);
    expect(core.events.log.filter((e) => e.type === 'product.updated')).toEqual([]);
    expect((await core.automation.checkExpiry()).taken).toBe(0);

    // Wanted, not owned: nothing runs out or is taken out.
    const wish = await core.products.create({ name: 'Spare sensor', usage: { amount: 1, everyDays: 14, auto: true }, wish: true });
    core.clock.set('2026-11-28T09:00:00.000Z');
    s = await core.products.summary(wish.id);
    expect([s.runsOutOn, s.status.low]).toEqual([null, false]);
    expect((await core.automation.checkExpiry()).taken).toBe(0);
  });
});

describe('Larder taking them out by itself', () => {
  it('takes the amount out each period, catches up after time off, and stops at none', async () => {
    const core = await makeCore();
    const aldi = await core.shops.create({ name: 'Aldi' });
    // Switched on, it counts from today: today's is already out, so the next goes tomorrow.
    const bags = await core.products.create({ ...tea, usage: { amount: 1, everyDays: 1, auto: true }, minQuantity: 7, preferredShopIds: [aldi.id] });
    expect(bags.inUseSince).toBe('2026-10-28');
    let s = await core.stock.add({ productId: bags.id, quantity: 1, unit: 'box' });
    expect([s.inStock, s.inUse, s.inUseUntil, s.runsOutOn]).toEqual([20, true, '2026-10-29', '2026-11-18']);
    expect((await core.automation.checkExpiry()).taken).toBe(0);

    // After midnight (UK time) the next is taken, once however often it checks.
    core.clock.set('2026-10-29T00:30:00.000Z');
    const both = await Promise.all([core.automation.checkExpiry(), core.automation.checkExpiry()]);
    expect(both.map((r) => r.taken).sort()).toEqual([0, 1]);
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.product.inUseSince, s.runsOutOn]).toEqual([19, '2026-10-29', '2026-11-18']);
    expect((await core.products.get(bags.id)).history[0]).toMatchObject({ kind: 'use', quantity: -1, note: 'Taken by Larder' });
    expect(core.events.log.filter((e) => e.type === 'stock.changed').at(-1)?.data).toMatchObject({ name: 'Tea bags', kind: 'use', inStock: 19 });

    // Larder was off for 10 days: it catches up, and is low (below a week's worth).
    core.clock.set('2026-11-08T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(10);
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.product.inUseSince, s.status.low]).toEqual([9, '2026-11-08', false]);
    core.clock.set('2026-11-11T09:00:00.000Z');
    await core.automation.checkExpiry();
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.status.low]).toEqual([6, true]);

    // It stops at none, and is out once today's has gone.
    core.clock.set('2026-12-01T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(6);
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.product.inUseSince, s.inUse]).toEqual([0, '2026-11-17', false]);
    const list = (await core.shopping.forShop(aldi.id)).groups.flatMap((g) => g.items);
    // The list buys whole boxes: 7 tea bags is 1 box.
    expect(list.map((i) => [i.summary.product.name, i.reason, i.quantity, i.packs])).toEqual([['Tea bags', 'out', 20, 1]]);

    // A box bought later starts the day it's added: nothing is taken for the days with none.
    core.clock.set('2026-12-03T18:00:00.000Z');
    await core.stock.add({ productId: bags.id, quantity: 1, unit: 'box' });
    expect((await core.automation.checkExpiry()).taken).toBe(1);
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.product.inUseSince, s.inUseUntil]).toEqual([19, '2026-12-03', '2026-12-04']);
  });

  it('takes a part of what is left, and many periods at once without running away', async () => {
    const core = await makeCore();
    const pills = await core.products.create({ name: 'Dog wormer', unit: 'tablet', usage: { amount: 2, everyDays: 30, auto: true } });
    await core.stock.add({ productId: pills.id, quantity: 3 });
    core.clock.set('2026-12-01T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(1);
    core.clock.set('2027-01-01T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(1);
    const s = await core.products.summary(pills.id);
    expect([s.inStock, s.product.inUseSince]).toEqual([0, '2026-12-27']);
    expect((await core.products.get(pills.id)).history.slice(0, 2).map((m) => m.quantity)).toEqual([-1, -2]);
  });

  it('counts Use as an extra, and opened as a new one started now', async () => {
    const core = await makeCore();
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', usage: { amount: 1, everyDays: 14, auto: true } });
    await core.stock.add({ productId: sensor.id, quantity: 4 });

    // A spare used (one dropped): it's an extra, and the one in use carries on.
    core.clock.set('2026-11-02T09:00:00.000Z');
    let s = await core.stock.use({ productId: sensor.id, quantity: 1 });
    expect([s.inStock, s.product.inUseSince, s.inUseUntil]).toEqual([3, '2026-10-28', '2026-11-11']);

    // It came off early: the next is started now, and Larder counts from today.
    s = await core.stock.use({ productId: sensor.id, quantity: 1, open: true });
    expect([s.inStock, s.product.inUseSince, s.inUseUntil, s.runsOutOn]).toEqual([2, '2026-11-02', '2026-11-16', '2026-12-14']);
    expect((await core.products.get(sensor.id)).history[0]).toMatchObject({ kind: 'use', note: 'Started' });
    core.clock.set('2026-11-11T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(0);
    core.clock.set('2026-11-16T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(1);

    // Stopped: nothing is in use, so nothing is taken until one is started.
    s = await core.stock.finish(sensor.id);
    expect([s.inUse, s.product.inUseSince, s.inUseUntil, s.runsOutOn]).toEqual([false, null, null, '2026-11-30']);
    core.clock.set('2026-12-20T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(0);
    await expect(core.stock.finish(sensor.id)).rejects.toThrow("There's no glucose sensor open or in use.");
  });

  it('switched on later, counts from today unless the one in use still has days left', async () => {
    const core = await makeCore();
    // Used by pressing Use, one started each time: the last on 28 Oct.
    const bags = await core.products.create({ ...tea, usage: { amount: 1, everyDays: 1, auto: false } });
    await core.stock.add({ productId: bags.id, quantity: 20 });
    await core.stock.use({ productId: bags.id, quantity: 1 });
    core.clock.set('2026-11-07T09:00:00.000Z');
    // Ten days later Larder takes them out: from today, not catching up on days already Used.
    let p = await core.products.update(bags.id, { usage: { amount: 1, everyDays: 1, auto: true } });
    expect(p.inUseSince).toBe('2026-11-07');
    core.clock.set('2026-11-08T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(1);
    expect((await core.products.summary(bags.id)).inStock).toBe(18);

    // A sensor started 4 days ago carries on: its 14 days were taken out when it was started.
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', usage: { amount: 1, everyDays: 14, auto: false } });
    await core.stock.add({ productId: sensor.id, quantity: 3 });
    await core.stock.use({ productId: sensor.id, quantity: 1 });
    core.clock.set('2026-11-12T09:00:00.000Z');
    p = await core.products.update(sensor.id, { usage: { amount: 1, everyDays: 14, auto: true } });
    expect(p.inUseSince).toBe('2026-11-08');

    // Its usage cleared: nothing's in use, or open.
    p = await core.products.update(sensor.id, { usage: null });
    expect(p.inUseSince).toBeNull();
  });

  it('with none started, Use starts one, and from Home Assistant takes the usual amount', async () => {
    const core = await makeCore();
    const lenses = await core.products.create({ name: 'Contact lenses', unit: 'lens', usage: { amount: 2, everyDays: 14, auto: true } });
    await core.stock.add({ productId: lenses.id, quantity: 8 });
    // A new pair started early: both lenses come out, and Larder counts from today.
    core.clock.set('2026-11-02T09:00:00.000Z');
    let r = await core.automation.run('use_stock', { item: 'contact lenses', opened: true });
    expect(r.message).toBe('Contact lenses: started a new one now (2 lenses). 6 lenses left, enough until 2026-12-28.');
    // Stopped, then started again with a plain Use.
    await core.automation.run('finish_item', { item: 'contact lenses' });
    r = await core.automation.run('use_stock', { item: 'contact lenses' });
    expect(r.message).toBe('Contact lenses: started 2 lenses, and Larder takes them out from here (2 lenses every 2 weeks). 4 lenses left, enough until 2026-12-14.');
    expect((await core.products.summary(lenses.id)).product.inUseSince).toBe('2026-11-02');
    // Started now, a Use is an extra one.
    r = await core.automation.run('use_stock', { item: 'contact lenses' });
    expect(r.message).toBe('Contact lenses: used 1 lens extra (Larder also takes out 2 lenses every 2 weeks). 3 lenses left, enough until 2026-12-07.');
  });

  it('never takes out renewals or rechargeables', async () => {
    const core = await makeCore();
    const renewals = await category(core, 'Renewals');
    const cover = await core.products.create({ name: 'Boiler cover', categoryId: renewals.id, usage: { amount: 1, everyDays: 1, auto: true } });
    const aa = await core.products.create({ name: 'AA', rechargeable: true, usage: { amount: 1, everyDays: 1, auto: true } });
    await core.stock.add({ productId: cover.id, quantity: 2 });
    await core.stock.add({ productId: aa.id, quantity: 2 });
    core.clock.set('2026-11-05T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(0);
  });
});

describe('the pack it comes in', () => {
  it('adds, uses and orders in boxes or in what is inside, and says which it needs', async () => {
    const core = await makeCore();
    const bags = await core.products.create(tea);
    let s = await core.stock.add({ productId: bags.id, quantity: 2, unit: 'boxes' });
    expect(s.inStock).toBe(40);
    s = await core.stock.use({ productId: bags.id, quantity: 3, unit: 'Tea bags' });
    expect(s.inStock).toBe(37);
    s = await core.stock.use({ productId: bags.id, quantity: 0.5, unit: 'box' });
    expect(s.inStock).toBe(27);
    s = await core.stock.expect({ productId: bags.id, quantity: 1, unit: 'box', source: 'Tesco' });
    expect(s.expected).toBe(20);
    await expect(core.stock.add({ productId: bags.id, quantity: 1, unit: 'kg' })).rejects.toThrow('Tea bags is counted in tea bags and comes in boxes of 20. Give how many tea bags or boxes.');

    // With no pack, only its own unit.
    const rolls = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
    await expect(core.stock.add({ productId: rolls.id, quantity: 1, unit: 'box' })).rejects.toThrow('Toilet roll is counted in rolls. Give how many rolls.');
    const pens = await core.products.create({ name: 'Pens' });
    expect((await core.stock.add({ productId: pens.id, quantity: 2, unit: 'each' })).inStock).toBe(2);
  });

  it("can't be what it's counted in", async () => {
    const core = await makeCore();
    await expect(core.products.create({ name: 'Tea', unit: 'box', pack: { name: 'boxes', holds: 20 } })).rejects.toThrow("A box can't come in boxes. Count what's inside (tea bags, say) and say how many a box holds.");
    // Said in the plural, it's kept in the singular.
    expect((await core.products.create({ name: 'Tea', unit: 'tea bag', pack: { name: 'Boxes', holds: 20 } })).pack).toEqual({ name: 'box', holds: 20 });
  });

  it('buys whole packs: the list rounds up, keeping the stock-up amount in what is inside', async () => {
    const core = await makeCore();
    const aldi = await core.shops.create({ name: 'Aldi' });
    const bags = await core.products.create({ ...tea, minQuantity: 10, stockUpTo: 50, preferredShopIds: [aldi.id] });
    await core.stock.add({ productId: bags.id, quantity: 8 });
    const [item] = (await core.shopping.forShop(aldi.id)).groups.flatMap((g) => g.items);
    // 42 more to get to 50 is 3 boxes (60).
    expect([item!.reason, item!.quantity, item!.packs]).toEqual(['low', 60, 3]);
    const rolls = await core.products.create({ name: 'Toilet roll', unit: 'roll', minQuantity: 4, preferredShopIds: [aldi.id] });
    const list = (await core.shopping.forShop(aldi.id)).groups.flatMap((g) => g.items);
    expect(list.find((i) => i.summary.product.id === rolls.id)?.packs).toBeNull();
  });
});

describe('counting what is inside', () => {
  it('turns boxes into tea bags: stock, orders, minimum, stock-up amount and usage', async () => {
    const core = await makeCore();
    const sleep = await core.products.create({ name: 'Sleep tea', unit: 'box', minQuantity: 1, stockUpTo: 3, usage: { amount: 1, everyDays: 20, auto: false } });
    await core.stock.add({ productId: sleep.id, quantity: 2 });
    await core.stock.expect({ productId: sleep.id, quantity: 1, source: 'Tesco', price: 3 });

    let s = await core.stock.recount(sleep.id, { unit: 'tea bag', holds: 20 });
    expect([s.product.unit, s.product.pack, s.inStock, s.expected, s.product.minQuantity, s.product.stockUpTo, s.product.usage]).toEqual(['tea bag', { name: 'box', holds: 20 }, 40, 20, 20, 60, { amount: 20, everyDays: 20, auto: false }]);
    const detail = await core.products.get(sleep.id);
    expect(detail.entries.find((e) => e.status === 'expected')?.expected?.unitPrice).toBe(0.15);
    expect(detail.history[0]).toMatchObject({ kind: 'adjust', quantity: 0, note: 'Now counted in tea bags (1 box = 20)' });
    expect(core.events.log.find((e) => e.type === 'product.recounted')?.data).toEqual({ productId: sleep.id, name: 'Sleep tea', from: 'box', to: 'tea bag', factor: 20 });
    // The run-out date doesn't move: it's the same tea (2 boxes at 1 every 20 days).
    expect(s.runsOutOn).toBe('2026-12-07');

    await expect(core.stock.recount(sleep.id, { unit: 'tea bags', holds: 20 })).rejects.toThrow('Sleep tea is already counted in tea bags.');
    // What it comes in can't be what it's counted in.
    const cups = await core.products.create({ name: 'Paper cups' });
    await expect(core.stock.recount(cups.id, { unit: 'sleeve', holds: 50, pack: 'sleeves' })).rejects.toThrow("A sleeve can't come in sleeves.");
    // Said in the plural, it's counted in one, keeping its capitals.
    expect((await core.stock.recount(cups.id, { unit: 'Cups', holds: 50, pack: 'sleeve' })).product.unit).toBe('Cup');
    const pens = await core.products.create({ name: 'Pens' });
    await expect(core.stock.recount(pens.id, { unit: 'pen', holds: 10 })).rejects.toThrow('Say what one of the pens counted so far is (a box?), so it can become the pack.');
    s = await core.stock.recount(pens.id, { unit: 'pen', holds: 10, pack: 'pack' });
    expect(s.product.pack).toEqual({ name: 'pack', holds: 10 });
  });
});

describe('items saved by older versions', () => {
  it('turns "each one lasts N days" into a usage, with a minimum that warns as early as before', async () => {
    const storage = createMemoryStorage();
    const first = await makeCore({ storage });
    const medicine = await category(first, 'Medicine');
    const made = await first.products.create({ name: 'Glucose sensor', unit: 'sensor', minQuantity: 1 });
    const lens = await first.products.create({ name: 'Contact lenses', unit: 'pair', categoryId: medicine.id });
    const plain = await first.products.create({ name: 'Toilet roll' });
    const { pack: _p, usage: _u, ...bare } = plain;
    await storage.products.put({ ...made, usage: null, lastsDays: 14, autoUse: true, inUseSince: '2026-10-20' } as Product);
    await storage.products.put({ ...lens, usage: null, lastsDays: 30, autoUse: false } as Product);
    await storage.products.put(bare as Product);

    const core = await makeCore({ storage });
    const sensor = await core.products.summary(made.id);
    // Warned 7 days ahead before: 1 left (14 days) kept it from low, so the minimum stays 1.
    expect([sensor.product.usage, sensor.product.minQuantity, sensor.product.inUseSince, sensor.inUseUntil]).toEqual([{ amount: 1, everyDays: 14, auto: true }, 1, '2026-10-20', '2026-11-03']);
    // Medicine warns 30 days ahead: one 30-day pair left was low, so it's low below 2.
    const lenses = await core.products.summary(lens.id);
    expect([lenses.product.usage, lenses.product.minQuantity]).toEqual([{ amount: 1, everyDays: 30, auto: false }, 2]);
    const stored = await storage.products.get(made.id);
    expect(stored && ('lastsDays' in stored || 'autoUse' in stored)).toBe(false);
    // Older records with no pack or usage at all read as none.
    const roll = await core.products.summary(plain.id);
    expect([roll.product.pack, roll.product.usage, roll.runsOutOn]).toEqual([null, null, null]);

    // Run again, nothing changes.
    expect(await core.products.upgradeStored()).toBe(0);
  });
});

describe('Home Assistant and assistants', () => {
  it('say how fast things are used, take extras, and change the usage, pack and count', async () => {
    const core = await makeCore();
    await core.products.create({ ...tea, pack: { name: 'box', holds: 80 }, usage: { amount: 2, everyDays: 1, auto: true }, minQuantity: 14 });
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', usage: { amount: 1, everyDays: 14, auto: false } });
    await core.automation.run('add_stock', { item: 'tea bags', quantity: 1, unit: 'box' });
    await core.stock.add({ productId: sensor.id, quantity: 3 });

    const extra = await core.automation.run('use_stock', { item: 'tea bags' });
    expect(extra.message).toBe('Tea bags: used 1 tea bag extra (Larder also takes out 2 tea bags a day). 79 tea bags left, enough until 2026-12-07.');
    const started = await core.automation.run('use_stock', { item: 'glucose sensor' });
    expect(started.message).toBe('Glucose sensor: started 1 sensor. 2 sensors left, enough until 2026-12-09.');
    expect(started.runs_out_on).toBe('2026-12-09');

    let item = (await core.assistant.call('get_item', { item: 'tea bags' })).text;
    expect(item).toContain('79 tea bags (about 1 box)');
    expect(item).toContain('Comes in boxes of 80.');
    expect(item).toContain('Uses 2 tea bags a day, taken out of stock by Larder. Enough until 2026-12-07 (in 40 days).');
    expect(item).toContain('Running low below 14 tea bags (a week\'s worth).');
    item = (await core.assistant.call('get_item', { item: 'glucose sensor' })).text;
    expect(item).toContain('Uses 1 sensor every 2 weeks. One in use since 2026-10-28, until 2026-11-11 (in 14 days). Enough until 2026-12-09 (in 42 days).');
    expect((await core.assistant.call('search', { query: 'glucose' })).text).toContain('enough until 2026-12-09 (in 42 days)');

    const changed = await core.assistant.call('change_item', { item: 'glucose sensor', uses: { amount: 1, every_days: 10 }, takes_out_automatically: true, in_use_since: '2026-10-25' });
    expect(changed.text).toBe('Glucose sensor is updated: uses 1 sensor every 10 days, taken out of stock by Larder, the current one started on 2026-10-25, enough until 2026-11-24.');
    expect((await core.products.summary(sensor.id)).product.usage).toEqual({ amount: 1, everyDays: 10, auto: true });

    await core.assistant.call('add_item', { name: 'Sleep tea', unit: 'box', uses: { amount: 1, every_days: 20 } });
    await core.automation.run('add_stock', { item: 'sleep tea', quantity: 2 });
    await expect(core.assistant.call('change_item', { item: 'sleep tea', unit: 'tea bag', recount: true })).rejects.toThrow('A recount needs the new unit and what it comes in');
    const recounted = await core.assistant.call('change_item', { item: 'sleep tea', unit: 'tea bags', comes_in: { name: 'box', holds: 20 }, recount: true });
    expect(recounted.text).toBe('Sleep tea is updated: now counted in tea bags, 40 tea bags in stock (1 box = 20), enough until 2026-12-07.');
    expect((await core.products.list()).find((x) => x.product.name === 'Sleep tea')?.product.usage).toEqual({ amount: 20, everyDays: 20, auto: false });
    const comesIn = await core.assistant.call('change_item', { item: 'sleep tea', comes_in: { name: 'tin', holds: 40 } });
    expect(comesIn.text).toBe('Sleep tea is updated: comes in tins of 40.');
    const stopped = await core.assistant.call('change_item', { item: 'sleep tea', uses: null });
    expect(stopped.text).toBe('Sleep tea is updated: no usage set.');
  });
});

describe('opened, not finished', () => {
  it('marks one open, is the last one open rather than out, and finishes it', async () => {
    const core = await makeCore();
    const aldi = await core.shops.create({ name: 'Aldi' });
    const butter = await core.products.create({ name: 'Butter', unit: 'pack', minQuantity: 1, preferredShopIds: [aldi.id] });
    await core.stock.add({ productId: butter.id, quantity: 2 });
    let s = await core.stock.use({ productId: butter.id, quantity: 1, open: true });
    expect([s.inStock, s.inUse, s.product.inUseSince, s.status.low]).toEqual([1, true, '2026-10-28', false]);
    expect((await core.products.get(butter.id)).history[0]).toMatchObject({ kind: 'use', note: 'Opened' });

    // Opening the last one: low and on the list, but not out while one is open.
    core.clock.set('2026-11-02T09:00:00.000Z');
    s = await core.stock.use({ productId: butter.id, quantity: 1, open: true });
    expect([s.inStock, s.inUse, s.product.inUseSince, s.status.low]).toEqual([0, true, '2026-11-02', true]);
    const reasons = async () => (await core.shopping.forShop(aldi.id)).groups.flatMap((g) => g.items).map((i) => [i.summary.product.name, i.reason]);
    expect(await reasons()).toEqual([['Butter', 'low']]);

    // Finished: none open, so it's out.
    s = await core.stock.finish(butter.id);
    expect([s.inUse, s.product.inUseSince]).toEqual([false, null]);
    expect(await reasons()).toEqual([['Butter', 'out']]);
    expect((await core.products.get(butter.id)).history[0]).toMatchObject({ kind: 'finish', quantity: 0 });
    await expect(core.stock.finish(butter.id)).rejects.toThrow("There's no butter open.");

    // Used without saying it was opened: nothing is open.
    const cream = await core.products.create({ name: 'Cream', minQuantity: 1, preferredShopIds: [aldi.id] });
    await core.stock.add({ productId: cream.id, quantity: 1 });
    s = await core.stock.use({ productId: cream.id, quantity: 1 });
    expect([s.inUse, s.product.inUseSince]).toEqual([false, null]);
  });

  it('works from Home Assistant and assistants', async () => {
    const core = await makeCore();
    const coffee = await core.products.create({ name: 'Ground coffee', unit: 'bag', minQuantity: 1 });
    await core.stock.add({ productId: coffee.id, quantity: 1 });
    const opened = await core.automation.run('use_stock', { item: 'ground coffee', opened: true });
    expect(opened.message).toBe('Ground coffee: opened 1 bag. 0 bags left, running low.');
    expect(opened.open).toBe(true);
    expect((await core.assistant.call('get_item', { item: 'ground coffee' })).text).toContain('One open since 2026-10-28 (today), not counted in stock: it is the last one.');
    expect((await core.assistant.call('search', { query: 'coffee' })).text).toContain('one open since 2026-10-28');
    const done = await core.assistant.call('finish_item', { item: 'ground coffee' });
    expect(done.text).toBe('Ground coffee: the open one is finished. 0 bags left, running low.');
  });
});
