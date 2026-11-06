/** Assistant tools that cover what the app's screens do: lists, places, codes, buying several things, and the rest of each form. */
import { describe, expect, it } from 'vitest';
import { makeCore, category } from '../helpers';

async function house() {
  const core = await makeCore();
  const food = await category(core, 'Food');
  const pantry = await core.places.create({ name: 'Pantry', code: 'P1' });
  const shed = await core.places.create({ name: 'Shed' });
  const beans = await core.products.create({ name: 'Baked beans', unit: 'tin', categoryId: food.id, minQuantity: 4, defaultPlaceId: pantry.id });
  await core.stock.add({ productId: beans.id, quantity: 2 });
  const drill = await core.products.create({ name: 'Cordless drill', defaultPlaceId: shed.id });
  await core.stock.add({ productId: drill.id, quantity: 1 });
  await core.stock.move({ productId: drill.id, toPlaceId: pantry.id, mode: 'temporary' });
  const soup = await core.products.create({ name: 'Soup', unit: 'tin', categoryId: food.id });
  await core.stock.add({ productId: soup.id, quantity: 3, placeId: null });
  const coffee = await core.products.create({ name: 'Coffee', unit: 'jar', defaultPlaceId: pantry.id });
  await core.stock.add({ productId: coffee.id, quantity: 2 });
  await core.stock.use({ productId: coffee.id, quantity: 1, open: true });
  return { core, pantry, shed, beans, drill, soup, coffee };
}
const text = async (core: Awaited<ReturnType<typeof makeCore>>, tool: string, input: Record<string, unknown>) => (await core.assistant.call(tool, input)).text;

describe('assistant tools for what the app does', () => {
  it('lists items by status, category and place', async () => {
    const { core } = await house();
    const low = await text(core, 'list_items', { status: 'low' });
    expect(low).toContain('Baked beans: 2 tins');
    expect(low).not.toContain('Soup');
    expect(await text(core, 'list_items', { status: 'out_of_place' })).toContain('Cordless drill');
    expect(await text(core, 'list_items', { status: 'to_sort' })).toBe('- Soup: 3 tins (3 tins with no place)');
    expect(await text(core, 'list_items', { status: 'open' })).toContain('Coffee: 1 jar');
    const food = await text(core, 'list_items', { category: 'food' });
    expect([food.includes('Baked beans'), food.includes('Soup'), food.includes('drill')]).toEqual([true, true, false]);
    expect(await text(core, 'list_items', { place: 'P1' })).toContain('Baked beans');
    expect(await text(core, 'list_items', { status: 'wish' })).toBe('No items like that.');
  });

  it('says what is in a place, and puts things away from To sort or back from one place', async () => {
    const { core, pantry, soup, drill } = await house();
    const inside = await text(core, 'get_place', { place: 'p1' });
    expect(inside).toContain('Kept here:\n- Baked beans: 2 tins (low)');
    expect(inside).toContain('Here for now: Cordless drill (1, usually in Shed).');

    expect(await text(core, 'move_item', { item: 'soup', to: 'pantry', from: 'to sort' })).toBe('Soup moved to Pantry for good.');
    expect(await text(core, 'list_items', { status: 'to_sort' })).toBe('No items like that.');
    expect((await core.products.summary(soup.id)).places.map((p) => p.id)).toEqual([pantry.id]);

    await expect(text(core, 'put_back', { item: 'drill', from: 'shed' })).rejects.toThrow('None of the cordless drill is out of place in Shed.');
    expect(await text(core, 'put_back', { item: 'drill', from: 'pantry' })).toBe('Cordless drill is back in Shed.');
    expect((await core.products.summary(drill.id)).status.outOfPlace).toBe(false);
  });

  it('changes the rest of an item: links, and places it is no longer kept in', async () => {
    const { core, soup } = await house();
    await core.assistant.call('move_item', { item: 'soup', to: 'pantry', from: 'to sort' });
    await expect(text(core, 'change_item', { item: 'soup', not_kept_in: ['pantry'] })).rejects.toThrow('Soup still has stock in Pantry.');
    await core.stock.use({ productId: soup.id, quantity: 3 });
    expect(await text(core, 'change_item', { item: 'soup', not_kept_in: ['pantry'], links: ['https://example.com/soup'] })).toBe('Soup is updated: no longer kept in Pantry, 1 link.');
    expect((await core.products.summary(soup.id)).product.keptInPlaceIds).toEqual([]);
    expect(await text(core, 'get_item', { item: 'soup' })).toContain('Links: https://example.com/soup');

    await core.assistant.call('add_item', { name: 'Eneloop AA', rechargeable: true, notes: 'For the remotes.', links: ['https://example.com/aa'] });
    const aa = (await core.products.list()).find((s) => s.product.name === 'Eneloop AA')!.product;
    expect([aa.rechargeable, aa.unit, aa.notes, aa.links.map((l) => l.url)]).toEqual([true, 'battery', 'For the remotes.', ['https://example.com/aa']]);
  });

  it('lists what no shop sells, and adds several things bought at once', async () => {
    const { core, beans } = await house();
    expect(await text(core, 'shopping_list', { shop: 'none' })).toBe([
      'No shop sells these (1): give them a shop with change_item, or say which categories a shop sells with change_shop.',
      'Food: Baked beans ×2 tins',
    ].join('\n'));
    await core.shops.addPreset('Aldi');
    expect(await text(core, 'bought', { shop: 'aldi', items: [{ item: 'beans', quantity: 4, price: 2.2 }, { item: 'coffee', quantity: 1 }] })).toBe('Added to stock from Aldi: Baked beans (4 tins, 2.20) and Coffee (1 jar).');
    expect((await core.products.summary(beans.id)).inStock).toBe(6);
    const purchased = core.events.log.filter((e) => e.type === 'shopping.purchased').at(-1)!.data;
    expect(purchased).toMatchObject({ items: [{ productId: beans.id, quantity: 4, price: 2.2 }, { quantity: 1 }] });
  });

  it('adds stock with a price, shop and brand, and orders with a price', async () => {
    const { core, beans } = await house();
    await core.shops.addPreset('Tesco');
    await core.products.addVariant(beans.id, { name: 'Heinz 4 pack', barcodes: ['5000157024671'] });
    expect(await text(core, 'add_stock', { item: 'beans', quantity: 4, brand: 'heinz', price: 3.5, shop: 'tesco' })).toBe('Baked beans: added 4 tins (Heinz 4 pack), bought at Tesco for 3.50. 6 tins in stock.');
    expect(core.events.log.filter((e) => e.type === 'shopping.purchased').at(-1)!.data).toMatchObject({ items: [{ quantity: 4, price: 3.5 }] });
    expect(await text(core, 'add_expected', { item: 'beans', quantity: 6, source: 'Tesco delivery', price: 4.5, pending: true })).toBe('Baked beans: 6 tins in a pending order from Tesco delivery, not confirmed yet.');
    expect((await core.products.get(beans.id)).entries.find((e) => e.status === 'pending')?.expected?.unitPrice).toBe(0.75);
  });

  it('says what a code is', async () => {
    const { core, beans } = await house();
    await core.products.addVariant(beans.id, { name: 'Heinz 4 pack', barcodes: ['5000157024671'] });
    expect(await text(core, 'identify_code', { code: '5000157024671' })).toContain('5000157024671 is Baked beans (Heinz 4 pack).');
    expect(await text(core, 'identify_code', { code: 'p1' })).toBe('p1 is the place Pantry.');
    expect(await text(core, 'identify_code', { code: '4006381333931' })).toContain('Nobody knows the code 4006381333931');
  });

  it('keeps a note on what was used, and marks only what was due by a day as arrived', async () => {
    const { core, beans } = await house();
    await core.assistant.call('use_stock', { item: 'beans', quantity: 1, note: 'Thrown away: dented' });
    expect((await core.products.get(beans.id)).history[0]).toMatchObject({ kind: 'use', note: 'Thrown away: dented' });
    await core.stock.expect({ productId: beans.id, quantity: 4, source: 'Tesco delivery', eta: '2026-10-29' });
    await core.stock.expect({ productId: beans.id, quantity: 8, source: 'Tesco delivery', eta: '2026-11-05' });
    await core.assistant.call('mark_arrived', { source: 'Tesco delivery', due_by: '2026-10-29' });
    const s = await core.products.summary(beans.id);
    expect([s.inStock, s.expected]).toEqual([5, 8]);
  });
});
