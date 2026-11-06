import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import scenarios from '../../modules/scenarios';
import recipes from '../../modules/recipes';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function household() {
  const larder = await makeApp({ modules: [scenarios, recipes] });
  const { call } = larder;
  await call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
  const garage = (await call<Any>('POST', '/api/v1/places', { name: 'Garage' })).body;
  const shop = (await call<Any>('POST', '/api/v1/shops', { name: 'Aldi' })).body;
  const candles = (await call<Any>('POST', '/api/v1/products', { name: 'Candles', unit: 'candles', placeIds: [garage.id] })).body;
  await call('POST', '/api/v1/stock/add', { productId: candles.id, quantity: 12, placeId: garage.id });
  const torch = (await call<Any>('POST', '/api/v1/products', { name: 'Head torch', wish: true })).body;
  const powerCut = (await call<Any>('POST', '/api/v1/modules/scenarios', { name: 'Power cut' })).body;
  await call('PUT', `/api/v1/modules/scenarios/${powerCut.id}/items`, { productId: candles.id, included: true });
  const dinner = (await call<Any>('POST', '/api/v1/modules/recipes', { title: 'Candlelit dinner', ingredients: [{ name: 'Candles', productId: candles.id, quantity: 2 }], scenarioIds: [powerCut.id] })).body;
  return { ...larder, garage, shop, candles, torch, powerCut, dinner };
}

describe('offline copies', () => {
  it('holds the answer to each GET the web app makes, as the caller sees it', async () => {
    const { call, garage, shop, candles, torch, powerCut, dinner } = await household();
    const res = await call<Any>('GET', '/api/v1/offline/copy');
    expect(res.status).toBe(200);
    expect(res.raw.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ format: 'larder-offline-copy', version: 1, larderVersion: 'test' });
    const r = res.body.responses as Record<string, unknown>;

    for (const path of [
      '/auth/status', '/home', '/search', '/settings', '/modules', '/categories', '/shops', '/places', '/places/tree', '/places/to-sort',
      '/products?status=all', '/products?status=wish', '/products?status=to_tidy', '/shopping', '/shopping/unassigned',
      `/products/${candles.id}`, `/products/${torch.id}`, `/places/${garage.id}`, `/shopping/${shop.id}`,
      '/modules/scenarios', `/modules/scenarios/${powerCut.id}`,
      '/modules/recipes', '/modules/recipes?show=scenario-only', `/modules/recipes/${dinner.id}`,
      `/modules/recipes?productId=${candles.id}`, `/modules/recipes?scenarioId=${powerCut.id}`,
    ]) {
      expect(r, path).toHaveProperty([path]);
    }
    // Exactly what the API answers, so the app shows the same.
    expect(r[`/products/${candles.id}`]).toEqual((await call('GET', `/api/v1/products/${candles.id}`)).body);
    expect(r[`/modules/scenarios/${powerCut.id}`]).toEqual((await call('GET', `/api/v1/modules/scenarios/${powerCut.id}`)).body);
    expect((r['/auth/status'] as Any).user).toMatchObject({ username: 'shaun' });
    expect((r['/products?status=all'] as Any[]).map((s) => s.product.name)).toEqual(['Candles']);
    expect((r['/products?status=wish'] as Any[]).map((s) => s.product.name)).toEqual(['Head torch']);
  });

  it('leaves out the pages of switched-off modules', async () => {
    const { call } = await household();
    await call('PATCH', '/api/v1/modules/recipes', { enabled: false });
    const r = (await call<Any>('GET', '/api/v1/offline/copy')).body.responses as Record<string, unknown>;
    expect(Object.keys(r).filter((p) => p.startsWith('/modules/recipes'))).toEqual([]);
    expect(r).toHaveProperty(['/modules/scenarios']);
  });

  it('is gzipped for clients that accept it', async () => {
    const { call } = await household();
    const res = await call('GET', '/api/v1/offline/copy', undefined, { 'accept-encoding': 'gzip, deflate, br' });
    expect(res.status).toBe(200);
    expect(res.raw.headers['content-encoding']).toBe('gzip');
    const copy = JSON.parse(gunzipSync(res.raw.rawPayload).toString('utf8')) as Any;
    expect(copy.format).toBe('larder-offline-copy');
    expect(Object.keys(copy.responses).length).toBeGreaterThan(20);
  });

  it('needs someone signed in', async () => {
    const { call, clearAuth } = await household();
    clearAuth();
    expect((await call('GET', '/api/v1/offline/copy')).status).toBe(401);
  });

  it('works for Home Assistant users signed in through ingress', async () => {
    const { app } = await makeApp({ auth: 'homeassistant' });
    const ingress = { 'x-remote-user-id': 'abc123', 'x-remote-user-name': 'shaun', 'x-remote-user-display-name': 'Shaun', 'x-larder-client': 'web' };
    await app.inject({ method: 'POST', url: '/api/v1/products', remoteAddress: '172.30.32.2', headers: ingress, payload: { name: 'Milk' } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/offline/copy', remoteAddress: '172.30.32.2', headers: ingress });
    expect(res.statusCode).toBe(200);
    const r = res.json().responses as Record<string, Any>;
    expect(r['/auth/status']!.user).toMatchObject({ id: 'ha-abc123', via: 'ingress' });
    expect((r['/products?status=all'] as unknown as Any[]).map((s) => s.product.name)).toEqual(['Milk']);
    // The same headers from anywhere else aren't a sign-in.
    expect((await app.inject({ method: 'GET', url: '/api/v1/offline/copy', remoteAddress: '192.168.1.50', headers: ingress })).statusCode).toBe(401);
  });
});
