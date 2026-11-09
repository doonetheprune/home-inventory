/**
 * What an item is bought in, its pack size, its Weight and what its usage is in:
 * checked on every write by the product service (docs/plans/units.md).
 */
import { describe, expect, it } from 'vitest';
import { makeCore } from '../helpers';

describe('Bought in', () => {
  it('is a key from the unit list, however it is typed', async () => {
    const core = await makeCore();
    expect((await core.products.create({ name: 'Sleep tea', unit: 'Boxes' })).unit).toBe('box');
    expect((await core.products.create({ name: 'Tea bags', unit: 'teabags' })).unit).toBe('tea bag');
    expect((await core.products.create({ name: 'Drill' })).unit).toBe('each');
    await expect(core.products.create({ name: 'Cups', unit: 'sleeve' })).rejects.toThrow('Larder doesn\'t have the unit "sleeve". Add it in Settings → Units, then try again.');
  });

  it('keeps things bought loose in g or ml: kg and L are only for typing', async () => {
    const core = await makeCore();
    const peas = await core.products.create({ name: 'Frozen peas', unit: 'kg', minQuantity: 0.5, stockUpTo: 2, usage: { amount: 0.1, everyDays: 7, auto: false } });
    expect([peas.unit, peas.minQuantity, peas.stockUpTo, peas.usage]).toEqual(['g', 500, 2000, { amount: 0.1, everyDays: 7, auto: false, unit: 'kg' }]);
    const oil = await core.products.create({ name: 'Heating oil', unit: 'litres', minQuantity: 300 });
    expect([oil.unit, oil.minQuantity]).toEqual(['ml', 300000]);
    // Numbers not given with it stay as they are.
    const bag = await core.products.create({ name: 'Rice', unit: 'bag', minQuantity: 2 });
    expect(await core.products.update(bag.id, { unit: 'kg' })).toMatchObject({ unit: 'g', minQuantity: 2 });
  });

  it('keeps an old unit that is not on the list until it is changed', async () => {
    const core = await makeCore();
    const milk = await core.products.create({ name: 'Whole milk', unit: 'bottle' });
    await core.adapters.storage.products.put({ ...milk, unit: '4 pint bottle', needsCheck: '"4 pint bottle" isn\'t on the unit list.' });
    expect((await core.products.setOnList(milk.id, true)).unit).toBe('4 pint bottle');
    await expect(core.products.update(milk.id, { unit: '4 pint bottle' })).rejects.toThrow('Larder doesn\'t have the unit "4 pint bottle".');
    // "Looks right" can't clear it while the unit isn't on the list.
    await expect(core.products.update(milk.id, { needsCheck: null })).rejects.toThrow('"4 pint bottle" isn\'t on the unit list, so Whole milk can\'t be marked as looking right yet. Pick what it\'s bought in first.');
    expect(await core.products.update(milk.id, { unit: 'bottle', packSize: { amount: 4, unit: 'pints' }, needsCheck: null })).toMatchObject({ unit: 'bottle', needsCheck: null, weight: { amount: 2273.044, unit: 'ml' } });
  });
});

describe('Pack size', () => {
  it('is a count from the list or an amount, never each or what it is bought in', async () => {
    const core = await makeCore();
    expect((await core.products.create({ name: 'Sleep tea', unit: 'box', packSize: { amount: 20, unit: 'teabags' } })).packSize).toEqual({ amount: 20, unit: 'tea bag' });
    await expect(core.products.create({ name: 'Pens', unit: 'pack', packSize: { amount: 10, unit: 'each' } })).rejects.toThrow('Give the pack size with a unit from the list, e.g. 20 tea bags or 6 eggs, or leave Pack size empty.');
    await expect(core.products.create({ name: 'Boxes', unit: 'box', packSize: { amount: 20, unit: 'boxes' } })).rejects.toThrow("Boxes is bought in boxes, so its pack size can't be in boxes too.");
    await expect(core.products.create({ name: 'Cups', unit: 'pack', packSize: { amount: 50, unit: 'cups' } })).rejects.toThrow('Larder doesn\'t have the unit "cups".');
    await expect(core.products.create({ name: 'Cheddar', unit: 'g', packSize: { amount: 400, unit: 'g' } })).rejects.toThrow('Cheddar is bought loose, in g, so it has no pack size');
  });

  it('as an amount, sets the Weight; a different Weight alongside it is refused', async () => {
    const core = await makeCore();
    const decaf = await core.products.create({ name: 'Decaf coffee', unit: 'jar', packSize: { amount: 400, unit: 'g' } });
    expect(decaf.weight).toEqual({ amount: 400, unit: 'g' });
    const sugar = await core.products.create({ name: 'Sugar', unit: 'bag', packSize: { amount: 1, unit: 'kg' }, weight: { amount: 1000, unit: 'g' } });
    expect(sugar.weight).toEqual({ amount: 1000, unit: 'g' });
    await expect(core.products.update(decaf.id, { weight: { amount: 200, unit: 'g' } })).rejects.toThrow('Decaf coffee has a pack size of 400 g, so its Weight is 400 g, worked out from that. Change the pack size instead.');
    expect((await core.products.update(decaf.id, { packSize: { amount: 200, unit: 'g' } })).weight).toEqual({ amount: 200, unit: 'g' });
    // No longer an amount: the Weight it set goes. A count keeps a Weight given by hand.
    expect((await core.products.update(decaf.id, { packSize: { amount: 50, unit: 'sachets' } })).weight).toBeNull();
    expect((await core.products.update(decaf.id, { weight: { amount: 0.25, unit: 'kg' } })).weight).toEqual({ amount: 250, unit: 'g' });
    expect((await core.products.update(decaf.id, { packSize: null })).weight).toEqual({ amount: 250, unit: 'g' });
  });

  it('goes when it becomes what it is bought in, and a usage in it follows', async () => {
    const core = await makeCore();
    const sleep = await core.products.create({ name: 'Sleep tea', unit: 'box', packSize: { amount: 20, unit: 'tea bag' }, usage: { amount: 1, everyDays: 1, auto: true, unit: 'tea bags' } });
    expect(sleep.usage).toMatchObject({ unit: 'tea bag' });
    expect(await core.products.update(sleep.id, { unit: 'tea bag' })).toMatchObject({ unit: 'tea bag', packSize: null, usage: { amount: 1, everyDays: 1, unit: null } });
  });
});

describe('Weight', () => {
  it('is kept in g or ml, can be given for anything counted, and never for things bought loose', async () => {
    const core = await makeCore();
    expect((await core.products.create({ name: 'Drill', weight: { amount: 1.6, unit: 'kg' } })).weight).toEqual({ amount: 1600, unit: 'g' });
    expect((await core.products.create({ name: 'Milk', unit: 'bottle', weight: { amount: 4, unit: 'pint' } })).weight).toEqual({ amount: 2273.044, unit: 'ml' });
    expect((await core.products.create({ name: 'Sleep', unit: 'box', packSize: { amount: 20, unit: 'tea bag' }, weight: { amount: 30, unit: 'g' } })).weight).toEqual({ amount: 30, unit: 'g' });
    await expect(core.products.create({ name: 'Cheddar', unit: 'g', weight: { amount: 1, unit: 'kg' } })).rejects.toThrow('Cheddar is bought loose, in g, so it has no Weight');
    await expect(core.products.create({ name: 'Box', unit: 'box', weight: { amount: 2, unit: 'tins' } })).rejects.toThrow('A Weight is in g, kg, ml, L or pints, not tins.');
  });
});

describe('We use', () => {
  it('is in what it is bought in, what it contains, or a weight or volume once there is a Weight', async () => {
    const core = await makeCore();
    const sleep = await core.products.create({ name: 'Sleep tea', unit: 'box', packSize: { amount: 20, unit: 'tea bag' }, usage: { amount: 1, everyDays: 1, auto: false, unit: 'box' } });
    expect(sleep.usage?.unit).toBeNull();
    expect((await core.products.update(sleep.id, { usage: { amount: 1, everyDays: 1, unit: 'tea bag' } })).usage?.unit).toBe('tea bag');
    await expect(core.products.update(sleep.id, { usage: { amount: 4, everyDays: 1, unit: 'g' } })).rejects.toThrow(
      "How fast it's used can't be in g. Larder doesn't know what one box of Sleep tea weighs, so it can't work in g. Give how many boxes or tea bags. Or give it a Weight first.");
    const decaf = await core.products.create({ name: 'Decaf coffee', unit: 'jar', packSize: { amount: 400, unit: 'g' }, usage: { amount: 4, everyDays: 1, auto: true, unit: 'grams' } });
    expect(decaf.usage).toEqual({ amount: 4, everyDays: 1, auto: true, unit: 'g' });
    await expect(core.products.update(decaf.id, { usage: { amount: 10, everyDays: 1, unit: 'ml' } })).rejects.toThrow('a volume can\'t be worked out from a weight');
    await expect(core.products.update(decaf.id, { usage: { amount: 1, everyDays: 1, unit: 'sleeve' } })).rejects.toThrow('Larder doesn\'t have the unit "sleeve".');
    // A pack size in a count it's used in can't be taken away without saying how fast it's used instead.
    await expect(core.products.update(sleep.id, { packSize: null })).rejects.toThrow("How fast it's used can't be in tea bags.");
  });
});

describe('To tidy', () => {
  it('lists items an upgrade flagged, until saved from Edit or Looks right', async () => {
    const core = await makeCore();
    const sleep = await core.products.create({ name: 'Sleep tea', unit: 'box', packSize: { amount: 20, unit: 'tea bag' }, categoryId: (await core.categories.list())[0]!.id });
    await core.adapters.storage.products.put({ ...sleep, needsCheck: 'Now counted in boxes of 20 tea bags.' });
    expect((await core.products.list({ status: 'to_tidy' })).map((s) => [s.product.name, s.product.needsCheck])).toEqual([['Sleep tea', 'Now counted in boxes of 20 tea bags.']]);
    await core.products.update(sleep.id, { needsCheck: null });
    expect(await core.products.list({ status: 'to_tidy' })).toEqual([]);
  });
});
