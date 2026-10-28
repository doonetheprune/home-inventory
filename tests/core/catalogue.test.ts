import { beforeEach, describe, expect, it } from 'vitest';
import { makeCore, category, type TestCore } from '../helpers';

describe('places', () => {
  let core: TestCore;
  beforeEach(async () => {
    core = await makeCore();
  });

  it('builds a nested tree with item counts', async () => {
    const garage = await core.places.create({ name: 'Garage' });
    const freezer = await core.places.create({ name: 'Chest freezer', parentId: garage.id });
    const drawer = await core.places.create({ name: 'Top drawer', parentId: freezer.id, code: 'CF-1' });
    const peas = await core.products.create({ name: 'Peas' });
    await core.stock.add({ productId: peas.id, quantity: 2, placeId: drawer.id });
    const tree = await core.places.tree();
    expect(tree[0]?.place.name).toBe('Garage');
    expect(tree[0]?.itemCount).toBe(1);
    expect(tree[0]?.children[0]?.children[0]?.path).toBe('Garage › Chest freezer › Top drawer');
  });

  it('creates a grid of shelves and boxes with short codes', async () => {
    const garage = await core.places.create({ name: 'Garage' });
    const { container, places } = await core.places.createGrid({ parentId: garage.id, name: 'Garage racking', prefix: 'g', rows: 4, columns: 6 });
    expect(places).toHaveLength(24);
    expect(places[0]?.code).toBe('G1-1');
    expect(places.at(-1)?.code).toBe('G4-6');
    expect(places.find((p) => p.code === 'G2-4')?.name).toBe('Shelf 2, box 4');
    expect(container.notes).toContain('G1-1 to G4-6');
    await expect(core.places.createGrid({ parentId: garage.id, name: 'Again', prefix: 'G', rows: 1, columns: 1 })).rejects.toThrow('already used');
  });

  it('refuses duplicate codes and places inside themselves', async () => {
    const a = await core.places.create({ name: 'A', code: 'A1' });
    await expect(core.places.create({ name: 'B', code: 'a1' })).rejects.toThrow('already used');
    const b = await core.places.create({ name: 'B', parentId: a.id });
    await expect(core.places.update(a.id, { parentId: b.id })).rejects.toThrow('inside itself');
  });

  it('only removes empty places and moves children up', async () => {
    const room = await core.places.create({ name: 'Utility' });
    const shelf = await core.places.create({ name: 'Shelf', parentId: room.id });
    const p = await core.products.create({ name: 'Bleach' });
    await core.stock.add({ productId: p.id, quantity: 1, placeId: room.id });
    await expect(core.places.remove(room.id)).rejects.toThrow('still has things');
    await core.stock.move({ productId: p.id, toPlaceId: shelf.id, mode: 'permanent' });
    await core.places.remove(room.id);
    expect((await core.places.get(shelf.id)).parentId).toBeNull();
  });
});

describe('shops and categories', () => {
  let core: TestCore;
  beforeEach(async () => {
    core = await makeCore();
  });

  it('seeds default categories once', async () => {
    const names = (await core.categories.list()).map((c) => c.name);
    expect(names).toContain('Renewals');
    expect(names).toContain('Tools & DIY');
  });

  it('adds preset shops with what they sell', async () => {
    const ts = await core.shops.addPreset('Toolstation');
    const tools = await category(core, 'Tools & DIY');
    expect(ts.sells).toContain(tools.id);
    await expect(core.shops.addPreset('toolstation')).rejects.toThrow('already');
  });

  it('removing a shop removes it from preferred shops', async () => {
    const aldi = await core.shops.addPreset('Aldi');
    const p = await core.products.create({ name: 'Milk', preferredShopIds: [aldi.id] });
    await core.shops.remove(aldi.id);
    expect((await core.products.summary(p.id)).product.preferredShopIds).toEqual([]);
  });

  it("won't remove a category that's in use", async () => {
    const food = await category(core, 'Food');
    await core.products.create({ name: 'Milk', categoryId: food.id });
    await expect(core.categories.remove(food.id)).rejects.toThrow('Move them');
  });
});

describe('products', () => {
  let core: TestCore;
  beforeEach(async () => {
    core = await makeCore();
  });

  it('keeps aliases tidy and rejects duplicate barcodes', async () => {
    const p = await core.products.create({ name: 'Toilet roll', aliases: [' loo roll ', 'toilet roll', 'bog roll', 'loo roll'] });
    expect(p.aliases).toEqual(['loo roll', 'bog roll']);
    await core.products.addVariant(p.id, { name: 'Andrex 9 pack', barcodes: ['5029053038889'] });
    const q = await core.products.create({ name: 'Kitchen roll' });
    await expect(core.products.addVariant(q.id, { name: 'Plenty', barcodes: ['5029053038889'] })).rejects.toThrow('already belongs to Toilet roll');
  });

  it('filters by status', async () => {
    const low = await core.products.create({ name: 'Low thing', minQuantity: 2 });
    await core.products.create({ name: 'Wished', wish: true });
    expect((await core.products.list({ status: 'low' })).map((s) => s.product.id)).toEqual([low.id]);
    expect((await core.products.list({ status: 'wish' })).map((s) => s.product.name)).toEqual(['Wished']);
    expect((await core.products.list()).map((s) => s.product.name)).toEqual(['Low thing']);
  });

  it('removing a product removes its stock and variants', async () => {
    const p = await core.products.create({ name: 'Gone' });
    await core.products.addVariant(p.id, { name: 'Brand', barcodes: ['111111'] });
    await core.stock.add({ productId: p.id, quantity: 1 });
    await core.products.remove(p.id);
    expect(await core.adapters.storage.stock.listByProduct(p.id)).toEqual([]);
    expect(await core.adapters.storage.variants.findByBarcode('111111')).toBeNull();
  });
});
