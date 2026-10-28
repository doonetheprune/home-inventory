import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
import pricing, { checkPrice } from './index';

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
});
