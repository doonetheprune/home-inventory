/**
 * How fast things are used ("we use 1 tea bag a day", "1 sensor every 14 days",
 * "4 g a day"), its pack size ("a box of 20 tea bags"), Larder taking
 * them out of stock by itself, a little at a time, and opened-not-finished.
 */
import { describe, expect, it } from 'vitest';
import { makeCore, category } from '../helpers';

const tea = { name: 'Tea bags', unit: 'box', packSize: { amount: 20, unit: 'tea bag' } };

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

    // Several a day, or fractions: a box of 20 tea bags at 3 a day lasts 6 whole days.
    const bags = await core.products.create({ ...tea, usage: { amount: 3, everyDays: 1, auto: false, unit: 'tea bag' } });
    s = await core.stock.add({ productId: bags.id, quantity: 1 });
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
  it('takes the amount out each period, a little of a box at a time, catches up after time off, and stops at none', async () => {
    const core = await makeCore();
    const aldi = await core.shops.create({ name: 'Aldi' });
    // Switched on, it counts from today: today's is already out, so the next goes tomorrow. Low below 7 tea bags.
    const bags = await core.products.create({ ...tea, usage: { amount: 1, everyDays: 1, auto: true, unit: 'tea bag' }, minQuantity: 0.35, preferredShopIds: [aldi.id] });
    expect(bags.inUseSince).toBe('2026-10-28');
    let s = await core.stock.add({ productId: bags.id, quantity: 1 });
    expect([s.inStock, s.inUse, s.inUseUntil, s.runsOutOn]).toEqual([1, true, '2026-10-29', '2026-11-18']);
    expect((await core.automation.checkExpiry()).taken).toBe(0);

    // After midnight (UK time) the next tea bag is taken, a twentieth of the box, once however often it checks.
    core.clock.set('2026-10-29T00:30:00.000Z');
    const both = await Promise.all([core.automation.checkExpiry(), core.automation.checkExpiry()]);
    expect(both.map((r) => r.taken).sort()).toEqual([0, 1]);
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.product.inUseSince, s.runsOutOn]).toEqual([0.95, '2026-10-29', '2026-11-18']);
    expect((await core.products.get(bags.id)).history[0]).toMatchObject({ kind: 'use', quantity: -0.05, note: 'Taken by Larder' });
    expect(core.events.log.filter((e) => e.type === 'stock.changed').at(-1)?.data).toMatchObject({ name: 'Tea bags', kind: 'use', inStock: 0.95, unit: 'box' });

    // Larder was off for 10 days: it catches up, and is low below 7 tea bags.
    core.clock.set('2026-11-08T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(10);
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.product.inUseSince, s.status.low]).toEqual([0.45, '2026-11-08', false]);
    core.clock.set('2026-11-11T09:00:00.000Z');
    await core.automation.checkExpiry();
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.status.low]).toEqual([0.3, true]);

    // It stops at none, and is out once today's has gone.
    core.clock.set('2026-12-01T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(6);
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.product.inUseSince, s.inUse]).toEqual([0, '2026-11-17', false]);
    const list = (await core.shopping.forShop(aldi.id)).groups.flatMap((g) => g.items);
    // The list buys whole boxes.
    expect(list.map((i) => [i.summary.product.name, i.reason, i.quantity, i.packs])).toEqual([['Tea bags', 'out', 1, null]]);

    // A box bought later starts the day it's added: nothing is taken for the days with none.
    core.clock.set('2026-12-03T18:00:00.000Z');
    await core.stock.add({ productId: bags.id, quantity: 1 });
    expect((await core.automation.checkExpiry()).taken).toBe(1);
    s = await core.products.summary(bags.id);
    expect([s.inStock, s.product.inUseSince, s.inUseUntil]).toEqual([0.95, '2026-12-03', '2026-12-04']);
  });

  it('takes tea bags out of boxes of 80, waiting a day when one would not round cleanly', async () => {
    const core = await makeCore();
    // 1 tea bag of 80 is 0.0125 of a box, which would round to 0.013: it takes 0.025 every 2 days.
    const breakfast = await core.products.create({ name: 'Breakfast tea', unit: 'box', packSize: { amount: 80, unit: 'tea bag' }, usage: { amount: 1, everyDays: 1, auto: true, unit: 'tea bag' } });
    await core.stock.add({ productId: breakfast.id, quantity: 1 });
    core.clock.set('2026-10-29T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(0);
    core.clock.set('2026-10-30T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).taken).toBe(1);
    expect((await core.products.summary(breakfast.id)).inStock).toBe(0.975);
    // 2 a day, as the example household has it, rounds cleanly every day.
    await core.products.update(breakfast.id, { usage: { amount: 2, everyDays: 1, auto: true, unit: 'tea bag' } });
    core.clock.set('2026-10-31T09:00:00.000Z');
    await core.automation.checkExpiry();
    expect((await core.products.summary(breakfast.id)).inStock).toBe(0.95);
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
    const bags = await core.products.create({ name: 'Tea bags', unit: 'tea bag', usage: { amount: 1, everyDays: 1, auto: false } });
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

describe('pack size', () => {
  it('adds, uses and orders in boxes or in tea bags, and says what it can be given in', async () => {
    const core = await makeCore();
    const bags = await core.products.create(tea);
    let s = await core.stock.add({ productId: bags.id, quantity: 2, unit: 'boxes' });
    expect(s.inStock).toBe(2);
    s = await core.stock.use({ productId: bags.id, quantity: 3, unit: 'Tea bags' });
    expect(s.inStock).toBe(1.85);
    s = await core.stock.use({ productId: bags.id, quantity: 0.5 });
    expect(s.inStock).toBe(1.35);
    s = await core.stock.expect({ productId: bags.id, quantity: 20, unit: 'tea bag', source: 'Tesco' });
    expect(s.expected).toBe(1);
    await expect(core.stock.add({ productId: bags.id, quantity: 1, unit: 'kg' })).rejects.toThrow("Larder doesn't know what one box of Tea bags weighs, so it can't work in kg. Give how many boxes or tea bags. Or give it a Weight first.");
    await expect(core.stock.add({ productId: bags.id, quantity: 1, unit: 'sleeve' })).rejects.toThrow('Larder doesn\'t have the unit "sleeve".');

    // With nothing inside, only what it's bought in.
    const rolls = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
    await expect(core.stock.add({ productId: rolls.id, quantity: 1, unit: 'box' })).rejects.toThrow('Toilet roll is bought in rolls. Give how many rolls.');
    const pens = await core.products.create({ name: 'Pens' });
    expect((await core.stock.add({ productId: pens.id, quantity: 2, unit: 'each' })).inStock).toBe(2);
  });

  it('buys whole boxes: the list rounds up to the stock-up amount', async () => {
    const core = await makeCore();
    const aldi = await core.shops.create({ name: 'Aldi' });
    // Low below 10 tea bags, stocked up to 50, with 8 left.
    const bags = await core.products.create({ ...tea, minQuantity: 0.5, stockUpTo: 2.5, preferredShopIds: [aldi.id] });
    await core.stock.add({ productId: bags.id, quantity: 8, unit: 'tea bags' });
    const [item] = (await core.shopping.forShop(aldi.id)).groups.flatMap((g) => g.items);
    expect([item!.reason, item!.quantity, item!.packs]).toEqual(['low', 3, null]);
  });
});

describe('Home Assistant', () => {
  it('says how fast things are used, takes extras in whole boxes, and amounts in tea bags', async () => {
    const core = await makeCore();
    const shed = await core.places.create({ name: 'Shed' });
    const bags = await core.products.create({ ...tea, packSize: { amount: 80, unit: 'tea bag' }, usage: { amount: 2, everyDays: 1, auto: true, unit: 'tea bag' }, minQuantity: 0.175 });
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', usage: { amount: 1, everyDays: 14, auto: false } });
    expect((await core.automation.run('add_stock', { item: 'tea bags', quantity: 2 })).message).toBe('Tea bags: added 2 boxes (160 tea bags). 2 boxes in stock.');
    await core.stock.add({ productId: sensor.id, quantity: 3 });

    // A plain Use is a whole box (finished, or thrown away); Larder takes the tea bags out by itself.
    const extra = await core.automation.run('use_stock', { item: 'tea bags' });
    expect(extra.message).toBe('Tea bags: used 1 box (80 tea bags) extra (Larder also takes out 2 tea bags a day). 1 box left, enough until 2026-12-08.');
    expect(extra.unit).toBe('boxes');
    const started = await core.automation.run('use_stock', { item: 'glucose sensor' });
    expect(started.message).toBe('Glucose sensor: started 1 sensor. 2 sensors left, enough until 2026-12-09.');
    expect(started.runs_out_on).toBe('2026-12-09');
    expect((await core.automation.run('use_stock', { item: 'tea bags', quantity: 20, unit: 'tea bags' })).message).toBe('Tea bags: used 20 tea bags (0.25 box) extra (Larder also takes out 2 tea bags a day). 60 tea bags left (about ¾ box), enough until 2026-11-28.');

    // A box goes to the shed, then one arrives of two ordered.
    await core.automation.run('move_item', { item: 'tea bags', to: 'shed', quantity: 40, unit: 'tea bags', permanent: false });
    expect((await core.products.get(bags.id)).entries.filter((e) => e.currentPlaceId === shed.id).reduce((n, e) => n + e.quantity, 0)).toBe(0.5);
    expect((await core.automation.run('add_expected', { item: 'tea bags', quantity: 2, source: 'Aldi' })).message).toBe('Tea bags: 2 boxes (160 tea bags) expected from Aldi.');
    const arrived = await core.automation.run('mark_arrived', { item: 'tea bags', quantity: 80, unit: 'tea bags' });
    expect(arrived.items).toMatchObject([{ in_stock: 1.75, unit: 'boxes' }]);
    expect((await core.products.summary(bags.id)).expected).toBe(1);
    await expect(core.automation.run('add_stock', { item: 'tea bags', quantity: 1, unit: 'sleeve' })).rejects.toThrow('Larder doesn\'t have the unit "sleeve".');
  });

  it('lists low items with the plural of what they are bought in', async () => {
    const core = await makeCore();
    await core.products.create({ ...tea, minQuantity: 1 });
    await core.products.create({ name: 'Cheddar', unit: 'g', minQuantity: 200 });
    const low = (await core.automation.read()).low_stock!;
    expect(low.attributes!.items).toMatchObject([{ item: 'Cheddar', unit: 'g' }, { item: 'Tea bags', unit: 'boxes' }]);
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
  it('takes a little out every day, in amounts that round cleanly', async () => {
    const core = await makeCore();
    const coffee = await core.products.create({ name: 'Decaf coffee', unit: 'jar', packSize: { amount: 400, unit: 'g' }, usage: { amount: 4, everyDays: 1, auto: true, unit: 'g' } });
    await core.stock.add({ productId: coffee.id, quantity: 1 });
    core.clock.set('2026-10-29T09:00:00.000Z');
    await core.automation.checkExpiry();
    let s = await core.products.summary(coffee.id);
    expect([s.inStock, s.runsOutOn]).toEqual([0.99, '2027-02-06']);
    core.clock.set('2026-11-07T09:00:00.000Z');
    await core.automation.checkExpiry();
    expect((await core.products.summary(coffee.id)).inStock).toBe(0.9);

    // 5 g a day is 0.0125 of a jar, which would round to 0.013: it waits a day and takes 0.025.
    const tea = await core.products.create({ name: 'Loose leaf tea', unit: 'bag', packSize: { amount: 400, unit: 'g' }, usage: { amount: 5, everyDays: 1, auto: true, unit: 'g' } });
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

  it('takes grams from Home Assistant, and a plain use is a whole jar', async () => {
    const core = await makeCore();
    await core.products.create({ name: 'Decaf coffee', unit: 'jar', packSize: { amount: 400, unit: 'g' }, usage: { amount: 4, everyDays: 1, auto: false, unit: 'g' } });
    await core.automation.run('add_stock', { item: 'decaf coffee', quantity: 2 });
    expect((await core.automation.run('use_stock', { item: 'decaf coffee', quantity: 100, unit: 'g' })).message).toBe('Decaf coffee: used 100 g (0.25 jar). About 1¾ jars left, enough until 2027-04-21.');
    expect((await core.automation.run('use_stock', { item: 'decaf coffee' })).message).toBe('Decaf coffee: used 1 jar (400 g). About ¾ jar left, enough until 2027-01-11.');
    // Without a Weight, Larder can't work in grams, and says so.
    await core.products.create({ name: 'Sugar', unit: 'bag' });
    await core.automation.run('add_stock', { item: 'sugar', quantity: 1 });
    await expect(core.automation.run('use_stock', { item: 'sugar', quantity: 100, unit: 'g' })).rejects.toThrow("Larder doesn't know what one bag of Sugar weighs, so it can't work in g. Give how many bags. Or give it a Weight first.");
  });
});
