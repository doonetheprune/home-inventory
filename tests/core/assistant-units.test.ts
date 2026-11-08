/**
 * Assistant tools and Bought in, Contains, Weight and We use (docs/plans/units.md),
 * replaying the two chats in the Claude app that showed the old model was too complicated.
 */
import { describe, expect, it } from 'vitest';
import { ASSISTANT_INSTRUCTIONS } from '@larder/core';
import { makeCore } from '../helpers';

const text = async (core: Awaited<ReturnType<typeof makeCore>>, tool: string, input: Record<string, unknown>) => (await core.assistant.call(tool, input)).text;

describe('the owner\'s chats', () => {
  it('Twinings Sleep: boxes of 20 tea bags, one a day, taken out by Larder', async () => {
    const core = await makeCore();
    expect(await text(core, 'add_item', { name: 'Twinings Sleep', bought_in: 'box', category: 'Food' })).toBe('Added Twinings Sleep. It has no stock yet: use add_stock to say how many.');
    await core.automation.run('add_stock', { item: 'twinings sleep', quantity: 4 });

    // "A box holds 20 tea bags": the boxes stay, and the next question is how fast they go.
    expect(await text(core, 'change_item', { item: 'twinings sleep', contains: { amount: 20, unit: 'tea bags' } })).toBe(
      'Twinings Sleep is updated: each box contains 20 tea bags. No usage is set: ask how many tea bags get used a day or a week (uses, with unit "tea bag"), so Larder can say when they run out, and whether Larder should take them out of stock by itself (takes_out_automatically).');
    expect(await text(core, 'change_item', { item: 'twinings sleep', uses: { amount: 1, every_days: 1, unit: 'tea bag' }, takes_out_automatically: true })).toBe(
      'Twinings Sleep is updated: uses 1 tea bag a day, taken out of stock by Larder (a box lasts 20 days), enough until 2027-01-17.');
    const item = await core.assistant.call('get_item', { item: 'twinings sleep' });
    expect(item.text).toContain('In stock: 4 boxes.\nBought in boxes. Each box contains 20 tea bags.\n');
    expect(item.text).toContain('Uses 1 tea bag a day, taken out of stock by Larder a little at a time: a box lasts 20 days. Enough until 2027-01-17 (in 81 days).');
    expect(item.data).toMatchObject({ bought_in: 'box', in_stock: 4, contains: { amount: 20, unit: 'tea bag' }, weight: null, uses: { amount: 1, every_days: 1, unit: 'tea bag', taken_out_by_larder: true }, needs_check: null });

    // A tea bag a day comes out of the box; the count can be put right in tea bags.
    core.clock.set('2026-10-29T09:00:00.000Z');
    await core.automation.checkExpiry();
    expect(await text(core, 'list_items', {})).toBe('- Twinings Sleep: about 4 boxes (79 tea bags), uses 1 tea bag a day (taken out by Larder), enough until 2027-01-17 (in 80 days)');
    expect(await text(core, 'correct_stock', { item: 'twinings sleep', quantity: 55, unit: 'tea bags' })).toBe('Twinings Sleep: corrected. about 2¾ boxes (55 tea bags) in stock.');
    // A Weight can be given for anything, even tea bags in a box.
    expect(await text(core, 'change_item', { item: 'twinings sleep', weight: { amount: 30, unit: 'g' } })).toBe('Twinings Sleep is updated: weighs 30 g.');
    expect(await text(core, 'get_item', { item: 'twinings sleep' })).toContain('Bought in boxes. Each box contains 20 tea bags. Weight: 30 g.');
  });

  it('Decaf: a 400 g jar, four grams a day', async () => {
    const core = await makeCore();
    await core.assistant.call('add_item', { name: 'Decaf coffee', bought_in: 'jar' });
    await core.automation.run('add_stock', { item: 'decaf coffee', quantity: 1 });
    expect(await text(core, 'change_item', { item: 'decaf coffee', contains: { amount: 400, unit: 'g' }, uses: { amount: 4, every_days: 1, unit: 'g' }, takes_out_automatically: true })).toBe(
      'Decaf coffee is updated: each jar contains 400 g, uses 4 g a day, taken out of stock by Larder (a jar lasts 100 days), enough until 2027-02-06.');
    const item = await core.assistant.call('get_item', { item: 'decaf coffee' });
    // The Weight comes from Contains, so it isn't said twice.
    expect(item.text).toContain('Bought in jars. Each jar contains 400 g.\n');
    expect(item.text).toContain('Uses 4 g a day, taken out of stock by Larder a little at a time: a jar lasts 100 days.');
    expect(item.data).toMatchObject({ contains: { amount: 400, unit: 'g' }, weight: { amount: 400, unit: 'g' }, uses: { amount: 4, every_days: 1, unit: 'g' } });
    core.clock.set('2026-10-29T09:00:00.000Z');
    await core.automation.checkExpiry();
    expect(await text(core, 'get_item', { item: 'decaf coffee' })).toContain('In stock: about 1 jar (396 g).');
    // A Weight alongside Contains 400 g is refused: it's worked out from it.
    await expect(core.assistant.call('change_item', { item: 'decaf coffee', weight: { amount: 200, unit: 'g' } })).rejects.toThrow('Decaf coffee contains 400 g, so its Weight is 400 g, worked out from that. Change Contains instead.');
  });
});

describe('units for assistants', () => {
  it('are refused when not on the list, until the person agrees to add them', async () => {
    const core = await makeCore();
    await expect(core.assistant.call('add_item', { name: 'Paper cups', bought_in: 'sleeve' })).rejects.toThrow('Larder doesn\'t have the unit "sleeve". Ask whether to add it (add_unit), then try again.');
    expect(await text(core, 'add_unit', { one: 'sleeve', many: 'sleeves' })).toBe('Added "sleeve" (sleeves) to Larder\'s units.');
    expect(await text(core, 'add_item', { name: 'Paper cups', bought_in: 'sleeves' })).toBe('Added Paper cups. It has no stock yet: use add_stock to say how many.');
    const list = await core.assistant.call('list_units', {});
    expect(list.text).toContain('Counts: each, bag, bale, bar, battery, block, bottle, box,');
    expect(list.text).toContain('Weights: g, kg.\nVolumes: ml, cl, L, pint.\nAdded by the household: sleeve (sleeves).');
    expect((list.data as { units: unknown[] }).units).toContainEqual({ key: 'sleeve', one: 'sleeve', many: 'sleeves', kind: 'count', built_in: false });
    await expect(core.assistant.call('add_unit', { one: 'Boxes', many: 'Boxes' })).rejects.toThrow('Larder already has "box".');
    await expect(core.assistant.call('remove_unit', { unit: 'sleeve' })).rejects.toThrow('Paper cups uses "sleeve". Change it first.');
    await expect(core.assistant.call('use_stock', { item: 'paper cups', unit: 'pack' })).rejects.toThrow('Paper cups is bought in sleeves. Give how many sleeves.');
    await core.assistant.call('change_item', { item: 'paper cups', bought_in: 'pack' });
    expect(await text(core, 'remove_unit', { unit: 'sleeves' })).toBe('Removed "sleeve" from Larder\'s units.');
    expect(ASSISTANT_INSTRUCTIONS).toContain('Units must be on the list (list_units); if one isn\'t, ask whether to add it (add_unit).');
  });

  it('say a new Bought in keeps the numbers, and what goes with it', async () => {
    const core = await makeCore();
    await core.assistant.call('add_item', { name: 'Kitchen roll', bought_in: 'pack' });
    await core.automation.run('add_stock', { item: 'kitchen roll', quantity: 2 });
    expect(await text(core, 'change_item', { item: 'kitchen roll', bought_in: 'rolls' })).toBe('Kitchen roll is updated: bought in rolls (2 packs is now 2 rolls: correct the count if that\'s wrong).');
    // Counted one by one instead of in boxes: Contains goes, and the usage is in what it's bought in.
    await core.assistant.call('add_item', { name: 'Sleep tea', bought_in: 'box', contains: { amount: 20, unit: 'tea bag' }, uses: { amount: 1, every_days: 1, unit: 'tea bag' } });
    await core.automation.run('add_stock', { item: 'sleep tea', quantity: 4 });
    expect(await text(core, 'change_item', { item: 'sleep tea', bought_in: 'tea bag' })).toBe('Sleep tea is updated: bought in tea bags (4 boxes is now 4 tea bags: correct the count if that\'s wrong), contains nothing now.');
    expect((await core.assistant.call('get_item', { item: 'sleep tea' })).data).toMatchObject({ bought_in: 'tea bag', contains: null, uses: { amount: 1, unit: 'tea bag' } });
    // Bought loose: no Contains or Weight, and kg is kept as g.
    expect(await text(core, 'add_item', { name: 'Cheddar', bought_in: 'kg', minimum: 0.2 })).toBe('Added Cheddar. It has no stock yet: use add_stock to say how many.');
    expect((await core.assistant.call('get_item', { item: 'cheddar' })).text).toContain('Bought loose, by weight (g).');
    expect((await core.assistant.call('get_item', { item: 'cheddar' })).text).toContain('Running low below 200 g: it is low now.');
    await expect(core.assistant.call('change_item', { item: 'cheddar', weight: { amount: 1, unit: 'kg' } })).rejects.toThrow('Cheddar is bought loose, in g, so it has no Weight');
  });

  it('show what Larder flagged to tidy, and take it off when it looks right', async () => {
    const core = await makeCore();
    const sleep = await core.products.create({ name: 'Sleep tea', unit: 'box', contents: { amount: 20, unit: 'tea bag' }, categoryId: (await core.categories.list())[0]!.id });
    await core.adapters.storage.products.put({ ...sleep, needsCheck: 'Now counted in boxes of 20 tea bags. If you count them one by one instead, change Bought in and correct the count.' });
    expect(await text(core, 'get_item', { item: 'sleep tea' })).toContain('Sleep tea (Food)\nTo tidy: Now counted in boxes of 20 tea bags.');
    expect(await text(core, 'list_items', { status: 'to_tidy' })).toBe('- Sleep tea: 0 boxes. To tidy: Now counted in boxes of 20 tea bags. If you count them one by one instead, change Bought in and correct the count.');
    expect(((await core.assistant.call('list_items', { status: 'to_tidy' })).data as { items: unknown[] }).items[0]).toMatchObject({ needs_check: expect.stringContaining('Now counted in boxes') });
    expect(await text(core, 'change_item', { item: 'sleep tea', looks_right: true })).toBe('Sleep tea is updated: off the To tidy list.');
    expect(await text(core, 'list_items', { status: 'to_tidy' })).toBe('No items like that.');

    const milk = await core.products.create({ name: 'Whole milk', unit: 'bottle', categoryId: sleep.categoryId });
    await core.adapters.storage.products.put({ ...milk, unit: '4 pint bottle', needsCheck: '"4 pint bottle" isn\'t on the unit list. Pick what it\'s bought in, and what one contains.' });
    await expect(core.assistant.call('change_item', { item: 'whole milk', looks_right: true })).rejects.toThrow('"4 pint bottle" isn\'t on the unit list, so Whole milk can\'t be marked as looking right yet.');
    expect(await text(core, 'change_item', { item: 'whole milk', bought_in: 'bottle', contains: { amount: 4, unit: 'pints' } })).toBe(
      'Whole milk is updated: bought in bottles, each bottle contains 4 pints, off the To tidy list. No usage is set: ask how many bottles get used a day or a week (uses), or how much in ml (unit "ml"), so Larder can say when they run out, and whether Larder should take them out of stock by itself (takes_out_automatically).');
  });

  it('buy whole ones of what it is bought in, with no pack wording', async () => {
    const core = await makeCore();
    await core.shops.create({ name: 'Aldi' });
    await core.assistant.call('add_item', { name: 'Tea bags', bought_in: 'box', contains: { amount: 80, unit: 'tea bag' }, minimum: 0.5, shop: 'aldi' });
    await core.automation.run('add_stock', { item: 'tea bags', quantity: 20, unit: 'tea bags' });
    const list = await core.assistant.call('shopping_list', { shop: 'aldi' });
    expect(list.text).toBe('At Aldi (1):\nOther: Tea bags ×1 box');
    expect((list.data as { items: unknown[] }).items[0]).toEqual({ item: 'Tea bags', quantity: 1, unit: 'box', in_stock: 0.25, category: 'Other' });
    expect(await text(core, 'get_item', { item: 'tea bags' })).toContain('Running low below 0.5 box (40 tea bags): it is low now.');
  });

  it('are explained in the instructions in four short sentences', () => {
    for (const sentence of [
      'Every item is bought in a unit from Larder\'s list (bag, box, jar, roll, each…), or loose in g or ml, and stock is counted in it.',
      'Contains is what one holds, as on the pack: a number of something (a box contains 20 tea bags) or an amount (a bag contains 1 kg).',
      'Weight is the grams (or ml) in one. It\'s set from Contains when that\'s an amount, can be given for anything, and is the only thing Larder uses to work in g or ml (recipes, prices per kg, usage in grams). Without it Larder can\'t work in g or ml, and says so.',
      'Units must be on the list (list_units); if one isn\'t, ask whether to add it (add_unit).',
    ]) expect(ASSISTANT_INSTRUCTIONS).toContain(sentence);
    expect(ASSISTANT_INSTRUCTIONS).not.toMatch(/comes_in|recount|weighs|pack, not a note/);
  });
});
