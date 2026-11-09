import { describe, expect, it } from 'vitest';
import { makeCore, saveAs092 } from '../../tests/helpers';
import { builtInUnits as units } from '@larder/core';
import pricing, { checkPrice, type PriceView } from './index';
import { factorOrNull, measureFactor, priceFactor, priceKey } from './units';

const call = (core: Awaited<ReturnType<typeof makeCore>>, method: string, path: string, body: unknown, params: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'pricing' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params, userId: null });

describe('pricing module', () => {
  it('compares a different pack with the usual unit price', async () => {
    const core = await makeCore({ modules: [pricing] });
    const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
    await call(core, 'PUT', '/usual', { productId: loo.id, quantity: 9, price: 3.25, basedOn: 'Andrex 9 pack at Tesco' });
    const r = (await call(core, 'POST', '/check', { productId: loo.id, quantity: 24, price: 8 })) as ReturnType<typeof checkPrice>;
    expect(r.verdict).toBe('cheaper');
    expect(r.unitPrice).toBeCloseTo(0.3333, 3);
    expect(r.message).toBe("That's £0.333 a roll against the usual £0.361: 8% cheaper, saving about £0.67 on this pack.");
  });

  it('says when there is no usual price and treats 2% either way as the same', async () => {
    const core = await makeCore({ modules: [pricing] });
    // Bought loose, by the litre: kept in ml, priced per 100 ml or per litre.
    const milk = await core.products.create({ name: 'Milk', unit: 'L' });
    const none = (await call(core, 'POST', '/check', { productId: milk.id, quantity: 4, unit: 'litres', price: 1.65 })) as ReturnType<typeof checkPrice>;
    expect(none.verdict).toBe('no_usual_price');
    await call(core, 'PUT', '/usual', { productId: milk.id, unitPrice: 0.4125, unit: 'litre' });
    const same = (await call(core, 'POST', '/check', { productId: milk.id, quantity: 2.27, unit: 'L', price: 0.95 })) as ReturnType<typeof checkPrice>;
    expect(same).toMatchObject({ verdict: 'same', per: 'per 100 ml' });
  });

  it('records prices paid at the till and uses the first as the usual price', async () => {
    const core = await makeCore({ modules: [pricing] });
    const beans = await core.products.create({ name: 'Beans', unit: 'tin' });
    await core.shopping.purchase({ items: [{ productId: beans.id, quantity: 4, price: 2 }] });
    await new Promise((r) => setTimeout(r, 10));
    const s = await core.products.summary(beans.id);
    expect((s.product.fields.pricing as { usualUnitPrice: number }).usualUnitPrice).toBe(0.5);
    const history = (await call(core, 'GET', '/history/:productId', undefined, { productId: beans.id })) as unknown[];
    expect(history).toHaveLength(1);
  });

  it('rejects bad pricing data on products', async () => {
    const core = await makeCore({ modules: [pricing] });
    await expect(core.products.create({ name: 'X', fields: { pricing: { usualUnitPrice: -1 } } })).rejects.toThrow('Unit pricing');
  });

  it('converts between per item, per 100 g and per kg through the core converter', () => {
    const bag = { name: 'Baby spinach', unit: 'bag', contents: null, weight: null };
    expect(priceKey(units, bag, '100 g')).toBe('100g');
    expect(priceKey(units, bag, '100 grams')).toBe('100g');
    expect(priceKey(units, bag, 'per Kilogram')).toBe('kg');
    expect(priceKey(units, bag, 'Litres')).toBe('l');
    expect(priceKey(units, bag, 'each')).toBe('bag');
    expect(priceKey(units, bag, 'batteries')).toBe('battery');
    expect(measureFactor(units, 'kg', '100g')).toBeCloseTo(0.1);
    expect(measureFactor(units, 'l', '100ml')).toBeCloseTo(0.1);
    // A bag needs its Weight before it can be compared by weight.
    expect(factorOrNull(units, bag, 'bag', 'kg')).toBeNull();
    expect(priceFactor(units, { ...bag, weight: { amount: 200, unit: 'g' } }, 'bag', 'kg')).toBeCloseTo(5);
    expect(() => measureFactor(units, 'kg', 'ml')).toThrow("A price by weight can't be compared with a price by volume.");
  });

  it('shows the usual price per the chosen unit, asking for the bag size when it needs it', async () => {
    const core = await makeCore({ modules: [pricing] });
    const spinach = await core.products.create({ name: 'Baby spinach', unit: 'bag' });
    await call(core, 'PUT', '/usual', { productId: spinach.id, quantity: 1, price: 1.1 });
    let view = (await call(core, 'GET', '/view/:productId', undefined, { productId: spinach.id })) as PriceView;
    expect(view.usual).toEqual({ price: 1.1, unit: 'bag', per: '£1.10 a bag' });
    expect(view.options.map((o) => [o.unit, o.needsSize])).toEqual([['bag', false], ['100g', true], ['kg', true], ['100ml', true], ['l', true]]);
    // Asking for per kg before the size is known keeps showing per bag.
    view = (await call(core, 'PUT', '/display', { productId: spinach.id, showPer: 'kg' })) as PriceView;
    expect(view.showPer).toBe('bag');
    view = (await call(core, 'PUT', '/display', { productId: spinach.id, itemSize: { amount: 200, unit: 'g' } })) as PriceView;
    expect(view.usual).toEqual({ price: 5.5, unit: 'kg', per: '£5.50 a kg' });
    expect(view.options.map((o) => o.per)).toEqual(['a bag', 'per 100 g', 'a kg']);
    expect(view.options.find((o) => o.unit === '100g')?.price).toBeCloseTo(0.55);

    // A shelf price per kg, and a bigger bag by weight, are compared in the chosen unit.
    const shelf = (await call(core, 'POST', '/check', { productId: spinach.id, quantity: 1, unit: 'kg', price: 4.4 })) as ReturnType<typeof checkPrice>;
    expect(shelf.message).toBe("That's £4.40 a kg against the usual £5.50: 20% cheaper, saving about £1.10 on this pack.");
    const big = (await call(core, 'POST', '/check', { productId: spinach.id, quantity: 500, unit: 'g', price: 2.5 })) as ReturnType<typeof checkPrice>;
    expect(big).toMatchObject({ verdict: 'cheaper', per: 'a kg' });
    expect(big.unitPrice).toBeCloseTo(5);
  });

  it('things counted by weight are priced per 100 g or per kg, without a size', async () => {
    const core = await makeCore({ modules: [pricing] });
    const cheddar = await core.products.create({ name: 'Mature cheddar', unit: 'g' });
    await call(core, 'PUT', '/usual', { productId: cheddar.id, quantity: 400, price: 3.8 });
    const view = (await call(core, 'GET', '/view/:productId', undefined, { productId: cheddar.id })) as PriceView;
    expect(view.usual?.per).toBe('£0.95 per 100 g');
    expect(view.itemUnit).toBeNull();
    expect(view.packUnits).toEqual(['g', 'kg']);
    await expect(call(core, 'PUT', '/display', { productId: cheddar.id, weight: { amount: 1, unit: 'kg' } })).rejects.toThrow('Mature cheddar is bought loose, in g, so it has no Weight');
  });

  it('gives assistants a unit for prices, a converter, and the item size', async () => {
    const core = await makeCore({ modules: [pricing] });
    await core.products.create({ name: 'Baby spinach', unit: 'bag' });
    expect((await core.assistant.call('convert_price', { price: 3.5, per: 'kg', to: '100 g' })).text).toBe('£3.50 a kg is £0.35 per 100 g.');
    await expect(core.assistant.call('convert_price', { price: 1.1, per: 'bag', to: 'kg' })).rejects.toThrow('Say which item');
    await expect(core.assistant.call('convert_price', { price: 1.1, per: 'bag', to: 'kg', item: 'baby spinach' })).rejects.toThrow("Larder doesn't know what one bag of Baby spinach weighs, so it can't work in kg.");
    expect((await core.assistant.call('change_item', { item: 'baby spinach', contains: { amount: 200, unit: 'g' } })).text).toContain('Baby spinach is updated: each bag contains 200 g.');
    expect((await core.assistant.call('convert_price', { price: 1.1, per: 'bag', to: 'kg', item: 'baby spinach' })).text).toBe('£1.10 a bag is £5.50 a kg.');
    // A usual price per 100 g, then a pack per kg at the shop.
    expect((await core.assistant.call('set_usual_price', { item: 'baby spinach', quantity: 100, unit: 'g', price: 0.6 })).text).toBe('The usual price for Baby spinach is now £1.20 a bag.');
    expect((await core.assistant.call('check_price', { item: 'baby spinach', quantity: 1, unit: 'kg', price: 5 })).text).toBe("That's £1.00 a bag against the usual £1.20: 17% cheaper, saving about £1.00 on this pack.");
  });

  it('keeps a price per kg for a bag of unknown size until the size is known', async () => {
    const core = await makeCore({ modules: [pricing] });
    const spinach = await core.products.create({ name: 'Baby spinach', unit: 'bag' });
    const fields = await call(core, 'PUT', '/usual', { productId: spinach.id, unitPrice: 6, unit: 'kg' });
    expect(fields).toMatchObject({ usualUnitPrice: 6, priceUnit: 'kg' });
    // Shown per 100 g (a bag can't be worked out yet).
    const view = (await call(core, 'GET', '/view/:productId', undefined, { productId: spinach.id })) as PriceView;
    expect(view.usual).toEqual({ price: 0.6, unit: '100g', per: '£0.60 per 100 g' });
    await expect(call(core, 'POST', '/check', { productId: spinach.id, quantity: 1, price: 1 })).rejects.toThrow("Larder doesn't know what one bag of Baby spinach weighs");
    await expect(call(core, 'PUT', '/usual', { productId: spinach.id, unitPrice: 1, unit: 'box' })).rejects.toThrow('Baby spinach is bought in bags. Give how many bags.');
    await expect(call(core, 'PUT', '/usual', { productId: spinach.id, unitPrice: 1, unit: 'sleeve' })).rejects.toThrow('Larder doesn\'t have the unit "sleeve".');
  });

  it('prices an item bought in boxes by the box, by the tea bag, or per 100 g through its Weight', async () => {
    const core = await makeCore({ modules: [pricing] });
    const tea = await core.products.create({ name: 'Tea bags', unit: 'box', contents: { amount: 80, unit: 'tea bag' } });
    const fields = await call(core, 'PUT', '/usual', { productId: tea.id, quantity: 1, unit: 'box', price: 4 });
    expect(fields).toMatchObject({ usualUnitPrice: 4, priceUnit: null });
    const view = (await call(core, 'GET', '/view/:productId', undefined, { productId: tea.id })) as PriceView;
    expect(view.options.map((o) => [o.unit, o.price])).toEqual([['box', 4], ['tea bag', 0.05], ['100g', null], ['kg', null], ['100ml', null], ['l', null]]);
    expect(view.packUnits).toEqual(['box', 'tea bag', 'g', 'kg', 'ml', 'cl', 'l', 'pint']);
    // A box of 80 for £3.20 at the shop, or 40 loose for £2.40.
    let r = (await call(core, 'POST', '/check', { productId: tea.id, quantity: 1, price: 3.2 })) as ReturnType<typeof checkPrice>;
    expect(r.message).toBe("That's £3.20 a box against the usual £4.00: 20% cheaper, saving about £0.80 on this pack.");
    r = (await call(core, 'POST', '/check', { productId: tea.id, quantity: 40, unit: 'tea bags', price: 2.4 })) as ReturnType<typeof checkPrice>;
    expect(r.verdict).toBe('dearer');
    expect((await core.assistant.call('convert_price', { price: 4, per: 'box', to: 'tea bag', item: 'tea bags' })).text).toBe('£4.00 a box is £0.05 a tea bag.');
    // A box weighs 250 g: £4 a box is £1.60 per 100 g.
    await core.assistant.call('change_item', { item: 'tea bags', weight: { amount: 250, unit: 'g' } });
    expect((await core.assistant.call('get_price', { item: 'tea bags' })).text).toBe('Tea bags: usually £4.00 a box, £0.05 a tea bag, £1.60 per 100 g, £16.00 a kg.');
    await expect(call(core, 'POST', '/check', { productId: tea.id, quantity: 1, unit: 'sleeve', price: 3 })).rejects.toThrow('Larder doesn\'t have the unit "sleeve".');
    // A Weight from Contains is changed there, not on the price card.
    const decaf = await core.products.create({ name: 'Decaf coffee', unit: 'jar', contents: { amount: 400, unit: 'g' } });
    expect(((await call(core, 'GET', '/view/:productId', undefined, { productId: decaf.id })) as PriceView)).toMatchObject({ weight: { amount: 400, unit: 'g' }, weightEditable: false, itemUnit: 'jar' });
  });

  it('rescales its prices and moves its weight when the upgrade turns a pack round', async () => {
    const storage = (await import('../../src/adapters/storage-memory')).createMemoryStorage();
    const before = await makeCore({ modules: [pricing], storage });
    const sleep = await before.products.create({ name: 'Sleep tea', unit: 'tea bag' });
    await before.shopping.purchase({ items: [{ productId: sleep.id, quantity: 40, price: 6 }] });
    await new Promise((r) => setTimeout(r, 10));
    // 0.9.2: counted in tea bags, in boxes of 20, and the price card knew a tea bag weighs 1.5 g.
    const p = (await before.products.summary(sleep.id)).product;
    await saveAs092(storage, { ...p, fields: { pricing: { ...(p.fields.pricing as object), itemSize: { amount: 1.5, unit: 'g' } } } }, { unit: 'tea bag', pack: { name: 'box', holds: 20 } });
    const core = await makeCore({ modules: [pricing], storage });
    await new Promise((r) => setTimeout(r, 10));
    // The weight moved to the item before the upgrade, so it's a box's now; the module's prices are per box.
    const after = (await core.products.summary(sleep.id)).product;
    expect([after.unit, after.weight, (after.fields.pricing as { usualUnitPrice: number; itemSize: unknown }).usualUnitPrice, (after.fields.pricing as { itemSize: unknown }).itemSize]).toEqual(['box', { amount: 30, unit: 'g' }, 3, null]);
    const history = (await call(core, 'GET', '/history/:productId', undefined, { productId: sleep.id })) as Array<{ quantity: number; unitPrice: number }>;
    expect(history.map((h) => [h.quantity, h.unitPrice])).toEqual([[2, 3]]);
    expect((await core.assistant.call('get_price', { item: 'sleep tea' })).text).toContain('£3.00 a box');
  });

  it('drops measures saved by 0.8, and moves the weight to the item', async () => {
    const storage = (await import('../../src/adapters/storage-memory')).createMemoryStorage();
    const old = await makeCore({ storage });
    const chicken = await old.products.create({ name: 'Chicken breasts', unit: 'pack', fields: { pricing: { usualUnitPrice: 6, itemSize: { amount: 1, unit: 'kg' }, measures: [{ unit: 'items', amount: 5, price: null }, { unit: 'kg', amount: 1, price: 5.5 }] } } });
    // No usual price, but one for each item: £1.20 an item, 5 to a pack, is £6 a pack.
    const eggs = await old.products.create({ name: 'Eggs', unit: 'box', fields: { pricing: { measures: [{ unit: 'egg', amount: 6, price: 0.3 }] } } });
    const flour = await old.products.create({ name: 'Flour', unit: 'bag', fields: { pricing: { itemSize: { amount: 1.5, unit: 'kg' }, measures: [{ unit: 'kg', amount: 1.5, price: 0.8 }] } } });
    const core = await makeCore({ storage, modules: [pricing] });
    await new Promise((r) => setTimeout(r, 10));
    const fields = async (id: string) => (await core.products.summary(id)).product.fields.pricing as Record<string, unknown>;
    const p = await fields(chicken.id);
    expect(p).toMatchObject({ usualUnitPrice: 6, itemSize: null });
    expect('measures' in p).toBe(false);
    // 0.10.0: what one weighs is the item's, so how fast it's used can be said by weight too.
    expect((await core.products.summary(chicken.id)).product.weight).toEqual({ amount: 1000, unit: 'g' });
    expect(await fields(eggs.id)).toMatchObject({ usualUnitPrice: 1.8, priceUnit: null });
    expect(await fields(flour.id)).toMatchObject({ usualUnitPrice: 0.8, priceUnit: 'kg' });
    expect((await core.assistant.call('get_price', { item: 'flour' })).text).toContain('£1.20 a bag');
  });
});
