import { describe, expect, it } from 'vitest';
import { makeCore, category } from '../../tests/helpers';
import batteries, { type Advice } from './index';

const call = (core: Awaited<ReturnType<typeof makeCore>>, method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'batteries' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params, userId: null });

async function setup() {
  const core = await makeCore({ modules: [batteries] });
  const cat = await category(core, 'Batteries');
  const drawer = await core.places.create({ name: 'Hall drawer' });
  const aa = await core.products.create({ name: 'AA batteries', categoryId: cat.id, rechargeable: true, defaultPlaceId: drawer.id, haDeviceIds: ['remote'] });
  const nineV = await core.products.create({ name: '9V batteries', categoryId: cat.id, defaultPlaceId: drawer.id, haDeviceIds: ['smoke'] });
  await call(core, 'PUT', '/devices', { devices: [
    { id: 'remote', name: 'TV remote', area: 'Lounge', level: 40, batteryType: 'AA', batteryQuantity: 2 },
    { id: 'smoke', name: 'Hall smoke alarm', area: 'Hall', level: 18, low: true },
    { id: 'door', name: 'Front door sensor', level: 90, batteryType: 'CR2032' },
  ] });
  return { core, aa, nineV };
}

describe('batteries module', () => {
  it('points to charged spares, then says to charge flat ones', async () => {
    const { core, aa } = await setup();
    await core.stock.add({ productId: aa.id, quantity: 4 });
    let a = (await call(core, 'POST', '/low', { deviceId: 'remote', level: 9 })) as Advice;
    expect(a).toMatchObject({ kind: 'swap', place: 'Hall drawer', message: 'TV remote needs 2 batteries. Swap in charged AA batteries from Hall drawer (4 charged).' });
    expect(core.events.log.find((e) => e.type === 'batteries.low')?.data).toMatchObject({ device: 'TV remote', kind: 'swap', level: 9 });

    const r = await core.automation.run('batteries_replaced', { device: 'TV remote' });
    expect(r.message).toBe('TV remote: 2 batteries replaced. AA batteries: 2 charged, 2 flat.');
    await core.automation.run('batteries_replaced', { device: 'remote' });
    a = (await call(core, 'GET', '/advice/:deviceId', undefined, { deviceId: 'remote' })) as Advice;
    expect(a.kind).toBe('charge');
    expect(a.message).toBe('TV remote needs 2 batteries, but none of the AA batteries are charged. Charge some: 4 are flat.');
  });

  it('uses a spare, or puts the battery on the shopping list when there are none', async () => {
    const { core, nineV } = await setup();
    let a = (await call(core, 'POST', '/low', { deviceId: 'Hall smoke alarm' })) as Advice;
    expect(a.kind).toBe('buy');
    expect((await core.products.summary(nineV.id)).product.onShoppingList).toBe(true);

    await core.stock.expect({ productId: nineV.id, quantity: 2, source: 'Amazon' });
    expect(((await call(core, 'GET', '/advice/:deviceId', undefined, { deviceId: 'smoke' })) as Advice).kind).toBe('on_the_way');
    await core.stock.arrive({ source: 'Amazon' });
    a = (await call(core, 'GET', '/advice/:deviceId', undefined, { deviceId: 'smoke' })) as Advice;
    expect(a).toMatchObject({ kind: 'spare', message: 'Hall smoke alarm needs 1 battery. There are 2 spares in Hall drawer.' });
  });

  it('asks for a link when a device has no battery type yet, and lists devices low first', async () => {
    const { core } = await setup();
    expect(((await call(core, 'POST', '/low', { deviceId: 'door' })) as Advice).kind).toBe('unlinked');
    const list = (await call(core, 'GET', '/devices')) as Array<{ name: string; batteries: unknown[] }>;
    expect(list.map((d) => d.name)).toEqual(['Front door sensor', 'Hall smoke alarm', 'TV remote']);
    expect(list[2]?.batteries).toEqual([expect.objectContaining({ name: 'AA batteries' })]);
    const state = await core.automation.read();
    expect(state.batteries_low?.state).toBe(2);

    // Two devices with the same name: ask which, rather than picking one.
    await call(core, 'PUT', '/devices', { devices: [{ id: 'r1', name: 'TRADFRI remote', area: 'Lounge' }, { id: 'r2', name: 'TRADFRI remote', area: 'Bedroom' }] });
    await expect(core.automation.run('batteries_replaced', { device: 'TRADFRI remote' })).rejects.toMatchObject({ code: 'ambiguous' });

    // A new list from Home Assistant replaces the old one.
    await call(core, 'PUT', '/devices', { devices: [{ id: 'remote', name: 'TV remote' }] });
    expect(((await call(core, 'GET', '/devices')) as unknown[]).length).toBe(1);
  });
});
