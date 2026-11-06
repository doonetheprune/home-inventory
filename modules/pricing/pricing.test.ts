import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
import pricing, { checkPrice, type PriceView } from './index';
import { priceFactor, unitKey } from './units';

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
    const milk = await core.products.create({ name: 'Milk', unit: 'L' });
    const none = (await call(core, 'POST', '/check', { productId: milk.id, quantity: 4, price: 1.65 })) as ReturnType<typeof checkPrice>;
    expect(none.verdict).toBe('no_usual_price');
    await call(core, 'PUT', '/usual', { productId: milk.id, unitPrice: 0.4125 });
    const same = (await call(core, 'POST', '/check', { productId: milk.id, quantity: 2.27, price: 0.95 })) as ReturnType<typeof checkPrice>;
    expect(same.verdict).toBe('same');
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

  it('converts between per item, per 100 g and per kg', () => {
    expect(unitKey('100 g')).toBe('100g');
    expect(unitKey('per Kilogram')).toBe('kg');
    expect(unitKey('Litres')).toBe('l');
    expect(unitKey('batteries')).toBe('battery');
    expect(priceFactor('kg', '100g', 'each', null)).toBeCloseTo(0.1);
    expect(priceFactor('l', '100ml', 'bottle', null)).toBeCloseTo(0.1);
    // A bag needs its size before it can be compared by weight.
    expect(priceFactor('bag', 'kg', 'bag', null)).toBeNull();
    expect(priceFactor('bag', 'kg', 'bag', { amount: 200, unit: 'g' })).toBeCloseTo(5);
    expect(priceFactor('kg', 'ml', 'each', null)).toBeNull();
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
    await expect(call(core, 'PUT', '/display', { productId: cheddar.id, itemSize: { amount: 1, unit: 'kg' } })).rejects.toThrow('already counted in g');
  });

  it('gives assistants a unit for prices, a converter, and the item size', async () => {
    const core = await makeCore({ modules: [pricing] });
    await core.products.create({ name: 'Baby spinach', unit: 'bag' });
    expect((await core.assistant.call('convert_price', { price: 3.5, per: 'kg', to: '100 g' })).text).toBe('£3.50 a kg is £0.35 per 100 g.');
    await expect(core.assistant.call('convert_price', { price: 1.1, per: 'bag', to: 'kg' })).rejects.toThrow('Say which item');
    await expect(core.assistant.call('convert_price', { price: 1.1, per: 'bag', to: 'kg', item: 'baby spinach' })).rejects.toThrow("Larder doesn't know how much is in one bag of Baby spinach");
    expect((await core.assistant.call('set_item_size', { item: 'baby spinach', amount: 200, unit: 'g' })).text).toBe('One bag of Baby spinach is 200 g. Its prices can now be compared per 100 g and per kg.');
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
    await expect(call(core, 'POST', '/check', { productId: spinach.id, quantity: 1, price: 1 })).rejects.toThrow('how much is in one bag');
    await expect(call(core, 'PUT', '/usual', { productId: spinach.id, unitPrice: 1, unit: 'box' })).rejects.toThrow('doesn\'t know the unit "box"');
  });

  it('keeps several measures of an item, each with a price, and compares packs by any of them', async () => {
    const core = await makeCore({ modules: [pricing] });
    const chicken = await core.products.create({ name: 'Chicken breasts', unit: 'pack' });
    await call(core, 'PUT', '/usual', { productId: chicken.id, quantity: 1, price: 6 });
    let view = (await call(core, 'PUT', '/measures', { productId: chicken.id, measures: [{ unit: 'items', amount: 5 }, { unit: 'kg', amount: 1 }] })) as PriceView;
    expect(view.measures.map((m) => [m.label, m.per, m.recorded])).toEqual([['1 pack = 1 kg', '£6.00 a kg', false], ['1 pack = 5 items', '£1.20 an item', false]]);
    expect(view.itemSize).toEqual({ amount: 1, unit: 'kg' });
    expect(view.options.map((o) => o.unit)).toEqual(['pack', 'item', '100g', 'kg']);
    expect(view.packUnits).toEqual(['pack', 'item', 'g', 'kg', 'ml', 'l']);

    // 3 breasts for £3.30 is £5.50 a pack.
    let r = (await call(core, 'POST', '/check', { productId: chicken.id, quantity: 3, unit: 'item', price: 3.3 })) as ReturnType<typeof checkPrice>;
    expect(r.message).toBe("That's £5.50 a pack against the usual £6.00: 8% cheaper, saving about £0.30 on this pack.");

    // Loose by the kg has its own usual price, which a loose pack is compared with.
    expect((await core.assistant.call('set_measure', { item: 'chicken breasts', amount: 1, unit: 'kg', price: 5.5 })).text).toBe('Chicken breasts: 1 pack = 1 kg, £5.50 a kg.');
    r = (await call(core, 'POST', '/check', { productId: chicken.id, quantity: 2, unit: 'kg', price: 10 })) as ReturnType<typeof checkPrice>;
    expect(r.message).toBe("That's £5.00 a pack against the usual £5.50: 9% cheaper, saving about £1.00 on this pack.");
    expect((await core.assistant.call('get_price', { item: 'chicken breasts' })).text).toBe([
      'Chicken breasts: usually £6.00 a pack, £1.20 an item, £0.60 per 100 g, £6.00 a kg.',
      '- 1 pack = 1 kg: £5.50 a kg when bought that way',
      '- 1 pack = 5 items: £1.20 an item (worked out)',
    ].join('\n'));
    expect((await core.assistant.call('convert_price', { price: 6, per: 'pack', to: 'item', item: 'chicken breasts' })).text).toBe('£6.00 a pack is £1.20 an item.');

    // A new weight replaces the old one, keeping the other measures.
    expect((await core.assistant.call('set_measure', { item: 'chicken breasts', amount: 900, unit: 'g' })).text).toBe('Chicken breasts: 1 pack = 900 g, £0.667 per 100 g worked out from the usual price.');
    view = (await call(core, 'GET', '/view/:productId', undefined, { productId: chicken.id })) as PriceView;
    expect(view.measures.map((m) => m.label)).toEqual(['1 pack = 900 g', '1 pack = 5 items']);
    expect(view.itemSize).toEqual({ amount: 900, unit: 'g' });
    expect((await core.assistant.call('remove_measure', { item: 'chicken breasts', unit: 'items' })).text).toBe('Chicken breasts no longer has a measure in items.');
    expect(((await call(core, 'GET', '/view/:productId', undefined, { productId: chicken.id })) as PriceView).measures).toHaveLength(1);
  });

  it('turns down measures that make no sense', async () => {
    const core = await makeCore({ modules: [pricing] });
    const chicken = await core.products.create({ name: 'Chicken breasts', unit: 'pack' });
    const put = (measures: unknown[]) => call(core, 'PUT', '/measures', { productId: chicken.id, measures });
    await expect(put([{ unit: 'packs', amount: 2 }])).rejects.toThrow('counted in packs already');
    await expect(put([{ unit: 'kg', amount: 1 }, { unit: 'g', amount: 900 }])).rejects.toThrow('Give one weight or volume');
    await expect(put([{ unit: '100 g', amount: 3 }])).rejects.toThrow('g, kg, ml or l');
    // An item counted by weight doesn't need a weight, but can be counted another way.
    const cheese = await core.products.create({ name: 'Cheddar', unit: 'kg' });
    await expect(call(core, 'PUT', '/measures', { productId: cheese.id, measures: [{ unit: 'l', amount: 1 }] })).rejects.toThrow('already counted in kg');
    const view = (await call(core, 'PUT', '/measures', { productId: cheese.id, measures: [{ unit: 'slice', amount: 40 }] })) as PriceView;
    expect(view.measures.map((m) => m.label)).toEqual(['1 kg = 40 slices']);
  });

  it('reads an item size saved before measures existed', async () => {
    const core = await makeCore({ modules: [pricing] });
    const spinach = await core.products.create({ name: 'Baby spinach', unit: 'bag', fields: { pricing: { itemSize: { amount: 200, unit: 'g' }, usualUnitPrice: 1.1 } } });
    const view = (await call(core, 'GET', '/view/:productId', undefined, { productId: spinach.id })) as PriceView;
    expect(view.measures.map((m) => [m.label, m.per])).toEqual([['1 bag = 200 g', '£0.55 per 100 g']]);
    expect(view.itemSize).toEqual({ amount: 200, unit: 'g' });
  });
});
