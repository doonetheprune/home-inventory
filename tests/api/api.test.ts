import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineModule } from '@larder/core';
import { makeApp } from './helpers';
import shopLocations from '../../modules/shop-locations';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('auth', () => {
  it('walks through first-time setup, sign in, tokens and sign out', async () => {
    const { call, useToken, clearAuth } = await makeApp();
    expect((await call<Any>('GET', '/api/v1/auth/status')).body).toMatchObject({ mode: 'local', setupNeeded: true, user: null });
    expect((await call('GET', '/api/v1/home')).status).toBe(401);

    const setup = await call<Any>('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    expect(setup.status).toBe(200);
    expect(setup.body.role).toBe('admin');
    expect((await call('GET', '/api/v1/home')).status).toBe(200);
    expect((await call('POST', '/api/v1/auth/setup', { username: 'again', password: 'correct horse' })).status).toBe(409);

    const created = await call<Any>('POST', '/api/v1/auth/tokens', { name: 'Claude' });
    expect(created.body.token).toMatch(/^lrd_/);
    expect(created.body.info.tokenHash).toBeUndefined();

    await call('POST', '/api/v1/auth/logout');
    clearAuth();
    expect((await call<Any>('POST', '/api/v1/auth/login', { username: 'SHAUN', password: 'wrong password' })).status).toBe(401);
    expect((await call<Any>('POST', '/api/v1/auth/login', { username: 'SHAUN', password: 'correct horse' })).status).toBe(200);

    clearAuth();
    useToken(created.body.token);
    expect((await call<Any>('GET', '/api/v1/auth/status')).body.user.via).toBe('token');
    expect((await call('POST', '/api/v1/products', { name: 'Milk' })).status).toBe(200);
    useToken('lrd_nope');
    expect((await call('GET', '/api/v1/products')).status).toBe(401);
  });

  it('needs the X-Larder-Client header for cookie-signed changes', async () => {
    const { call } = await makeApp();
    await call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    const res = await call('POST', '/api/v1/products', { name: 'Milk' }, { 'x-larder-client': '' });
    expect(res.status).toBe(403);
  });

  it('lets admins add members, who cannot change household settings', async () => {
    const { call, clearAuth } = await makeApp();
    await call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    expect((await call('POST', '/api/v1/auth/users', { username: 'kid', password: 'abcdefgh' })).status).toBe(200);
    clearAuth();
    await call('POST', '/api/v1/auth/login', { username: 'kid', password: 'abcdefgh' });
    expect((await call('PATCH', '/api/v1/settings', { expiryWarningDays: 3 })).status).toBe(403);
    expect((await call('GET', '/api/v1/home')).status).toBe(200);
  });

  it('keeps module routes marked admin for admins', async () => {
    const { call, clearAuth } = await makeApp({ modules: [shopLocations] });
    await call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    await call('POST', '/api/v1/auth/users', { username: 'kid', password: 'abcdefgh' });
    // Not connected to Home Assistant, so an admin hears that; a member is stopped first.
    expect((await call('POST', '/api/v1/modules/shop-locations/automation', {})).status).toBe(409);
    clearAuth();
    await call('POST', '/api/v1/auth/login', { username: 'kid', password: 'abcdefgh' });
    expect((await call('POST', '/api/v1/modules/shop-locations/automation', {})).status).toBe(403);
    expect((await call('GET', '/api/v1/modules/shop-locations/yaml')).status).toBe(200);
  });

  it("can't be bypassed with encoded or odd paths", async () => {
    const { app } = await makeApp();
    for (const url of ['/api/v1/products', '/%61pi/v1/products', '/api/v1/%70roducts', '/%61%70%69/v1/home', '/api/v1/modules', '/api/v1/events', '/api/v1/export', '/api/v1/files/x']) {
      const r = await app.inject({ method: 'GET', url });
      expect([401, 404], url).toContain(r.statusCode);
      expect(r.statusCode === 404 && r.body.startsWith('[')).toBe(false);
    }
    expect((await app.inject({ method: 'GET', url: '/%61pi/v1/products' })).statusCode).toBe(401);
  });

  it("doesn't let a made-up X-Forwarded-For reset the sign-in limit", async () => {
    const { call, clearAuth } = await makeApp();
    await call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    clearAuth();
    const wrong = (i: number) => call('POST', '/api/v1/auth/login', { username: 'shaun', password: 'wrong password' }, { 'x-forwarded-for': `10.0.0.${i}` });
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await wrong(i)).status);
    expect(statuses).toEqual([...Array(10).fill(401), 429, 429]);
    expect((await call('POST', '/api/v1/auth/login', { username: 'shaun', password: 'correct horse' })).status).toBe(429);
  });

  it('limits sign-ins per account even through a trusted proxy', async () => {
    const { call, clearAuth } = await makeApp({ env: { LARDER_TRUST_PROXY: 'true' } });
    await call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    clearAuth();
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await call('POST', '/api/v1/auth/login', { username: 'shaun', password: 'nope nope' }, { 'x-forwarded-for': `10.0.${i}.1` })).status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(30);
    expect(statuses.at(-1)).toBe(429);
  });

  it('can run with no login', async () => {
    const { call } = await makeApp({ auth: 'none' });
    expect((await call<Any>('GET', '/api/v1/auth/status')).body).toMatchObject({ mode: 'none', setupNeeded: false, user: { role: 'admin' } });
    expect((await call('POST', '/api/v1/products', { name: 'Milk' })).status).toBe(200);
  });
});

describe('API', () => {
  it('runs the main flows end to end', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const cats = (await call<Any[]>('GET', '/api/v1/categories')).body;
    const household = cats.find((c) => c.name === 'Household')!;
    const aldi = (await call<Any>('POST', '/api/v1/shops/presets', { name: 'Aldi' })).body;
    const utility = (await call<Any>('POST', '/api/v1/places', { name: 'Utility' })).body;
    const shelf = (await call<Any>('POST', '/api/v1/places', { name: 'Shelf', parentId: utility.id, code: 'U2' })).body;

    const loo = (await call<Any>('POST', '/api/v1/products', { name: 'Toilet roll', aliases: ['bog roll'], categoryId: household.id, unit: 'roll', minQuantity: 9, defaultPlaceId: shelf.id })).body;
    expect((await call<Any>('POST', '/api/v1/stock/add', { productId: loo.id, quantity: 4 })).body.status.low).toBe(true);

    const list = (await call<Any>('GET', `/api/v1/shopping/${aldi.id}`)).body;
    expect(list.count).toBe(1);
    expect(list.groups[0].items[0].quantity).toBe(5);
    expect((await call<Any>('GET', '/api/v1/shopping')).body.suggestedShopId).toBe(aldi.id);

    const search = (await call<Any>('GET', '/api/v1/search?q=bog%20rol')).body;
    expect(search.sections.map((s: Any) => s.id)).toEqual(['stock', 'shopping']);

    const used = (await call<Any>('POST', '/api/v1/stock/use', { productId: loo.id, quantity: 1 })).body;
    expect(used.inStock).toBe(3);
    expect((await call<Any>('POST', '/api/v1/stock/use', { productId: loo.id, quantity: 10 })).body.message).toContain('only 3 rolls');

    const bought = (await call<Any[]>('POST', '/api/v1/shopping/purchase', { shopId: aldi.id, items: [{ productId: loo.id, quantity: 24 }] })).body;
    expect(bought[0]!.inStock).toBe(27);

    const detail = (await call<Any>('GET', `/api/v1/products/${loo.id}`)).body;
    expect(detail.entries[0].place.path).toBe('Utility › Shelf');
    expect(detail.history.length).toBe(3);

    const contents = (await call<Any>('GET', `/api/v1/places/${shelf.id}`)).body;
    expect(contents.items[0].quantity).toBe(27);
    expect((await call<Any>('GET', '/api/v1/identify?code=u2')).body.kind).toBe('place');

    const remembered = (await call<Any>('POST', '/api/v1/identify/remember', { barcode: '5029053038889', productId: loo.id, variantName: 'Andrex 9 pack' })).body;
    expect(remembered.variant.barcodes).toEqual(['5029053038889']);
    expect((await call<Any>('GET', '/api/v1/identify?code=5029053038889')).body.kind).toBe('product');

    const home = (await call<Any>('GET', '/api/v1/home')).body;
    expect(home.counts.products).toBe(1);
    expect((await call<Any[]>('GET', '/api/v1/places/tree')).body[0]!.itemCount).toBe(1);
  });

  it('returns readable validation and not-found errors', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const bad = await call<Any>('POST', '/api/v1/products', { name: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid');
    expect(bad.body.message).toContain('name');
    const missing = await call<Any>('GET', '/api/v1/products/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.message).toContain("doesn't exist");
    expect((await call<Any>('GET', '/api/v1/nothing-here')).body.message).toContain('/api/docs');
  });

  it('patches without resetting other fields', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const p = (await call<Any>('POST', '/api/v1/products', { name: 'Milk', aliases: ['moo'], minQuantity: 2 })).body;
    const patched = (await call<Any>('PATCH', `/api/v1/products/${p.id}`, { notes: 'Semi-skimmed' })).body;
    expect(patched).toMatchObject({ name: 'Milk', aliases: ['moo'], minQuantity: 2, notes: 'Semi-skimmed' });
  });

  it('says when things used at a set rate run out, takes them out of stock, and takes amounts in what is in its pack', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const today = (await call<Any>('GET', '/api/v1/home')).body.today as string;
    const plus = (days: number) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    const sensor = (await call<Any>('POST', '/api/v1/products', { name: 'Glucose sensor', unit: 'sensor', usage: { amount: 1, everyDays: 14 } })).body;
    expect(sensor).toMatchObject({ unit: 'sensor', packSize: null, weight: null, needsCheck: null, usage: { amount: 1, everyDays: 14, auto: false, unit: null }, inUseSince: null });
    await call('POST', '/api/v1/stock/add', { productId: sensor.id, quantity: 3 });
    const used = (await call<Any>('POST', '/api/v1/stock/use', { productId: sensor.id, quantity: 1 })).body;
    expect(used).toMatchObject({ inStock: 2, inUse: true, inUseUntil: plus(14), runsOutOn: plus(42), daysToRunOut: 42, status: { low: false, runningOut: false } });
    expect(used.product.inUseSince).toBe(today);

    // Larder takes them out from now on; the current one started 14 days ago, so the next is due.
    await call('PATCH', `/api/v1/products/${sensor.id}`, { usage: { amount: 1, everyDays: 14, auto: true }, inUseSince: plus(-14) });
    expect((await call<Any>('POST', '/api/v1/automation/check-expiry')).body).toEqual({ expiring: 0, expired: 0, taken: 1 });
    expect((await call<Any>('GET', `/api/v1/products/${sensor.id}`)).body).toMatchObject({ inStock: 1, inUseUntil: plus(14), product: { inUseSince: today } });

    // Bought in boxes of 20 tea bags: amounts can be in either; counting again is gone.
    const tea = (await call<Any>('POST', '/api/v1/products', { name: 'Sleep tea', unit: 'boxes', packSize: { amount: 20, unit: 'tea bags' } })).body;
    expect(tea).toMatchObject({ unit: 'box', packSize: { amount: 20, unit: 'tea bag' }, weight: null });
    await call('POST', '/api/v1/stock/add', { productId: tea.id, quantity: 2 });
    expect((await call<Any>('POST', '/api/v1/stock/use', { productId: tea.id, quantity: 5, unit: 'tea bags' })).body.inStock).toBe(1.75);
    const wrong = await call<Any>('POST', '/api/v1/stock/use', { productId: tea.id, quantity: 1, unit: 'kg' });
    expect([wrong.status, wrong.body.message]).toEqual([400, "Larder doesn't know what one box of Sleep tea weighs, so it can't work in kg. Give how many boxes or tea bags. Or give it a Weight first."]);
    expect((await call<Any>('POST', `/api/v1/products/${tea.id}/recount`, { unit: 'tea bag', holds: 20 })).status).toBe(404);
    // A Weight in kg is kept in g; one alongside a pack size in g is refused.
    const jar = (await call<Any>('POST', '/api/v1/products', { name: 'Decaf coffee', unit: 'jar', packSize: { amount: 0.4, unit: 'kg' } })).body;
    expect(jar.weight).toEqual({ amount: 400, unit: 'g' });
    expect((await call<Any>('PATCH', `/api/v1/products/${jar.id}`, { weight: { amount: 200, unit: 'g' } })).status).toBe(400);
  });

  it('keeps the unit list, with the household\'s own words', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const list = (await call<Any[]>('GET', '/api/v1/units')).body;
    expect(list.find((u) => u.key === 'tea bag')).toEqual({ key: 'tea bag', one: 'tea bag', many: 'tea bags', kind: 'count', factor: null, builtIn: true });
    expect(list.find((u) => u.key === 'pint')).toMatchObject({ kind: 'volume', factor: 568.261 });
    const added = await call<Any>('POST', '/api/v1/units', { one: 'sleeve', many: 'sleeves' });
    expect([added.status, added.body]).toEqual([200, { key: 'sleeve', one: 'sleeve', many: 'sleeves', kind: 'count', factor: null, builtIn: false }]);
    expect((await call<Any>('POST', '/api/v1/units', { one: 'Box', many: 'Boxes' })).body.message).toBe('Larder already has "box".');
    const cups = (await call<Any>('POST', '/api/v1/products', { name: 'Paper cups', unit: 'sleeves' })).body;
    expect(cups.unit).toBe('sleeve');
    const used = await call<Any>('DELETE', '/api/v1/units/sleeve');
    expect([used.status, used.body.message]).toEqual([409, 'Paper cups uses "sleeve". Change it first.']);
    expect((await call<Any>('DELETE', '/api/v1/units/box')).body.message).toBe('"box" is one of Larder\'s own units, so it can\'t be removed.');
    await call('PATCH', `/api/v1/products/${cups.id}`, { unit: 'pack' });
    expect((await call<Any>('DELETE', '/api/v1/units/sleeve')).status).toBe(200);
    expect((await call<Any[]>('GET', '/api/v1/units')).body.some((u) => u.key === 'sleeve')).toBe(false);
  });

  it('builds a grid of places', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const garage = (await call<Any>('POST', '/api/v1/places', { name: 'Garage' })).body;
    const grid = (await call<Any>('POST', '/api/v1/places/grid', { parentId: garage.id, name: 'Racking', prefix: 'G', rows: 4, columns: 6 })).body;
    expect(grid.places).toHaveLength(24);
  });

  it('lists stock with no place as To sort, and puts it away from there', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const shelf = (await call<Any>('POST', '/api/v1/places', { name: 'Shelf', code: 'U1' })).body;
    const tea = (await call<Any>('POST', '/api/v1/products', { name: 'Tea bags', unit: 'box' })).body;
    await call('POST', '/api/v1/stock/add', { productId: tea.id, quantity: 2, placeId: null });
    const pile = (await call<Any>('GET', '/api/v1/places/to-sort')).body;
    expect(pile.items).toHaveLength(1);
    expect(pile.items[0]).toMatchObject({ quantity: 2, summary: { product: { name: 'Tea bags' } } });
    expect((await call('POST', '/api/v1/stock/move', { productId: tea.id, toPlaceId: shelf.id, fromPlaceId: null, mode: 'permanent' })).status).toBe(200);
    expect((await call<Any>('GET', '/api/v1/places/to-sort')).body.items).toEqual([]);
  });

  it('saves the photo a barcode lookup found when a scanned item is named, and serves it from Larder', async () => {
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
    const lookups = defineModule({
      id: 'fake-lookup', name: 'Fake lookup', description: 'Test', version: '1.0.0',
      setup(ctx) {
        ctx.addLookupProvider({ id: 'fake', name: 'Fake Facts', lookup: async () => ({ name: 'Baked Beanz', brand: 'Heinz', quantityText: '415 g', imageUrl: 'https://images.example/beanz.jpg', categories: [] }) });
      },
    });
    const fetch = (async (url: string) => (url === 'https://images.example/beanz.jpg' ? new Response(jpeg) : new Response('', { status: 404 }))) as unknown as typeof globalThis.fetch;
    const { call } = await makeApp({ auth: 'none', modules: [lookups], fetch });
    // The Scan screen: identify, then "Add as new item".
    expect((await call<Any>('GET', '/api/v1/identify?code=5000157024671')).body).toMatchObject({ kind: 'external', result: { imageUrl: 'https://images.example/beanz.jpg' } });
    const saved = await call<Any>('POST', '/api/v1/identify/remember', { barcode: '5000157024671', create: { name: 'Baked beans', unit: 'tin' }, imageUrl: 'https://images.example/beanz.jpg' });
    const photo = saved.body.product.product.photoFileIds[0];
    expect(saved.body.variant.photoFileId).toBe(photo);
    const down = await call('GET', `/api/v1/files/${photo}`);
    expect(down.raw.headers['content-type']).toBe('image/jpeg');
    expect(down.raw.rawPayload.equals(jpeg)).toBe(true);
  });

  it('uploads and serves photos', async () => {
    const { app } = await makeApp({ auth: 'none' });
    const boundary = 'larderboundary';
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shelf.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({ method: 'POST', url: '/api/v1/files', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode).toBe(200);
    const { id } = up.json() as { id: string };
    const down = await app.inject({ method: 'GET', url: `/api/v1/files/${id}` });
    expect(down.headers['content-type']).toBe('image/png');
    expect(down.rawPayload.equals(png)).toBe(true);
    expect(down.headers['x-content-type-options']).toBe('nosniff');
    expect(down.headers['content-security-policy']).toContain('sandbox');

    // An SVG (which can carry scripts) is refused whatever type the browser claims.
    for (const type of ['image/svg+xml', 'image/png']) {
      const svg = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.svg"\r\nContent-Type: ${type}\r\n\r\n`),
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const r = await app.inject({ method: 'POST', url: '/api/v1/files', payload: svg, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
      expect(r.statusCode).toBe(400);
    }
  });

  it('loads example data into an empty Larder', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const r = await call<Any>('POST', '/api/v1/settings/demo');
    expect(r.status).toBe(200);
    expect(r.body.products).toBeGreaterThan(30);
    const home = (await call<Any>('GET', '/api/v1/home')).body;
    expect(home.counts.outOfPlace).toBe(2);
    expect(home.deliveries[0].source).toBe('Tesco delivery');
    expect(home.expiringSoon.length).toBeGreaterThan(3);
    expect((await call<Any>('POST', '/api/v1/settings/demo')).status).toBe(400);
    const exported = (await call<Any>('GET', '/api/v1/export')).body;
    expect(exported.format).toBe('larder-export');
    expect(exported.products.length).toBe(r.body.products);
  });

  it('publishes a complete OpenAPI spec', async () => {
    const { call } = await makeApp({ auth: 'none' });
    const spec = (await call<Any>('GET', '/api/openapi.json')).body;
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
    expect(spec.paths['/api/v1/stock/add'].post.requestBody).toBeDefined();
    expect(spec.paths['/api/v1/search'].get.parameters[0].name).toBe('q');
  });
});

describe('module routes', () => {
  it('serves module routes, documents them and blocks them when switched off', async () => {
    const echo = defineModule({
      id: 'echo', name: 'Echo', description: 'Test', version: '1.0.0',
      setup(ctx) {
        ctx.addRoute({
          method: 'POST', path: '/shout', summary: 'Shout it', body: z.object({ text: z.string() }), response: z.object({ text: z.string() }),
          handler: async ({ body }) => ({ text: (body as { text: string }).text.toUpperCase() }),
        });
      },
    });
    const { call } = await makeApp({ auth: 'none', modules: [echo] });
    expect((await call<Any>('POST', '/api/v1/modules/echo/shout', { text: 'hi' })).body).toEqual({ text: 'HI' });
    expect((await call<Any>('GET', '/api/openapi.json')).body.paths['/api/v1/modules/echo/shout']).toBeDefined();
    expect((await call<Any>('PATCH', '/api/v1/modules/echo', { enabled: false })).body.enabled).toBe(false);
    expect((await call<Any>('POST', '/api/v1/modules/echo/shout', { text: 'hi' })).status).toBe(404);
  });

  it('respects LARDER_MODULES_DISABLED', async () => {
    const m = defineModule({ id: 'locked-one', name: 'Locked', description: 'Test', version: '1.0.0' });
    const { call } = await makeApp({ auth: 'none', modules: [m], env: { LARDER_MODULES_DISABLED: 'locked-one' } });
    expect((await call<Any[]>('GET', '/api/v1/modules')).body[0]).toMatchObject({ enabled: false, locked: true });
    expect((await call('PATCH', '/api/v1/modules/locked-one', { enabled: true })).status).toBe(409);
  });
});
