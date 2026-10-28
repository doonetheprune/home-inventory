import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
import template from './index';

describe('template module', () => {
  it('counts stock changes while switched on', async () => {
    const core = await makeCore({ modules: [template] });
    const route = core.modules.routes().find((r) => r.moduleId === 'template' && r.route.path === '/count')!.route;
    const p = await core.products.create({ name: 'Test' });

    await core.stock.add({ productId: p.id, quantity: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(await route.handler({ body: undefined, query: {}, params: {}, userId: null })).toEqual({ count: 0 }); // off by default

    await core.modules.setEnabled('template', true);
    await core.stock.add({ productId: p.id, quantity: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(await route.handler({ body: undefined, query: {}, params: {}, userId: null })).toEqual({ count: 1 });
  });
});
