/**
 * The storage contract. Every storage adapter must pass this suite.
 *
 * Writing a new adapter (Firestore, Postgres, Supabase…)? Add a test file
 * that calls `storageContract('my adapter', () => createMyStorage())`. When it
 * passes, the whole app works on your adapter. See docs/adapters.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Movement, Place, Product, Storage, StockEntry, Variant } from '@larder/core';

const now = '2026-10-28T12:00:00.000Z';

const product = (id: string, extra: Partial<Product> = {}): Product => ({
  id, name: `Product ${id}`, aliases: [], categoryId: null, unit: 'each', shelfLifeDays: null, minQuantity: null, preferredShopIds: [],
  notes: '', photoFileIds: [], links: [], wish: false, rechargeable: false, onShoppingList: false, defaultPlaceId: null, nfcTags: [],
  haDeviceIds: [], fields: {}, createdAt: now, updatedAt: now, ...extra,
});
const place = (id: string, extra: Partial<Place> = {}): Place => ({
  id, name: `Place ${id}`, parentId: null, code: null, notes: '', photoFileId: null, nfcTags: [], sortOrder: 0, createdAt: now, updatedAt: now, ...extra,
});
const variant = (id: string, productId: string, extra: Partial<Variant> = {}): Variant => ({
  id, productId, name: `Variant ${id}`, barcodes: [], shopCodes: [], imageUrl: null, source: 'local', fields: {}, createdAt: now, ...extra,
});
const entry = (id: string, productId: string, extra: Partial<StockEntry> = {}): StockEntry => ({
  id, productId, variantId: null, quantity: 1, placeId: null, currentPlaceId: null, movedAt: null, expiresOn: null, addedAt: now,
  status: 'in_stock', expected: null, charge: null, ...extra,
});
const movement = (id: string, productId: string, at = now): Movement => ({
  id, productId, entryId: null, kind: 'add', quantity: 1, fromPlaceId: null, toPlaceId: null, note: '', userId: null, at,
});

export function storageContract(name: string, makeStorage: () => Promise<Storage> | Storage) {
  describe(`storage contract: ${name}`, () => {
    let s: Storage;
    beforeEach(async () => {
      s = await makeStorage();
    });
    afterEach(async () => {
      await s.close();
    });

    it('stores, replaces, lists and removes whole documents', async () => {
      await s.products.put(product('a'));
      await s.products.put(product('b'));
      await s.products.put(product('a', { name: 'Milk', aliases: ['semi-skimmed'] }));
      expect((await s.products.get('a'))?.name).toBe('Milk');
      expect((await s.products.get('a'))?.aliases).toEqual(['semi-skimmed']);
      expect((await s.products.list()).map((p) => p.id).sort()).toEqual(['a', 'b']);
      await s.products.remove('a');
      await s.products.remove('missing');
      expect(await s.products.get('a')).toBeNull();
      expect(await s.products.list()).toHaveLength(1);
    });

    it('returns copies, not live references', async () => {
      const p = product('a');
      await s.products.put(p);
      p.name = 'changed';
      const got = (await s.products.get('a'))!;
      got.name = 'changed again';
      expect((await s.products.get('a'))?.name).toBe('Product a');
    });

    it('finds places by code (case-insensitive) and NFC tag', async () => {
      await s.places.put(place('p1', { code: 'G2-4', nfcTags: ['04:A2:FF'] }));
      await s.places.put(place('p2'));
      expect((await s.places.findByCode('g2-4'))?.id).toBe('p1');
      expect((await s.places.findByCode('G9-9'))).toBeNull();
      expect((await s.places.findByNfcTag('04:A2:FF'))?.id).toBe('p1');
      await s.places.put(place('p1', { code: 'G3-1' }));
      expect(await s.places.findByCode('G2-4')).toBeNull();
    });

    it('finds products by NFC tag', async () => {
      await s.products.put(product('a', { nfcTags: ['tag-1'] }));
      expect((await s.products.findByNfcTag('tag-1'))?.id).toBe('a');
      expect(await s.products.findByNfcTag('tag-2')).toBeNull();
    });

    it('finds variants by product, barcode and shop code', async () => {
      await s.variants.put(variant('v1', 'a', { barcodes: ['5000157024671', '123'], shopCodes: [{ shopId: 'ts', code: '76043' }] }));
      await s.variants.put(variant('v2', 'a'));
      await s.variants.put(variant('v3', 'b'));
      expect((await s.variants.listByProduct('a')).map((v) => v.id).sort()).toEqual(['v1', 'v2']);
      expect((await s.variants.findByBarcode('123'))?.id).toBe('v1');
      expect(await s.variants.findByBarcode('999')).toBeNull();
      expect((await s.variants.findByShopCode('76043'))?.id).toBe('v1');
      expect((await s.variants.findByShopCode('76043', 'ts'))?.id).toBe('v1');
      expect(await s.variants.findByShopCode('76043', 'other')).toBeNull();
    });

    it('lists stock by product and by usual or current place', async () => {
      await s.stock.put(entry('e1', 'a', { placeId: 'shed' }));
      await s.stock.put(entry('e2', 'a', { placeId: 'garage', currentPlaceId: 'kitchen' }));
      await s.stock.put(entry('e3', 'b', { placeId: 'kitchen' }));
      expect((await s.stock.listByProduct('a')).map((e) => e.id).sort()).toEqual(['e1', 'e2']);
      expect((await s.stock.listByPlace('kitchen')).map((e) => e.id).sort()).toEqual(['e2', 'e3']);
      expect((await s.stock.listByPlace('shed')).map((e) => e.id)).toEqual(['e1']);
    });

    it('applies stock changes as one batch', async () => {
      await s.stock.put(entry('old', 'a'));
      await s.products.put(product('a', { wish: true }));
      await s.applyStockChanges({
        put: [entry('new', 'a', { quantity: 3 })],
        remove: ['old'],
        movements: [movement('m1', 'a')],
        products: [product('a', { wish: false })],
      });
      expect((await s.stock.listByProduct('a')).map((e) => e.id)).toEqual(['new']);
      expect((await s.products.get('a'))?.wish).toBe(false);
      expect((await s.movements.listByProduct('a', 10)).map((m) => m.id)).toEqual(['m1']);
    });

    it('lists movements newest first', async () => {
      await s.movements.append([movement('m1', 'a'), movement('m2', 'b')]);
      await s.movements.append([movement('m3', 'a')]);
      expect((await s.movements.listByProduct('a', 10)).map((m) => m.id)).toEqual(['m3', 'm1']);
      expect((await s.movements.listRecent(2)).map((m) => m.id)).toEqual(['m3', 'm2']);
    });

    it('caches lookups by barcode', async () => {
      const rec = { barcode: '123', found: true, provider: 'off', name: 'Beans', brand: 'Heinz', quantityText: '415 g', imageUrl: null, categories: ['tins'], fetchedAt: now };
      await s.lookups.put(rec);
      expect(await s.lookups.get('123')).toEqual(rec);
      await s.lookups.put({ ...rec, name: 'Baked beans' });
      expect((await s.lookups.get('123'))?.name).toBe('Baked beans');
      expect(await s.lookups.get('456')).toBeNull();
    });

    it('finds users by username, case-insensitively', async () => {
      await s.users.put({ id: 'u1', username: 'Shaun', displayName: '', passwordHash: 'x', role: 'admin', createdAt: now });
      expect((await s.users.findByUsername('shaun'))?.id).toBe('u1');
      expect(await s.users.findByUsername('someone')).toBeNull();
      // Usernames are unique whatever the case; the same account can be saved again.
      await expect(s.users.put({ id: 'u2', username: 'SHAUN', displayName: '', passwordHash: 'x', role: 'member', createdAt: now })).rejects.toMatchObject({ code: 'conflict' });
      await s.users.put({ id: 'u1', username: 'Shaun', displayName: 'Shaun B', passwordHash: 'x', role: 'admin', createdAt: now });
      expect((await s.users.get('u1'))?.displayName).toBe('Shaun B');
    });

    it('stores sessions and removes expired ones', async () => {
      await s.sessions.put({ id: 's1', userId: 'u1', createdAt: now, expiresAt: '2026-01-01T00:00:00.000Z' });
      await s.sessions.put({ id: 's2', userId: 'u1', createdAt: now, expiresAt: '2027-01-01T00:00:00.000Z' });
      await s.sessions.removeExpired(now);
      expect(await s.sessions.get('s1')).toBeNull();
      expect((await s.sessions.get('s2'))?.userId).toBe('u1');
      await s.sessions.remove('s2');
      expect(await s.sessions.get('s2')).toBeNull();
    });

    it('finds tokens by hash', async () => {
      await s.tokens.put({ id: 't1', name: 'Claude', tokenHash: 'abc', prefix: 'lrd_ab', userId: 'u1', createdAt: now, lastUsedAt: null });
      expect((await s.tokens.findByHash('abc'))?.id).toBe('t1');
      expect(await s.tokens.findByHash('def')).toBeNull();
    });

    it('stores settings as JSON values', async () => {
      expect(await s.settings.get('household')).toBeNull();
      await s.settings.set('household', { householdName: 'Ours', expiryWarningDays: 5 });
      expect(await s.settings.get('household')).toEqual({ householdName: 'Ours', expiryWarningDays: 5 });
      await s.settings.set('flag', true);
      expect(await s.settings.get('flag')).toBe(true);
    });

    it('keeps module document collections separate', async () => {
      const a = s.documents<{ n: number }>('pricing:history');
      const b = s.documents<{ n: number }>('other:history');
      await a.put('x', { n: 1 });
      await a.put('y', { n: 2 });
      await b.put('x', { n: 9 });
      await a.put('x', { n: 3 });
      expect(await a.get('x')).toEqual({ n: 3 });
      expect((await a.list()).map((d) => d.id).sort()).toEqual(['x', 'y']);
      expect(await b.get('x')).toEqual({ n: 9 });
      await a.remove('x');
      expect(await a.get('x')).toBeNull();
      expect(await b.get('x')).toEqual({ n: 9 });
    });
  });
}
