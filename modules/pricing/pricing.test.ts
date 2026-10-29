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
});
