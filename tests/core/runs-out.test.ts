/**
 * Things used one at a time, one after another, each lasting a set time once
 * started (a glucose sensor, contact lenses): when they run out, and when
 * that makes them low.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../../src/adapters/storage-memory';
import { makeCore, category } from '../helpers';

describe('things that last a set time once started', () => {
  it('works out when they run out: 3 that last 2 weeks are 6 weeks', async () => {
    const core = await makeCore();
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', lastsDays: 14 });
    await core.stock.add({ productId: sensor.id, quantity: 3 });
    let s = await core.products.summary(sensor.id);
    expect([s.inUseUntil, s.runsOutOn, s.daysToRunOut, s.status.low]).toEqual([null, '2026-12-09', 42, false]);

    // Using one starts it today; it's no longer in stock but still lasts its 14 days.
    s = await core.stock.use({ productId: sensor.id, quantity: 1 });
    expect(s.product.inUseSince).toBe('2026-10-28');
    expect([s.inStock, s.inUseUntil, s.runsOutOn]).toEqual([2, '2026-11-11', '2026-12-09']);

    core.clock.set('2026-11-02T09:00:00.000Z');
    s = await core.products.summary(sensor.id);
    expect([s.inUseUntil, s.runsOutOn, s.daysToRunOut]).toEqual(['2026-11-11', '2026-12-09', 37]);

    // Its days are up and the next wasn't started: the 2 left count from today.
    core.clock.set('2026-11-15T09:00:00.000Z');
    s = await core.products.summary(sensor.id);
    expect([s.inUseUntil, s.runsOutOn]).toEqual([null, '2026-12-13']);

    // Started on a different day than it was recorded: the date can be changed.
    await core.products.update(sensor.id, { inUseSince: '2026-11-12' });
    s = await core.products.summary(sensor.id);
    expect([s.inUseUntil, s.runsOutOn]).toEqual(['2026-11-26', '2026-12-24']);
  });

  it('is low when it runs out within the warning window, counting what is on order', async () => {
    const core = await makeCore();
    const boots = await core.shops.create({ name: 'Boots' });
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', lastsDays: 14, preferredShopIds: [boots.id], stockUpTo: 3 });
    await core.stock.add({ productId: sensor.id, quantity: 1 });
    let s = await core.stock.use({ productId: sensor.id, quantity: 1 });
    // The last one, in use for 14 more days: outside the household's 7-day warning.
    expect([s.runsOutOn, s.daysToRunOut, s.status.low, s.status.runningOut]).toEqual(['2026-11-11', 14, false, false]);

    core.clock.set('2026-11-05T09:00:00.000Z');
    s = await core.products.summary(sensor.id);
    expect(s.status).toMatchObject({ low: true, runningOut: true });
    const list = await core.shopping.forShop(boots.id);
    // Not "out" while the one in use has days left.
    expect(list.groups.flatMap((g) => g.items).map((i) => [i.summary.product.name, i.quantity, i.reason])).toEqual([['Glucose sensor', 3, 'low']]);

    // Two on the way last 4 more weeks, so it's not bought twice.
    s = await core.stock.expect({ productId: sensor.id, quantity: 2, source: 'Boots' });
    expect([s.runsOutOn, s.status.low, s.status.runningOut]).toEqual(['2026-11-11', false, false]);

    // A category's own warning applies (Medicine warns 30 days ahead).
    const medicine = await category(core, 'Medicine');
    const lenses = await core.products.create({ name: 'Contact lenses', unit: 'pair', lastsDays: 30, categoryId: medicine.id });
    await core.stock.add({ productId: lenses.id, quantity: 1 });
    s = await core.products.summary(lenses.id);
    expect([s.daysToRunOut, s.status.low]).toEqual([30, true]);
    s = await core.stock.add({ productId: lenses.id, quantity: 1 });
    expect([s.daysToRunOut, s.status.low]).toEqual([60, false]);
  });

  it('is out with none in use and none left, and a minimum still counts as well', async () => {
    const core = await makeCore();
    const filter = await core.products.create({ name: 'Water filter', lastsDays: 28 });
    let s = await core.products.summary(filter.id);
    expect([s.runsOutOn, s.daysToRunOut, s.status.low]).toEqual(['2026-10-28', 0, true]);
    expect((await core.assistant.call('get_item', { item: 'water filter' })).text).toContain('Each lasts 28 days once started, one after another. None in use and none left: it is low now.');
    await core.stock.add({ productId: filter.id, quantity: 2 });
    await core.products.update(filter.id, { minQuantity: 3 });
    s = await core.products.summary(filter.id);
    expect([s.daysToRunOut, s.status.low, s.status.runningOut]).toEqual([56, true, false]);
  });

  it('leaves everything else alone', async () => {
    const core = await makeCore();
    const rolls = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
    await core.stock.add({ productId: rolls.id, quantity: 4 });
    let s = await core.stock.use({ productId: rolls.id, quantity: 1 });
    expect([s.product.inUseSince, s.inUseUntil, s.runsOutOn, s.daysToRunOut, s.status.runningOut]).toEqual([null, null, null, null, false]);
    expect(core.events.log.filter((e) => e.type === 'product.updated')).toEqual([]);

    // Wanted, not owned: nothing runs out.
    const wish = await core.products.create({ name: 'Spare sensor', lastsDays: 14, wish: true });
    s = await core.products.summary(wish.id);
    expect([s.runsOutOn, s.status.low]).toEqual([null, false]);
  });

  it('reads items saved before it existed', async () => {
    const storage = createMemoryStorage();
    const core = await makeCore({ storage });
    const p = await core.products.create({ name: 'Old item' });
    const { lastsDays: _a, inUseSince: _b, ...old } = p;
    await storage.products.put(old as typeof p);
    await core.stock.add({ productId: p.id, quantity: 1 });
    const s = await core.stock.use({ productId: p.id, quantity: 1 });
    expect([s.runsOutOn, s.status.low]).toEqual([null, false]);
  });

  it('announces once when one comes within its warning window of running out', async () => {
    const core = await makeCore();
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', lastsDays: 14 });
    await core.stock.add({ productId: sensor.id, quantity: 1 });
    await core.stock.use({ productId: sensor.id, quantity: 1 });
    expect(await core.automation.checkExpiry()).toEqual({ expiring: 0, expired: 0, runningOut: 0, started: 0 });

    core.clock.set('2026-11-05T09:00:00.000Z');
    const both = await Promise.all([core.automation.checkExpiry(), core.automation.checkExpiry()]);
    expect(both.map((r) => r.runningOut).sort()).toEqual([0, 1]);
    expect(core.events.log.find((e) => e.type === 'stock.running_out')?.data).toEqual({ productId: sensor.id, name: 'Glucose sensor', runsOutOn: '2026-11-11', daysToRunOut: 6, inStock: 0, expected: 0, unit: 'sensor' });

    // Still running out on later days (even once its date moves, with none in use): not again.
    core.clock.set('2026-11-14T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).runningOut).toBe(0);

    // Restocked, it's fine until it comes close again (each started on its day: the last runs until 26 Dec).
    await core.stock.add({ productId: sensor.id, quantity: 3 });
    for (const day of ['2026-11-14', '2026-11-28', '2026-12-12']) {
      core.clock.set(`${day}T09:00:00.000Z`);
      await core.stock.use({ productId: sensor.id, quantity: 1 });
      expect((await core.automation.checkExpiry()).runningOut).toBe(0);
    }
    core.clock.set('2026-12-20T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).runningOut).toBe(1);
  });

  it('starts the next one automatically when set to, the day the last one ran out', async () => {
    const core = await makeCore();
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', lastsDays: 14, autoUse: true });
    const lenses = await core.products.create({ name: 'Contact lenses', unit: 'pair', lastsDays: 14 });
    await core.stock.add({ productId: sensor.id, quantity: 4 });
    await core.stock.add({ productId: lenses.id, quantity: 2 });
    // Nothing starts by itself until the first one is used.
    expect((await core.automation.checkExpiry()).started).toBe(0);
    await core.stock.use({ productId: sensor.id, quantity: 1 });
    await core.stock.use({ productId: lenses.id, quantity: 1 });

    core.clock.set('2026-11-10T23:00:00.000Z');
    expect((await core.automation.checkExpiry()).started).toBe(0);
    core.clock.set('2026-11-11T00:30:00.000Z');
    expect((await core.automation.checkExpiry()).started).toBe(1);
    let s = await core.products.summary(sensor.id);
    expect([s.inStock, s.product.inUseSince, s.inUseUntil, s.runsOutOn]).toEqual([2, '2026-11-11', '2026-11-25', '2026-12-23']);
    expect((await core.products.get(sensor.id)).history[0]).toMatchObject({ kind: 'use', quantity: -1, note: 'Next one started automatically' });
    expect(core.events.log.filter((e) => e.type === 'stock.changed').at(-1)?.data).toMatchObject({ name: 'Glucose sensor', kind: 'use', inStock: 2 });
    // Without it, the next is started with Use.
    expect((await core.products.summary(lenses.id)).inStock).toBe(1);

    // Larder was off for a while: it catches up, still one after another.
    core.clock.set('2026-12-10T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).started).toBe(2);
    s = await core.products.summary(sensor.id);
    expect([s.inStock, s.product.inUseSince, s.inUseUntil, s.runsOutOn]).toEqual([0, '2026-12-09', '2026-12-23', '2026-12-23']);

    // None left when the last one runs out; more bought later start the day they're added.
    core.clock.set('2026-12-24T09:00:00.000Z');
    expect((await core.automation.checkExpiry()).started).toBe(0);
    await core.stock.add({ productId: sensor.id, quantity: 2 });
    expect((await core.automation.checkExpiry()).started).toBe(1);
    s = await core.products.summary(sensor.id);
    expect([s.inStock, s.product.inUseSince, s.runsOutOn]).toEqual([1, '2026-12-24', '2027-01-21']);
  });

  it('tells Home Assistant and assistants when they run out', async () => {
    const core = await makeCore();
    const sensor = await core.products.create({ name: 'Glucose sensor', unit: 'sensor', lastsDays: 14 });
    await core.stock.add({ productId: sensor.id, quantity: 3 });

    const used = await core.automation.run('use_stock', { item: 'glucose sensor' });
    expect(used.message).toBe('Glucose sensor: used 1 sensor. 2 sensors left, enough until 2026-12-09.');
    expect(used.runs_out_on).toBe('2026-12-09');

    const item = await core.assistant.call('get_item', { item: 'glucose sensor' });
    expect(item.text).toContain('Each lasts 14 days once started, one after another. One in use since 2026-10-28, until 2026-11-11 (in 14 days). Enough until 2026-12-09 (in 42 days).');
    expect((await core.assistant.call('search', { query: 'glucose' })).text).toContain('enough until 2026-12-09 (in 42 days)');

    const changed = await core.assistant.call('change_item', { item: 'glucose sensor', lasts_days: 10, in_use_since: '2026-10-25' });
    expect(changed.text).toBe('Glucose sensor is updated: each lasts 10 days once started, the one in use was started on 2026-10-25, enough until 2026-11-24.');

    const auto = await core.assistant.call('change_item', { item: 'glucose sensor', auto_use: true });
    expect(auto.text).toBe('Glucose sensor is updated: the next one starts automatically when one runs out.');
    expect((await core.assistant.call('get_item', { item: 'glucose sensor' })).text).toContain('Each lasts 10 days once started, one after another, the next starting automatically when one runs out.');

    const added = await core.assistant.call('add_item', { name: 'Contact lenses', unit: 'pair', lasts_days: 30 });
    expect(added.text).toContain('Contact lenses');
    expect((await core.products.list()).find((p) => p.product.name === 'Contact lenses')?.product.lastsDays).toBe(30);
  });
});
