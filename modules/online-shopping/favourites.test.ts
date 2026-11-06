import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
import onlineShopping from './index';
import { matchFavourite, type Dismissed, type PendingFavourite, type SyncResult } from './favourites';
import type { OnlineFields } from './items';
import { fakeProvider } from './test-provider';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = <T = unknown>(core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'online-shopping' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params, userId: null }) as Promise<T>;

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

async function setup() {
  const shop = fakeProvider();
  const fetch = (async (input: string | URL, init?: RequestInit) =>
    String(input).startsWith('https://digitalcontent.api.tesco.com/') ? new Response(PNG, { status: 200 }) : shop.fetch(input, init)) as typeof globalThis.fetch;
  const core = await makeCore({ modules: [onlineShopping], fetch });
  const tesco = await core.shops.addPreset('Tesco');
  await call(core, 'POST', '/providers', { type: 'tesco', shopId: tesco.id, address: '192.168.1.231:8710', token: 'secret' });
  shop.listing('1001', 'Tesco Soft Toilet Tissue 9 Rolls', { amount: 9, unit: 'each' }, 4.5);
  shop.listing('2001', 'Tesco Closed Cup Mushrooms 300G', { amount: 0.3, unit: 'kg' }, 0.89);
  shop.listing('3001', 'Oatly Barista Edition Oat Drink 1L', { amount: 1, unit: 'l' }, 2.1);
  shop.listing('4001', 'Pringles Original 165G', { amount: 0.165, unit: 'kg' }, 2.5);
  shop.state.favourites = ['1001', '2001', '3001'];
  const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll', minQuantity: 4 });
  await core.assistant.call('link_listing', { item: 'toilet roll', id_or_link: '1001' });
  return { core, shop, tesco, loo };
}

const pendingNames = async (core: Core) => (await call<PendingFavourite[]>(core, 'GET', '/pending')).map((p) => p.name).sort();

describe('online shopping: favourites into Pending', () => {
  it('brings in favourites not linked to an item, and leaves linked ones out', async () => {
    const { core } = await setup();
    const r = await core.assistant.call('sync_favourites', {});
    expect(r.text).toBe('2 new Tesco favourites are in Pending (2 waiting). 1 is already linked to items.');
    expect(await pendingNames(core)).toEqual(['Oatly Barista Edition Oat Drink 1L', 'Tesco Closed Cup Mushrooms 300G']);
    expect(core.events.log.find((e) => e.type === 'online-shopping.favourites_pending')?.data).toEqual({ shop: 'Tesco', added: 2, pending: 2 });
    // Again: nothing new, and nothing twice.
    expect((await core.assistant.call('sync_favourites', { shop: 'tesco' })).text).toBe('No new Tesco favourites; 2 still waiting in Pending. 1 is already linked to items.');
  });

  it('remembers dismissals until they are undone', async () => {
    const { core, tesco } = await setup();
    await core.assistant.call('sync_favourites', {});
    const id = `${tesco.id}:2001`;
    await call(core, 'POST', '/pending/:id/dismiss', undefined, { id });
    expect(await pendingNames(core)).toEqual(['Oatly Barista Edition Oat Drink 1L']);
    const again = await call<SyncResult>(core, 'POST', '/shops/:shopId/favourites/sync', {}, { shopId: tesco.id });
    expect(again).toMatchObject({ added: 0, pending: 1, dismissed: 1 });
    expect(again.message).toBe('No new Tesco favourites; 1 still waiting in Pending. 1 is already linked to items, and 1 you dismissed was left out.');
    expect((await call<Dismissed[]>(core, 'GET', '/dismissed')).map((d) => d.name)).toEqual(['Tesco Closed Cup Mushrooms 300G']);
    await call(core, 'DELETE', '/dismissed/:id', undefined, { id });
    expect(await pendingNames(core)).toEqual(['Oatly Barista Edition Oat Drink 1L', 'Tesco Closed Cup Mushrooms 300G']);
  });

  it('becomes a new item with the shop\'s picture, linked to that listing', async () => {
    const { core, tesco } = await setup();
    await core.assistant.call('sync_favourites', {});
    const id = `${tesco.id}:2001`;
    // What the app does: save the picture, open Add item with it, then say which item was made.
    const { photoFileId } = await call<{ photoFileId: string }>(core, 'POST', '/pending/:id/photo', undefined, { id });
    const mushrooms = await core.products.create({ name: 'Mushrooms', unit: 'g', photoFileIds: [photoFileId] });
    await call(core, 'POST', '/pending/:id/added', { productId: mushrooms.id }, { id });
    const f = (await core.products.summary(mushrooms.id)).product.fields['online-shopping'] as OnlineFields;
    expect(f.shops[tesco.id]!.listings[0]).toMatchObject({ listingId: '2001', packQuantity: 300, guessed: false });
    expect(await pendingNames(core)).toEqual(['Oatly Barista Edition Oat Drink 1L']);
  });

  it('a new code for a gone product, linked to its item, replaces the gone listing', async () => {
    const { core, shop, tesco } = await setup();
    const oat = await core.products.create({ name: 'Oat milk', unit: 'carton', minQuantity: 2 });
    shop.listing('3000', 'Oatly Barista 1L (old)', { amount: 1, unit: 'l' }, 2);
    await core.assistant.call('link_listing', { item: 'oat milk', id_or_link: '3000', pack_quantity: 1 });
    shop.state.listings.get('3000')!.error = 'listing_dead';
    await core.assistant.call('plan_basket', {});
    await core.assistant.call('sync_favourites', {});
    const r = await call<{ message: string }>(core, 'POST', '/pending/:id/link', { productId: oat.id }, { id: `${tesco.id}:3001` });
    expect(r.message).toBe('Oatly Barista Edition Oat Drink 1L is linked to Oat milk (1 pack = 1 carton: check this).');
    const f = (await core.products.summary(oat.id)).product.fields['online-shopping'] as OnlineFields;
    expect(f.shops[tesco.id]!.listings.map((l) => l.listingId)).toEqual(['3001']);
  });

  it('adds to the shop\'s favourites, linking it to an item or leaving it in Pending', async () => {
    const { core, shop } = await setup();
    const r = await core.assistant.call('add_to_favourites', { id_or_link: '4001' });
    expect(r.text).toBe('Added to your Tesco favourites: Pringles Original 165G (code 4001), pack 165 g, £2.50. It\'s waiting in Pending to become an item or be linked to one.');
    expect(shop.state.favourites).toContain('4001');
    expect(await pendingNames(core)).toEqual(['Pringles Original 165G']);

    await core.products.create({ name: 'Mushrooms', unit: 'g' });
    const linked = await core.assistant.call('add_to_favourites', { id_or_link: 'https://www.tesco.com/groceries/en-GB/products/2001', item: 'mushrooms' });
    expect(linked.text).toBe('Added to your Tesco favourites: Tesco Closed Cup Mushrooms 300G (code 2001), pack 300 g, £0.89. Linked to Mushrooms (1 pack = 300 g). It\'s bought from Tesco now.');
    await expect(core.assistant.call('add_to_favourites', { id_or_link: '9999' })).rejects.toThrow('Tesco has no product with that code or link.');
  });

  it('can be synced on a schedule from Home Assistant', async () => {
    const { core } = await setup();
    const r = await core.automation.run('online_shopping_sync_favourites', {}, { userId: null });
    expect(r).toMatchObject({ added: 2, pending: 2 });
  });
});

describe('matchFavourite', () => {
  const fav = (name: string) => ({ id: `t:${name}`, shopId: 't', shopName: 'Tesco', listingId: name, name, packSize: null, link: '', imageUrl: null, price: null, loyaltyPrice: null, foundAt: '' });
  const favourites = ['Tesco Unsalted Butter 250G', 'Tesco Salted Butter 250G', 'Tesco British Whole Milk 2.272L 4 Pints', 'Tesco Free Range Eggs 6 Pack'].map(fav);
  const names = (r: ReturnType<typeof matchFavourite>) => ({ match: r.match?.name ?? null, options: r.options.map((o) => o.name) });

  it('takes the one favourite with every word of the name', () => {
    expect(names(matchFavourite({ name: 'UNSALTED BUTTER', aliases: [] }, favourites))).toEqual({ match: 'Tesco Unsalted Butter 250G', options: [] });
    expect(names(matchFavourite({ name: 'Egg', aliases: [] }, favourites))).toEqual({ match: 'Tesco Free Range Eggs 6 Pack', options: [] });
  });

  it('tries the aliases when the name matches nothing', () => {
    expect(names(matchFavourite({ name: 'Fresh moo juice', aliases: ['whole milk'] }, favourites))).toEqual({ match: 'Tesco British Whole Milk 2.272L 4 Pints', options: [] });
  });

  it('gives the options when more than one matches, and nothing when none do', () => {
    expect(names(matchFavourite({ name: 'Butter', aliases: [] }, favourites))).toEqual({ match: null, options: ['Tesco Unsalted Butter 250G', 'Tesco Salted Butter 250G'] });
    expect(names(matchFavourite({ name: 'Bread', aliases: [] }, favourites))).toEqual({ match: null, options: [] });
  });
});
