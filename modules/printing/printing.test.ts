import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
import printing, { type Label } from './index';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = (core: Core, path: string, query: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'printing' && r.route.path === path)!.route.handler({ body: undefined, query, params: {}, userId: null });

describe('printing module', () => {
  it('labels a storage area: the area, then everything inside it in code order', async () => {
    const core = await makeCore({ modules: [printing] });
    const garage = await core.places.create({ name: 'Garage' });
    await core.places.createGrid({ parentId: garage.id, name: 'Racking', prefix: 'G', rows: 4, columns: 6 });
    const areas = (await call(core, '/areas')) as Array<{ name: string; labels: number }>;
    expect(areas.map((a) => [a.name, a.labels])).toEqual([['Garage', 25], ['Racking', 24]]);
    const racking = (await core.places.list()).find((p) => p.name === 'Racking')!;
    const labels = (await call(core, '/labels', { place: racking.id })) as Label[];
    expect(labels).toHaveLength(25);
    expect(labels[0]).toMatchObject({ kind: 'place', title: 'Racking', subtitle: 'Garage' });
    expect(labels.slice(1, 4).map((l) => l.code)).toEqual(['G1-1', 'G1-2', 'G1-3']);
    expect(labels.at(-1)?.code).toBe('G4-6');
    expect(labels[1]?.subtitle).toBe('Garage › Racking');
  });

  it('labels chosen items too, skipping ones that are gone', async () => {
    const core = await makeCore({ modules: [printing] });
    const box = await core.places.create({ name: 'Filing box' });
    const ins = await core.products.create({ name: 'House insurance', defaultPlaceId: box.id });
    await core.stock.add({ productId: ins.id, quantity: 1 });
    const labels = (await call(core, '/labels', { products: `${ins.id},missing-id` })) as Label[];
    expect(labels).toEqual([{ kind: 'product', id: ins.id, code: null, title: 'House insurance', subtitle: 'Filing box' }]);
  });
});
