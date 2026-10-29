import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModule } from '@larder/core';
import { makeCore, category, type TestCore } from '../helpers';

describe('resolving names', () => {
  let core: TestCore;
  beforeEach(async () => {
    core = await makeCore();
    const garage = await core.places.create({ name: 'Garage' });
    await core.places.create({ name: 'Racking', parentId: garage.id, code: 'G2-4' });
    await core.places.create({ name: 'Kitchen' });
    await core.shops.addPreset("Sainsbury's");
    await core.shops.addPreset('Screwfix');
    await core.shops.create({ name: 'Superdrug' });
    const loo = await core.products.create({ name: 'Toilet roll', aliases: ['loo roll', 'bog roll'] });
    await core.products.addVariant(loo.id, { name: 'Andrex 9 pack', barcodes: ['5029053038889'] });
    await core.products.create({ name: 'AA batteries' });
    await core.products.create({ name: 'AAA batteries' });
    await core.products.create({ name: 'Cordless drill' });
  });

  it('finds items by name, alias, plural, barcode, id and typo', async () => {
    expect((await core.resolve.product('toilet roll')).name).toBe('Toilet roll');
    expect((await core.resolve.product('Loo Rolls')).name).toBe('Toilet roll');
    expect((await core.resolve.product('5029053038889')).name).toBe('Toilet roll');
    const drill = await core.resolve.product('cordless drill');
    expect((await core.resolve.product(drill.id)).id).toBe(drill.id);
    expect((await core.resolve.product('cordles dril')).name).toBe('Cordless drill');
  });

  it('refuses to guess between close matches, and lists them', async () => {
    await expect(core.resolve.product('batteries')).rejects.toMatchObject({ code: 'ambiguous', candidates: expect.arrayContaining(['AA batteries', 'AAA batteries']) });
    expect((await core.resolve.product('aaa batteries')).name).toBe('AAA batteries');
    await expect(core.resolve.product('unicorn')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('finds places by code, name and path, and shops by loose name', async () => {
    expect((await core.resolve.place('g2-4')).name).toBe('Racking');
    expect((await core.resolve.place('Garage › Racking')).code).toBe('G2-4');
    expect((await core.resolve.place('garage > racking')).code).toBe('G2-4');
    expect((await core.resolve.place('kitchen')).name).toBe('Kitchen');
    expect((await core.resolve.shop('sainsburys')).name).toBe("Sainsbury's");
    expect((await core.resolve.shop('screw')).name).toBe('Screwfix');
    await expect(core.resolve.shop('s')).rejects.toMatchObject({ code: 'ambiguous' });
  });
});

describe('automation sensors and actions', () => {
  let core: TestCore;
  beforeEach(async () => {
    core = await makeCore();
    await core.shops.addPreset('Aldi');
    const household = await category(core, 'Household');
    const garage = await core.places.create({ name: 'Garage', code: 'G1' });
    await core.places.create({ name: 'Kitchen' });
    await core.products.create({ name: 'Kitchen roll', categoryId: household.id, minQuantity: 2, unit: 'roll' });
    const drill = await core.products.create({ name: 'Cordless drill', defaultPlaceId: garage.id });
    await core.stock.add({ productId: drill.id, quantity: 1 });
  });

  it('reads the core sensors', async () => {
    const ids = core.automation.sensors().map((s) => s.id);
    expect(ids).toEqual(['low_stock', 'expiring_soon', 'out_of_place', 'shopping_list', 'deliveries']);
    const state = await core.automation.read();
    expect(state.low_stock).toMatchObject({ state: 1, attributes: { items: [{ item: 'Kitchen roll', in_stock: 0, minimum: 2, unit: 'roll' }] } });
    expect(state.shopping_list).toMatchObject({ state: 1, attributes: { suggested_shop: 'Aldi', shops: { Aldi: 1 } } });
    expect(state.out_of_place?.state).toBe(0);
  });

  it('runs actions by name and answers in words', async () => {
    let r = await core.automation.run('add_stock', { item: 'kitchen rolls', quantity: 3 });
    expect(r).toMatchObject({ message: 'Kitchen roll: added 3 rolls. 3 rolls in stock.', in_stock: 3, low: false });
    r = await core.automation.run('use_stock', { item: 'kitchen roll', quantity: 2 });
    expect(r.message).toBe('Kitchen roll: used 2 rolls. 1 roll left, running low.');
    r = await core.automation.run('move_item', { item: 'drill', to: 'kitchen' });
    expect(r.message).toBe('Cordless drill moved to Kitchen.');
    expect((await core.automation.read()).out_of_place?.state).toBe(1);
    r = await core.automation.run('put_back', { item: 'drill' });
    expect(r.message).toBe('Cordless drill is back in Garage.');
    r = await core.automation.run('add_expected', { item: 'kitchen roll', quantity: 6, source: 'Tesco delivery' });
    expect((await core.automation.read()).deliveries?.state).toBe(1);
    r = await core.automation.run('mark_arrived', { source: 'Tesco delivery' });
    expect(r.message).toBe('Arrived: Kitchen roll.');
    r = await core.automation.run('shopping_list_for', { shop: 'aldi' });
    expect(r.message).toBe('Nothing to get at Aldi.');
    r = await core.automation.run('find_item', { item: 'kitchen roll' });
    expect(r.message).toBe('Kitchen roll: 7 rolls in stock.');
  });

  it('describes action fields as JSON Schema with defaults', () => {
    const add = core.automation.actions().find((a) => a.id === 'add_stock')!;
    expect(add.schema).toMatchObject({ type: 'object', required: ['item'], properties: { quantity: { type: 'number', default: 1 }, expires_on: { type: 'string' } } });
  });

  it('rejects bad input and unknown actions with readable messages', async () => {
    await expect(core.automation.run('add_stock', { quantity: 2 })).rejects.toThrow('Add stock: item');
    await expect(core.automation.run('launch_rocket', {})).rejects.toMatchObject({ status: 404 });
  });

  it('lets modules add sensors and actions, prefixed by the module id and hidden while off', async () => {
    const withModule = await makeCore({
      modules: [defineModule({
        id: 'pet-food', name: 'Pet food', description: 'Test', version: '1.0.0',
        setup(ctx) {
          ctx.addSensor({ id: 'pet_food_days', name: 'Days of dog food', description: 'x', async read() { return { state: 12 }; } });
          ctx.addAction({ id: 'pet_food_fed', name: 'Fed the dog', description: 'x', input: z.object({ grams: z.number() }), async run(i) { return { message: `Fed ${i.grams} g` }; } });
        },
      })],
    });
    expect((await withModule.automation.read()).pet_food_days).toEqual({ state: 12 });
    expect((await withModule.automation.run('pet_food_fed', { grams: 200 })).message).toBe('Fed 200 g');
    await withModule.modules.setEnabled('pet-food', false);
    expect(withModule.automation.sensors().some((s) => s.id === 'pet_food_days')).toBe(false);
    await expect(withModule.automation.run('pet_food_fed', { grams: 1 })).rejects.toMatchObject({ status: 404 });

    // A module can't take over a core sensor: its setup fails (and is logged) and the core one stays.
    const rogue = await makeCore({ modules: [defineModule({ id: 'rogue', name: 'Rogue', description: 'x', version: '1', setup(ctx) { ctx.addSensor({ id: 'low_stock', name: 'x', description: 'x', async read() { return { state: 0 }; } }); } })] });
    expect(rogue.automation.sensors().filter((s) => s.id === 'low_stock')).toEqual([expect.objectContaining({ module: null, name: 'Running low' })]);
  });
});

describe('expiry events', () => {
  it('announces each item once when it becomes due, and again when it expires', async () => {
    const core = await makeCore();
    const fridge = await core.places.create({ name: 'Fridge' });
    const milk = await core.products.create({ name: 'Milk', shelfLifeDays: 5, defaultPlaceId: fridge.id });
    await core.stock.add({ productId: milk.id, quantity: 1 });
    await core.products.create({ name: 'Rice', shelfLifeDays: 365 });

    expect(await core.automation.checkExpiry()).toEqual({ expiring: 1, expired: 0 });
    expect(await core.automation.checkExpiry()).toEqual({ expiring: 0, expired: 0 });
    const ev = core.events.log.find((e) => e.type === 'stock.expiring');
    expect(ev?.data).toMatchObject({ name: 'Milk', expiresOn: '2026-11-02', daysToExpiry: 5, place: 'Fridge' });

    core.clock.set('2026-11-02T08:00:00.000Z');
    expect(await core.automation.checkExpiry()).toEqual({ expiring: 0, expired: 1 });
    expect(await core.automation.checkExpiry()).toEqual({ expiring: 0, expired: 0 });

    // Fresh stock is a new expiry date, so it's announced again when it's due.
    await core.stock.use({ productId: milk.id, quantity: 1 });
    await core.stock.add({ productId: milk.id, quantity: 1 });
    core.clock.set('2026-11-05T08:00:00.000Z');
    expect(await core.automation.checkExpiry()).toEqual({ expiring: 1, expired: 0 });
  });
});

describe('NFC tags', () => {
  it('offers unknown tags for linking, then resolves them', async () => {
    const core = await makeCore();
    const box = await core.places.create({ name: 'Camping box', code: 'G2-4' });
    const drill = await core.products.create({ name: 'Cordless drill' });

    const first = await core.nfc.scanned({ tagId: '04:A2:19:B2', device: "Shaun's phone" });
    expect(first).toMatchObject({ kind: 'unknown', device: "Shaun's phone" });
    expect((await core.nfc.recent()).map((r) => r.tagId)).toEqual(['04:A2:19:B2']);

    await core.nfc.link({ tagId: '04:A2:19:B2', placeId: box.id });
    expect(await core.nfc.scanned({ tagId: '04:A2:19:B2' })).toMatchObject({ kind: 'place', name: 'Camping box', path: 'Camping box' });
    expect((await core.lookup.identify('04:A2:19:B2')).kind).toBe('place');
    expect(core.events.log.filter((e) => e.type === 'nfc.scanned')).toHaveLength(2);

    await expect(core.nfc.link({ tagId: '04:A2:19:B2', productId: drill.id })).rejects.toThrow('already linked to Camping box');
    expect(await core.nfc.unlink('04:A2:19:B2')).toEqual({ unlinked: true });
    await core.nfc.link({ tagId: '04:A2:19:B2', productId: drill.id });
    expect((await core.resolve.product('04:A2:19:B2')).name).toBe('Cordless drill');

    core.clock.set('2026-10-28T10:00:00.000Z');
    expect(await core.nfc.recent()).toEqual([]);
  });
});
