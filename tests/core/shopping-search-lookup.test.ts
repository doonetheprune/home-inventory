import { beforeEach, describe, expect, it } from 'vitest';
import { defineModule } from '@larder/core';
import { makeCore, category, type TestCore } from '../helpers';

describe('shopping lists', () => {
  let core: TestCore;
  let aldi: string;
  let tesco: string;
  let toolstation: string;

  beforeEach(async () => {
    core = await makeCore();
    aldi = (await core.shops.addPreset('Aldi')).id;
    tesco = (await core.shops.addPreset('Tesco')).id;
    toolstation = (await core.shops.addPreset('Toolstation')).id;
    const food = await category(core, 'Food');
    const household = await category(core, 'Household');
    const tools = await category(core, 'Tools & DIY');
    const pets = await category(core, 'Pets');
    await core.products.create({ name: 'Bananas', categoryId: food.id, minQuantity: 1, preferredShopIds: [aldi] });
    await core.products.create({ name: 'Kitchen roll', categoryId: household.id, minQuantity: 2 });
    await core.products.create({ name: 'Cable ties', categoryId: tools.id, minQuantity: 1 });
    await core.products.create({ name: 'Dog food', categoryId: pets.id, minQuantity: 4 });
    const loo = await core.products.create({ name: 'Toilet roll', categoryId: household.id, minQuantity: 9 });
    await core.stock.add({ productId: loo.id, quantity: 4 });
    await core.stock.expect({ productId: loo.id, quantity: 18, source: 'Tesco delivery' });
    await core.products.create({ name: 'Head torch', categoryId: household.id, wish: true, minQuantity: 1 });
  });

  const names = async (shopId: string) => (await core.shopping.forShop(shopId)).groups.flatMap((g) => g.items.map((i) => i.summary.product.name));

  it("lists a shop's favourites plus any-shop items in the categories it sells", async () => {
    expect(await names(aldi)).toEqual(['Bananas', 'Kitchen roll']);
    expect(await names(tesco)).toEqual(['Kitchen roll', 'Dog food']);
    expect(await names(toolstation)).toEqual(['Cable ties']);
  });

  it('leaves out things covered by expected deliveries and wish list items', async () => {
    const all = [...(await names(aldi)), ...(await names(tesco))];
    expect(all).not.toContain('Toilet roll');
    expect(all).not.toContain('Head torch');
  });

  it('suggests the shop with the most on the list', async () => {
    const s = await core.shopping.summary();
    expect(s.shops.find((x) => x.shop.id === aldi)?.count).toBe(2);
    expect([aldi, tesco]).toContain(s.suggestedShopId);
    expect(s.unassigned).toBe(0);
  });

  it('suggests how many to buy and groups by category', async () => {
    const list = await core.shopping.forShop(tesco);
    expect(list.groups.map((g) => g.category?.name)).toEqual(['Household', 'Pets']);
    expect(list.groups[1]?.items[0]?.quantity).toBe(4);
  });

  it('buying ticks things off by adding them to stock', async () => {
    const list = await core.shopping.forShop(aldi);
    const bananas = list.groups[0]!.items[0]!.summary.product.id;
    await core.shopping.purchase({ shopId: aldi, items: [{ productId: bananas, quantity: 1, price: 0.89 }] });
    expect(await names(aldi)).toEqual(['Kitchen roll']);
    expect(core.events.log.some((e) => e.type === 'shopping.purchased')).toBe(true);
  });

  it('a shopping trip goes into stock all at once, or not at all', async () => {
    const list = await core.shopping.forShop(aldi);
    const bananas = list.groups[0]!.items[0]!.summary.product.id;
    await expect(core.shopping.purchase({ shopId: aldi, items: [{ productId: bananas, quantity: 2 }, { productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] })).rejects.toThrow();
    expect((await core.products.summary(bananas)).inStock).toBe(0);
    expect(core.events.log.some((e) => e.type === 'shopping.purchased')).toBe(false);

    const bought = await core.shopping.purchase({ shopId: aldi, items: [{ productId: bananas, quantity: 2 }, { productId: bananas, quantity: 1 }] });
    expect(bought).toHaveLength(1);
    expect(bought[0]?.inStock).toBe(3);
  });

  it('includes things put on the list by hand', async () => {
    const food = await category(core, 'Food');
    const p = await core.products.create({ name: 'Ketchup', categoryId: food.id });
    await core.products.setOnList(p.id, true);
    expect(await names(tesco)).toContain('Ketchup');
  });
});

describe('search', () => {
  let core: TestCore;
  beforeEach(async () => {
    core = await makeCore();
    const shed = await core.places.create({ name: 'Shed shelves', code: 'S2-3' });
    const household = await category(core, 'Household');
    await core.shops.addPreset('Aldi');
    await core.products.create({ name: 'Toilet roll', aliases: ['loo roll', 'bog roll'], categoryId: household.id, minQuantity: 9 });
    const drill = await core.products.create({ name: 'Cordless drill', notes: 'Makita 18 V', defaultPlaceId: shed.id });
    await core.stock.add({ productId: drill.id, quantity: 1 });
    await core.products.create({ name: 'Power bank', wish: true });
  });

  const sectionIds = async (q: string) => (await core.search.query(q)).map((s) => s.id);
  const titles = async (q: string, section = 'stock') => (await core.search.query(q)).find((s) => s.id === section)?.results.map((r) => r.title) ?? [];

  it('matches aliases, typos and prefixes', async () => {
    expect(await titles('bog rol')).toEqual(['Toilet roll']);
    expect(await titles('toilt')).toEqual(['Toilet roll']);
    expect(await titles('cordl')).toEqual(['Cordless drill']);
    expect(await titles('makita')).toEqual(['Cordless drill']);
  });

  it('puts results into sections', async () => {
    expect(await sectionIds('loo')).toEqual(['stock', 'shopping']);
    expect(await titles('S2-3', 'places')).toEqual(['S2-3 · Shed shelves']);
    expect(await titles('S2-3')).toEqual(['Cordless drill']);
    expect(await sectionIds('power')).toEqual(['wish']);
    expect(await sectionIds('aldi')).toEqual(['shops']);
  });

  it('names every shop a list item is on', async () => {
    await core.shops.addPreset('Tesco');
    await core.shops.addPreset("Sainsbury's");
    const loo = (await core.search.query('toilet')).find((s) => s.id === 'shopping')?.results[0];
    expect(loo?.subtitle).toBe("On your Aldi, Tesco and Sainsbury's lists");
  });

  it('notices changes without a manual rebuild', async () => {
    expect(await titles('kerosene')).toEqual([]);
    await core.products.create({ name: 'Heating oil', aliases: ['kerosene'] });
    expect(await titles('kerosene')).toEqual(['Heating oil']);
  });

  it('shows recent items before anything is typed', async () => {
    const r = await core.search.query('');
    expect(r[0]?.id).toBe('recent');
    expect(r[0]?.results[0]?.title).toBe('Cordless drill');
  });

  it('lets modules add their own section', async () => {
    const withModule = await makeCore({
      modules: [
        defineModule({
          id: 'scenarios-demo', name: 'Scenarios demo', description: 'Test', version: '1.0.0',
          setup(ctx) {
            ctx.addSearchSection({
              id: 'scenarios-demo', title: 'Scenarios', order: 40,
              documents: async () => [{ id: 'scenarios-demo:1', type: 'scenarios-demo', refId: '1', title: 'Power cut', keywords: ['torch', 'candles'] }],
              results: async (_q, hits) => hits.map((h) => ({ type: 'scenario', id: h.refId, title: 'Power cut', subtitle: '', href: `/scenarios/${h.refId}` })),
            });
          },
        }),
      ],
    });
    expect((await withModule.search.query('candles')).map((s) => s.title)).toEqual(['Scenarios']);
    await withModule.modules.setEnabled('scenarios-demo', false);
    expect(await withModule.search.query('candles')).toEqual([]);
  });
});

describe('lookup', () => {
  it('identifies products by barcode, places by code, and remembers unknown barcodes', async () => {
    const calls: string[] = [];
    const core = await makeCore({
      modules: [
        defineModule({
          id: 'fake-lookup', name: 'Fake lookup', description: 'Test', version: '1.0.0',
          setup(ctx) {
            ctx.addLookupProvider({
              id: 'fake', name: 'Fake Facts',
              async lookup(barcode) {
                calls.push(barcode);
                return barcode === '5000157024671' ? { name: 'Baked Beanz', brand: 'Heinz', quantityText: '415 g', imageUrl: null, categories: ['Canned'] } : null;
              },
            });
          },
        }),
      ],
    });
    const place = await core.places.create({ name: 'Box', code: 'G2-4' });
    expect((await core.lookup.identify('g2-4')).kind).toBe('place');
    expect((await core.lookup.identify(`larder:place:${place.id}`)).kind).toBe('place');

    const beans = await core.products.create({ name: 'Baked beans' });
    const r1 = await core.lookup.identify('5000157024671');
    expect(r1.kind).toBe('external');
    if (r1.kind === 'external') {
      expect(r1.result).toMatchObject({ name: 'Baked Beanz', brand: 'Heinz', provider: 'fake' });
      expect(r1.suggestions[0]?.product.id).toBe(beans.id);
    }
    await core.lookup.identify('5000157024671');
    expect(calls).toEqual(['5000157024671']); // cached

    const miss = await core.lookup.identify('4088600214568');
    expect(miss).toMatchObject({ kind: 'unknown', providersTried: ['Fake Facts'] });
    await core.lookup.identify('4088600214568');
    expect(calls).toHaveLength(2); // misses are remembered for a while too

    const { product, variant } = await core.lookup.remember({ barcode: '4088600214568', create: { name: 'Chopped tomatoes', unit: 'tin' }, variantName: 'Aldi chopped tomatoes 400 g' });
    expect(variant.barcodes).toEqual(['4088600214568']);
    const r2 = await core.lookup.identify('4088600214568');
    expect(r2.kind === 'product' && r2.product.product.id).toBe(product.product.id);

    await core.modules.setEnabled('fake-lookup', false);
    expect(await core.lookup.identify('9999999999998')).toMatchObject({ kind: 'unknown', providersTried: [], providersFailed: [] });
    expect((await core.lookup.identify('9999999999999')).kind).toBe('unknown');
    expect(calls).toHaveLength(2);
  });
});

describe('lookup when providers are down', () => {
  it("says they couldn't be reached and doesn't cache the miss", async () => {
    let up = false;
    const core = await makeCore({
      modules: [
        defineModule({
          id: 'flaky', name: 'Flaky', description: 'Test', version: '1.0.0',
          setup(ctx) {
            ctx.addLookupProvider({ id: 'flaky', name: 'Flaky Facts', async lookup() {
              if (!up) throw new Error('offline');
              return { name: 'Beans', brand: null, quantityText: null, imageUrl: null, categories: [] };
            } });
          },
        }),
      ],
    });
    expect(await core.lookup.identify('5000157024671')).toMatchObject({ kind: 'unknown', providersTried: [], providersFailed: ['Flaky Facts'] });
    up = true;
    expect((await core.lookup.identify('5000157024671')).kind).toBe('external');
  });
});

describe('modules', () => {
  it('validates module product fields and runs event handlers only while switched on', async () => {
    const { z } = await import('zod');
    const seen: string[] = [];
    const core = await makeCore({
      modules: [
        defineModule({
          id: 'notes-plus', name: 'Notes plus', description: 'Test', version: '1.0.0',
          productFields: z.object({ colour: z.enum(['red', 'blue']) }),
          setup(ctx) {
            ctx.on('product.*', (e) => {
              seen.push(e.type);
            });
          },
        }),
      ],
    });
    await expect(core.products.create({ name: 'Bad', fields: { 'notes-plus': { colour: 'green' } } })).rejects.toThrow('Notes plus');
    const p = await core.products.create({ name: 'Good', fields: { 'notes-plus': { colour: 'red' } } });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['product.created']);
    await core.modules.setEnabled('notes-plus', false);
    await core.products.update(p.id, { notes: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['product.created']);
  });
});

describe('home', () => {
  it('sums up what needs attention', async () => {
    const core = await makeCore();
    const fridge = await core.places.create({ name: 'Fridge' });
    const shed = await core.places.create({ name: 'Shed' });
    const spinach = await core.products.create({ name: 'Spinach', shelfLifeDays: 1, defaultPlaceId: fridge.id });
    await core.stock.add({ productId: spinach.id, quantity: 1 });
    await core.products.create({ name: 'AAA', minQuantity: 8 });
    const drill = await core.products.create({ name: 'Drill', defaultPlaceId: shed.id });
    await core.stock.add({ productId: drill.id, quantity: 1 });
    await core.stock.move({ productId: drill.id, toPlaceId: fridge.id });
    await core.stock.expect({ productId: drill.id, quantity: 1, source: 'Toolstation' });
    const d = await core.home.dashboard();
    expect(d.counts).toMatchObject({ expiringSoon: 1, low: 1, outOfPlace: 1, expected: 1 });
    expect(d.deliveries[0]?.source).toBe('Toolstation');
    expect(d.expiringSoon[0]?.daysToExpiry).toBe(1);
  });
});
