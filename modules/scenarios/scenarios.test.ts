import { describe, expect, it } from 'vitest';
import { makeCore, category } from '../../tests/helpers';
import scenarios, { type Scenario, type ScenarioDetail } from './index';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = (core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'scenarios' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params, userId: null });

async function household() {
  const core = await makeCore({ modules: [scenarios] });
  const hall = await core.places.create({ name: 'Hall' });
  const drawer = await core.places.create({ name: 'Drawer', parentId: hall.id, code: 'H1' });
  const garage = await core.places.create({ name: 'Garage racking', code: 'G2-4' });
  const kitchen = await core.places.create({ name: 'Kitchen' });
  const batteries = await category(core, 'Batteries');
  const aa = await core.products.create({ name: 'AA batteries', rechargeable: true, categoryId: batteries.id, defaultPlaceId: drawer.id });
  await core.stock.add({ productId: aa.id, quantity: 10 });
  await core.stock.use({ productId: aa.id, quantity: 4 });
  const torch = await core.products.create({ name: 'Head torch', defaultPlaceId: drawer.id });
  await core.stock.add({ productId: torch.id, quantity: 2 });
  await core.stock.move({ productId: torch.id, toPlaceId: kitchen.id, quantity: 1 });
  const gas = await core.products.create({ name: 'Camping gas', unit: 'canister', minQuantity: 3, defaultPlaceId: garage.id });
  await core.stock.add({ productId: gas.id, quantity: 1 });
  const candles = await core.products.create({ name: 'Candles' });
  const radio = await core.products.create({ name: 'Wind-up radio', wish: true });
  const s = (await call(core, 'POST', '/', { name: 'Power cut', icon: 'zap' })) as Scenario;
  for (const p of [aa, torch, gas, candles, radio]) await call(core, 'PUT', '/:id/items', { productId: p.id, included: true }, { id: s.id });
  return { core, s, ids: { aa: aa.id, torch: torch.id, gas: gas.id } };
}

describe('scenarios module', () => {
  it('lists every item, how many and where, grouped by where things are now', async () => {
    const { core, s } = await household();
    const d = (await call(core, 'GET', '/:id', undefined, { id: s.id })) as ScenarioDetail;
    expect(d.counts).toEqual({ items: 4, places: 3, low: 1, wish: 1 });
    expect(d.groups.map((g) => g.place?.path)).toEqual(['Garage racking', 'Hall › Drawer', 'Kitchen']);
    const drawer = d.groups.find((g) => g.place?.code === 'H1')!;
    expect(drawer.items.map((i) => [i.name, i.quantity, i.note])).toEqual([['AA batteries', 10, '6 charged, 4 flat'], ['Head torch', 1, null]]);
    expect(d.groups.find((g) => g.place?.name === 'Kitchen')!.items[0]).toMatchObject({ name: 'Head torch', visiting: true });
    expect(d.groups[0]!.items[0]).toMatchObject({ name: 'Camping gas', low: true, note: 'Min 3 canisters' });
    expect(d.missing.map((m) => m.name)).toEqual(['Candles']);
    expect(d.wish.map((w) => w.name)).toEqual(['Wind-up radio']);
  });

  it('is found by search, and by assistants', async () => {
    const { core } = await household();
    const sections = await core.search.query('power');
    expect(sections.find((x) => x.id === 'scenarios')?.results[0]).toMatchObject({ title: 'Power cut', subtitle: '4 items in 3 places · 1 low' });
    const listed = await core.assistant.call('list_scenarios', {});
    expect(listed.text).toBe('- Power cut: 4 items, 1 low, 1 on the wish list');
    const got = await core.assistant.call('get_scenario', { scenario: 'power' });
    expect(got.text).toContain('Hall › Drawer (H1):\n- AA batteries: 10 batteries (6 charged, 4 flat)');
    expect(got.text).toContain('None in the house: Candles.');
    await expect(core.assistant.call('get_scenario', { scenario: 'christmas' })).rejects.toThrow('The scenarios are: Power cut');
  });

  it('takes items out, renames, and removing a scenario untags its items', async () => {
    const { core, s, ids } = await household();
    await call(core, 'PUT', '/:id/items', { productId: ids.gas, included: false }, { id: s.id });
    await call(core, 'PATCH', '/:id', { name: 'Power cut kit' }, { id: s.id });
    const list = (await call(core, 'GET', '/')) as Array<{ name: string; counts: { items: number } }>;
    expect(list).toEqual([expect.objectContaining({ name: 'Power cut kit', counts: expect.objectContaining({ items: 3 }) })]);
    await expect(call(core, 'POST', '/', { name: 'power cut kit' })).rejects.toMatchObject({ code: 'conflict' });
    await call(core, 'DELETE', '/:id', undefined, { id: s.id });
    expect((await core.products.summary(ids.aa)).product.fields.scenarios).toEqual([]);
  });

  it('keeps names unique when renaming, and tags safely alongside other changes', async () => {
    const { core, s, ids } = await household();
    const other = (await call(core, 'POST', '/', { name: 'Snowed in' })) as Scenario;
    await expect(call(core, 'PATCH', '/:id', { name: 'power cut' }, { id: other.id })).rejects.toMatchObject({ status: 409 });
    // Another module's field on the same item survives tagging.
    await core.products.update(ids.gas, { fields: { pricing: { usualUnitPrice: 4 } } });
    await Promise.all([
      call(core, 'PUT', '/:id/items', { productId: ids.gas, included: true }, { id: other.id }),
      call(core, 'PUT', '/:id/items', { productId: ids.gas, included: false }, { id: s.id }),
    ]);
    const fields = (await core.products.summary(ids.gas)).product.fields;
    expect(fields.scenarios).toEqual([other.id]);
    expect(fields.pricing).toEqual({ usualUnitPrice: 4 });
  });

  it('adds example scenarios to the demo household', async () => {
    const core = await makeCore({ modules: [scenarios] });
    const torch = await core.products.create({ name: 'Head torch' });
    await core.modules.seedDemo({ products: { 'Head torch': torch.id }, places: {} });
    const list = (await call(core, 'GET', '/')) as Array<{ name: string; counts: { items: number } }>;
    expect(list.map((x) => x.name)).toEqual(['Power cut', 'Snowed in']);
    expect(list[0]!.counts.items).toBe(1);
  });
});
