/**
 * How fast things are used ("we use 1 tea bag a day", "1 sensor every 14
 * days"), the pack they come in ("a box of 80"), Larder taking them out of
 * stock by itself, counting what's inside a box, and opened-not-finished.
 */
import { describe, expect, it } from 'vitest';
import { ASSISTANT_INSTRUCTIONS } from '@larder/core';
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
    expect([s.product.unit, s.product.pack, s.inStock, s.expected, s.product.minQuantity, s.product.stockUpTo, s.product.usage]).toEqual(['tea bag', { name: 'box', holds: 20 }, 40, 20, 20, 60, { amount: 20, everyDays: 20, auto: false, unit: null }]);
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
    expect(item).toContain('Uses 1 sensor every 2 weeks. One in use since 2026-10-28, until 2026-11-11 (in 14 days), not counted in stock. Enough until 2026-12-09 (in 42 days).');
    expect((await core.assistant.call('search', { query: 'glucose' })).text).toContain('enough until 2026-12-09 (in 42 days)');

    const changed = await core.assistant.call('change_item', { item: 'glucose sensor', uses: { amount: 1, every_days: 10 }, takes_out_automatically: true, in_use_since: '2026-10-25' });
    expect(changed.text).toBe('Glucose sensor is updated: uses 1 sensor every 10 days, taken out of stock by Larder, the current one started on 2026-10-25, enough until 2026-11-24.');
    expect((await core.products.summary(sensor.id)).product.usage).toEqual({ amount: 1, everyDays: 10, auto: true, unit: null });
    // Set up before 0.9.0 with a shelf life standing in for how long one lasts: the answer says so.
    const libre = await core.products.create({ name: 'Libre 3', unit: 'sensor', shelfLifeDays: 14 });
    const told = await core.assistant.call('change_item', { item: 'libre 3', uses: { amount: 1, every_days: 14 } });
    expect(told.text).toContain('It also has a shelf life of 14 days, so new stock gets an expiry date that far ahead; if that was meant as how long one lasts once started, clear it (shelf_life_days: null).');
    expect((await core.assistant.call('change_item', { item: 'libre 3', uses: { amount: 1, every_days: 14 }, shelf_life_days: null })).text).not.toContain('shelf life');
    expect((await core.products.summary(libre.id)).product.shelfLifeDays).toBeNull();

    await core.assistant.call('add_item', { name: 'Sleep tea', unit: 'box', uses: { amount: 1, every_days: 20 } });
    await core.automation.run('add_stock', { item: 'sleep tea', quantity: 2 });
    await expect(core.assistant.call('change_item', { item: 'sleep tea', unit: 'tea bag', recount: true })).rejects.toThrow('A recount needs the new unit and what it comes in');
    const recounted = await core.assistant.call('change_item', { item: 'sleep tea', unit: 'tea bags', comes_in: { name: 'box', holds: 20 }, recount: true });
    expect(recounted.text).toBe('Sleep tea is updated: now counted in tea bags, 40 tea bags in stock (2 boxes of 20), enough until 2026-12-07. Larder still shows how many boxes there are, add_stock, use_stock and add_expected take amounts in boxes (unit: "box"), and the shopping list buys whole boxes.');
    expect((await core.products.list()).find((x) => x.product.name === 'Sleep tea')?.product.usage).toEqual({ amount: 20, everyDays: 20, auto: false, unit: null });
    const comesIn = await core.assistant.call('change_item', { item: 'sleep tea', comes_in: { name: 'tin', holds: 40 } });
    expect(comesIn.text).toBe('Sleep tea is updated: comes in tins of 40 (1 tin in stock). Larder still shows how many tins there are, add_stock, use_stock and add_expected take amounts in tins (unit: "tin"), and the shopping list buys whole tins.');
    const stopped = await core.assistant.call('change_item', { item: 'sleep tea', uses: null });
    expect(stopped.text).toBe('Sleep tea is updated: no usage set.');
  });

  it('keep the boxes when an assistant counts what is inside, and ask how fast they go', async () => {
    // What went wrong in the owner's chat: told "now 80 tea bags", they asked for boxes back and got a note.
    const core = await makeCore();
    const added = await core.assistant.call('add_item', { name: 'Twinings Sleep Tea', unit: 'box' });
    expect(added.text).toBe('Added Twinings Sleep Tea. It has no stock yet: use add_stock to say how many.');
    await core.automation.run('add_stock', { item: 'twinings sleep tea', quantity: 4 });
    // "Counted in boxes, 20 to a box" can't be: the answer says what to do instead.
    await expect(core.assistant.call('change_item', { item: 'twinings sleep tea', comes_in: { name: 'boxes', holds: 20 } })).rejects.toThrow(
      'Twinings Sleep Tea can\'t be counted in boxes and come in boxes. Count what\'s inside instead (unit: "tea bag", say), with comes_in a box of 20, and recount: true to turn the boxes counted so far into what\'s inside. Larder still shows how many boxes there are, and takes amounts in boxes (unit: "box").');

    const recounted = await core.assistant.call('change_item', { item: 'twinings sleep tea', unit: 'tea bag', comes_in: { name: 'box', holds: 20 }, recount: true });
    expect(recounted.text).toBe('Twinings Sleep Tea is updated: now counted in tea bags, 80 tea bags in stock (4 boxes of 20). Larder still shows how many boxes there are, add_stock, use_stock and add_expected take amounts in boxes (unit: "box"), and the shopping list buys whole boxes. No usage is set: ask how many tea bags get used a day or a week (uses), so Larder can say when they run out, and whether Larder should take them out of stock by itself (takes_out_automatically).');
    expect((await core.assistant.call('list_items', {})).text).toBe('- Twinings Sleep Tea: 80 tea bags (4 boxes)');
    // Asked for boxes again: it's already boxes, so the answer says so rather than renaming 80 tea bags to 80 boxes.
    await expect(core.assistant.call('change_item', { item: 'twinings sleep tea', unit: 'box' })).rejects.toThrow('Larder still shows how many boxes there are');

    const used = await core.assistant.call('change_item', { item: 'twinings sleep tea', uses: { amount: 1, every_days: 1 }, takes_out_automatically: true });
    expect(used.text).toBe('Twinings Sleep Tea is updated: uses 1 tea bag a day, taken out of stock by Larder, enough until 2027-01-17.');
    // Taking the pack off and renaming does it, but says what the numbers now read as.
    expect((await core.assistant.call('change_item', { item: 'twinings sleep tea', unit: 'box', comes_in: null, uses: null })).text)
      .toBe('Twinings Sleep Tea is updated: counted in boxes (the numbers stay as they were: 80 boxes in stock), no pack, no usage set.');

    const bags = await core.assistant.call('add_item', { name: 'Dishwasher tablets', unit: 'tablet', comes_in: { name: 'pack', holds: 30 } });
    expect(bags.text).toBe('Added Dishwasher tablets. It has no stock yet: use add_stock to say how many, in tablets or in packs (unit: "pack").');
    await expect(core.assistant.call('add_item', { name: 'Kitchen roll', unit: 'pack', comes_in: { name: 'pack', holds: 4 } })).rejects.toThrow(
      'Kitchen roll can\'t be counted in packs and come in packs. Count what\'s inside instead (unit: "tea bag", say), with comes_in a pack of 4. Larder still shows how many packs there are, and takes amounts in packs (unit: "pack").');
    expect(ASSISTANT_INSTRUCTIONS).toContain('wants a pack, not a note');
  });

  it('take amounts in boxes everywhere, and buy whole boxes', async () => {
    const core = await makeCore();
    const aldi = await core.shops.create({ name: 'Aldi' });
    const shed = await core.places.create({ name: 'Shed' });
    const bags = await core.products.create({ ...tea, pack: { name: 'box', holds: 80 }, usage: { amount: 2, everyDays: 1, auto: true }, minQuantity: 30, preferredShopIds: [aldi.id] });
    await core.automation.run('add_stock', { item: 'tea bags', quantity: 2, unit: 'box' });

    const data = (await core.assistant.call('get_item', { item: 'tea bags' })).data as Record<string, unknown>;
    expect(data).toMatchObject({ in_stock: 160, comes_in: { name: 'box', holds: 80 }, uses: { amount: 2, every_days: 1, taken_out_by_larder: true }, in_use_since: '2026-10-28', runs_out_on: '2027-01-17' });

    // A box goes to the shed; a count says 1 box and 10 loose are really left in the house.
    await core.automation.run('move_item', { item: 'tea bags', to: 'shed', quantity: 1, unit: 'box', permanent: false });
    expect((await core.products.get(bags.id)).entries.filter((e) => e.currentPlaceId === shed.id).reduce((n, e) => n + e.quantity, 0)).toBe(80);
    const fixed = await core.assistant.call('correct_stock', { item: 'tea bags', place: 'shed', quantity: 0.5, unit: 'box' });
    expect(fixed.text).toBe('Tea bags: corrected. 120 tea bags in stock.');

    // Below the minimum: the list buys whole boxes.
    await core.assistant.call('correct_stock', { item: 'tea bags', place: 'shed', remove: true });
    await core.automation.run('use_stock', { item: 'tea bags', quantity: 60 });
    const list = await core.assistant.call('shopping_list', { shop: 'aldi' });
    expect(list.text).toContain('Tea bags ×1 box (80 tea bags)');
    expect((list.data as { items: unknown[] }).items[0]).toMatchObject({ item: 'Tea bags', quantity: 80, packs: 1, pack: 'box' });

    // Ordered: 2 boxes, then 1 box arrives.
    await core.automation.run('add_expected', { item: 'tea bags', quantity: 2, unit: 'box', source: 'Aldi' });
    const arrived = await core.automation.run('mark_arrived', { item: 'tea bags', quantity: 1, unit: 'box' });
    expect(arrived.items).toMatchObject([{ in_stock: 100 }]);
    expect((await core.products.summary(bags.id)).expected).toBe(80);
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

describe('used by weight', () => {
  it('say what one weighs, and how fast it goes in grams, as the owner put it', async () => {
    // The owner's chat: a 400 g jar of decaf, "can you set it as four grams a day?"
    const core = await makeCore();
    await core.assistant.call('add_item', { name: 'Decaf coffee', unit: 'jar' });
    await core.automation.run('add_stock', { item: 'decaf coffee', quantity: 1 });
    // Said in jars first (all an assistant could do before): the weight brings the grams up.
    await core.assistant.call('change_item', { item: 'decaf coffee', uses: { amount: 1, every_days: 100 } });
    expect((await core.assistant.call('set_item_size', { item: 'decaf coffee', amount: 400, unit: 'g' })).text).toBe(
      'One jar of Decaf coffee is 400 g. How fast it\'s used can now be said in g, and its prices compared by weight. It\'s used 1 jar every 100 days, which is 4 g a day; if that\'s how the person says it, change_item can keep it that way (uses with unit: "g").');
    const changed = await core.assistant.call('change_item', { item: 'decaf coffee', uses: { amount: 4, every_days: 1, unit: 'g' } });
    expect(changed.text).toBe('Decaf coffee is updated: uses 4 g a day (a 400 g jar lasts 100 days), enough until 2027-02-05.');

    const item = (await core.assistant.call('get_item', { item: 'decaf coffee' }));
    expect(item.text).toContain('In stock: 1 jar (400 g).');
    expect(item.text).toContain('Weighs: 1 jar = 400 g.');
    expect(item.text).toContain('Uses 4 g a day (a 400 g jar lasts 100 days). Enough until 2027-02-05 (in 100 days).');
    expect(item.data).toMatchObject({ weighs: { amount: 400, unit: 'g' }, uses: { amount: 4, every_days: 1, unit: 'g', taken_out_by_larder: false }, runs_out_on: '2027-02-05' });

    // Stock can be used by weight too; a plain use is a whole jar.
    await core.automation.run('add_stock', { item: 'decaf coffee', quantity: 1 });
    expect((await core.automation.run('use_stock', { item: 'decaf coffee', quantity: 100, unit: 'g' })).message).toBe('Decaf coffee: used 0.25 jar (100 g). 1.75 jars left, enough until 2027-04-21.');
    expect((await core.automation.run('use_stock', { item: 'decaf coffee' })).message).toBe('Decaf coffee: used 1 jar (400 g). 0.75 jar left, enough until 2027-01-11.');
  });

  it('need the weight first, in the same kind of measure, and keep it while used by weight', async () => {
    const core = await makeCore();
    await core.assistant.call('add_item', { name: 'Decaf coffee', unit: 'jar' });
    await expect(core.assistant.call('change_item', { item: 'decaf coffee', uses: { amount: 4, every_days: 1, unit: 'g' } })).rejects.toThrow(
      "How fast it's used can't be in g. Larder doesn't know what one jar of Decaf coffee weighs, so it can't work in g. Give how many jars. Or give it a Weight first.");
    // Both at once is fine.
    expect((await core.assistant.call('change_item', { item: 'decaf coffee', weighs: { amount: 200, unit: 'g' }, uses: { amount: 4, every_days: 1, unit: 'g' } })).text)
      .toBe('Decaf coffee is updated: 1 jar = 200 g, uses 4 g a day (a 200 g jar lasts 50 days).');
    await expect(core.assistant.call('change_item', { item: 'decaf coffee', uses: { amount: 10, every_days: 1, unit: 'ml' } })).rejects.toThrow(
      "Larder doesn't know what one jar of Decaf coffee holds, so it can't work in ml.");
    await expect(core.assistant.call('change_item', { item: 'decaf coffee', weighs: null })).rejects.toThrow("Larder doesn't know what one jar of Decaf coffee weighs, so it can't work in g.");
    // Something counted by weight needs no weight, and takes a usage in its own measure or a bigger one.
    await core.assistant.call('add_item', { name: 'Cheddar', unit: 'g' });
    await expect(core.assistant.call('change_item', { item: 'cheddar', weighs: { amount: 1, unit: 'kg' } })).rejects.toThrow("Cheddar is counted in g, so it doesn't need a weight");
    expect((await core.assistant.call('change_item', { item: 'cheddar', uses: { amount: 0.25, every_days: 7, unit: 'kg' } })).text).toBe('Cheddar is updated: uses 0.25 kg a week.');
    await expect(core.assistant.call('change_item', { item: 'cheddar', uses: { amount: 1, every_days: 7, unit: 'l' } })).rejects.toThrow("Cheddar is bought loose, by weight, so it can't be given in L. Give how much in g or kg.");
    await expect(core.assistant.call('add_item', { name: 'Milk', unit: 'ml', weighs: { amount: 1, unit: 'l' } })).rejects.toThrow("Milk is counted in ml, so it doesn't need a weight");
  });

  it('take a little out every day, in amounts that round cleanly', async () => {
    const core = await makeCore();
    const coffee = await core.products.create({ name: 'Decaf coffee', unit: 'jar', size: { amount: 400, unit: 'g' }, usage: { amount: 4, everyDays: 1, auto: true, unit: 'g' } });
    await core.stock.add({ productId: coffee.id, quantity: 1 });
    core.clock.set('2026-10-29T09:00:00.000Z');
    await core.automation.checkExpiry();
    let s = await core.products.summary(coffee.id);
    expect(s.inStock).toBe(0.99);
    expect((await core.assistant.call('list_items', {})).text).toBe('- Decaf coffee: 0.99 jar (396 g), uses 4 g a day (taken out by Larder), enough until 2027-02-06 (in 100 days)');
    core.clock.set('2026-11-07T09:00:00.000Z');
    await core.automation.checkExpiry();
    expect((await core.products.summary(coffee.id)).inStock).toBe(0.9);

    // 5 g a day is 0.0125 of a jar, which would round to 0.013: it waits a day and takes 0.025.
    const tea = await core.products.create({ name: 'Loose leaf tea', unit: 'bag', size: { amount: 400, unit: 'g' }, usage: { amount: 5, everyDays: 1, auto: true, unit: 'g' } });
    await core.stock.add({ productId: tea.id, quantity: 1 });
    core.clock.set('2026-11-08T09:00:00.000Z');
    await core.automation.checkExpiry();
    expect((await core.products.summary(tea.id)).inStock).toBe(1);
    core.clock.set('2026-11-09T09:00:00.000Z');
    await core.automation.checkExpiry();
    expect((await core.products.summary(tea.id)).inStock).toBe(0.975);
    core.clock.set('2026-12-17T09:00:00.000Z');
    await core.automation.checkExpiry();
    s = await core.products.summary(tea.id);
    expect([s.inStock, s.product.inUseSince]).toEqual([0.5, '2026-12-17']);
  });

  it('counting what is inside keeps a usage by weight, and divides what one weighs', async () => {
    const core = await makeCore();
    const sleep = await core.products.create({ name: 'Sleep tea', unit: 'box', size: { amount: 30, unit: 'g' }, usage: { amount: 1.5, everyDays: 1, unit: 'g' } });
    await core.stock.add({ productId: sleep.id, quantity: 2 });
    const s = await core.stock.recount(sleep.id, { unit: 'tea bag', holds: 20 });
    expect([s.inStock, s.product.size, s.product.usage, s.runsOutOn]).toEqual([40, { amount: 1.5, unit: 'g' }, { amount: 1.5, everyDays: 1, auto: false, unit: 'g' }, '2026-12-07']);
  });
});
