import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
import onlineShopping from './index';
import { packQuantityFor, type OnlineFields } from './items';
import { fakeProvider } from './test-provider';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = <T = unknown>(core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}, query: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'online-shopping' && r.route.method === method && r.route.path === path)!.route.handler({ body, query, params, userId: null }) as Promise<T>;

/** A 1×1 PNG, for the shop's picture. */
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

async function setup() {
  const shop = fakeProvider();
  const pictures: string[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://digitalcontent.api.tesco.com/')) {
      pictures.push(url);
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return shop.fetch(input, init);
  }) as typeof globalThis.fetch;
  const core = await makeCore({ modules: [onlineShopping], fetch });
  const tesco = await core.shops.addPreset('Tesco');
  await call(core, 'POST', '/providers', { type: 'tesco', shopId: tesco.id, address: '192.168.1.231:8710', token: 'secret' });
  shop.listing('1001', 'Tesco Soft White Toilet Tissue 9 Rolls', { amount: 9, unit: 'each' }, 4.5);
  shop.listing('1002', 'Andrex Classic Clean Toilet Tissue 24 Rolls', { amount: 24, unit: 'each' }, 9, { loyalty_price: 7.5 });
  shop.listing('2001', 'Tesco Closed Cup Mushrooms 300G', { amount: 0.3, unit: 'kg' }, 0.89);
  shop.listing('3001', 'Heinz Baked Beanz 4 X 415G', { amount: 1.66, unit: 'kg' }, 4.2);
  const loo = await core.products.create({ name: 'Toilet roll', aliases: ['loo roll'], unit: 'roll', minQuantity: 4, stockUpTo: 12 });
  return { core, shop, tesco, loo, pictures };
}

const fields = (core: Core, id: string) => core.products.summary(id).then((s) => s.product.fields['online-shopping'] as OnlineFields);

describe('online shopping: item settings', () => {
  it('works out how many of the item one pack gives, and says when it is only a guess', () => {
    expect(packQuantityFor({ amount: 0.3, unit: 'kg' }, 'Mushrooms 300G', 'g')).toEqual({ quantity: 300, guessed: false });
    expect(packQuantityFor({ amount: 0.3, unit: 'kg' }, 'Mushrooms 300G', 'kg')).toEqual({ quantity: 0.3, guessed: false });
    expect(packQuantityFor({ amount: 2.272, unit: 'l' }, 'Semi Skimmed Milk 4 Pints', 'L')).toEqual({ quantity: 2.272, guessed: false });
    expect(packQuantityFor({ amount: 9, unit: 'each' }, 'Toilet Tissue 9 Rolls', 'roll')).toEqual({ quantity: 9, guessed: false });
    expect(packQuantityFor({ amount: 6, unit: 'each' }, 'Free Range Eggs 6 Pack', 'egg')).toEqual({ quantity: 6, guessed: false });
    expect(packQuantityFor({ amount: 100, unit: 'each' }, 'Cable Ties 100 Pack', 'box')).toEqual({ quantity: 100, guessed: true });
    expect(packQuantityFor({ amount: 1.66, unit: 'kg' }, 'Heinz Baked Beanz 4 X 415G', 'tin')).toEqual({ quantity: 4, guessed: true });
    expect(packQuantityFor(null, 'Something', 'bag')).toEqual({ quantity: 1, guessed: true });
  });

  it('links listings by code or link, one item per listing', async () => {
    const { core, tesco, loo } = await setup();
    const a = await call<{ message: string }>(core, 'POST', '/items/:productId/listings', { shopId: tesco.id, idOrLink: '1001' }, { productId: loo.id });
    expect(a.message).toBe('Tesco Soft White Toilet Tissue 9 Rolls at Tesco is linked to Toilet roll (1 pack = 9 rolls). It\'s bought from Tesco now.');
    expect((await core.products.summary(loo.id)).product.preferredShopIds).toEqual([tesco.id]);
    await call(core, 'POST', '/items/:productId/listings', { shopId: tesco.id, idOrLink: 'https://www.tesco.com/groceries/en-GB/products/1002' }, { productId: loo.id });
    const f = await fields(core, loo.id);
    expect(f.shops[tesco.id]!.listings.map((l) => [l.listingId, l.packQuantity, l.guessed])).toEqual([['1001', 9, false], ['1002', 24, false]]);
    expect(f.shops[tesco.id]!.packRule).toBe('cheapest');

    const kitchen = await core.products.create({ name: 'Kitchen roll', unit: 'roll' });
    await expect(call(core, 'POST', '/items/:productId/listings', { shopId: tesco.id, idOrLink: '1001' }, { productId: kitchen.id }))
      .rejects.toThrow('Tesco Soft White Toilet Tissue 9 Rolls is already linked to Toilet roll. Unlink it there first.');
    await expect(call(core, 'POST', '/items/:productId/listings', { shopId: tesco.id, idOrLink: '9999' }, { productId: kitchen.id }))
      .rejects.toThrow('Tesco has no product with that code or link.');

    await call(core, 'DELETE', '/items/:productId/listings/:listingId', undefined, { productId: loo.id, listingId: '1001' }, { shopId: tesco.id });
    expect((await fields(core, loo.id)).shops[tesco.id]!.listings.map((l) => l.listingId)).toEqual(['1002']);
  });

  it('gives an item with no shop the linked one, and leaves one set to another shop alone', async () => {
    const { core } = await setup();
    const aldi = await core.shops.addPreset('Aldi');
    const mush = await core.products.create({ name: 'Mushrooms', unit: 'g', preferredShopIds: [aldi.id] });
    const r = await core.assistant.call('link_listing', { item: 'mushrooms', id_or_link: '2001' });
    expect(r.text).toBe('Tesco Closed Cup Mushrooms 300G at Tesco is linked to Mushrooms (1 pack = 300 g).');
    expect((await core.products.summary(mush.id)).product.preferredShopIds).toEqual([aldi.id]);
  });

  it('adds to the shop\'s favourites while linking, when asked', async () => {
    const { core, shop, tesco, loo } = await setup();
    const r = await call<{ message: string }>(core, 'POST', '/items/:productId/listings', { shopId: tesco.id, idOrLink: '1002', addToFavourites: true }, { productId: loo.id });
    expect(r.message).toBe('Andrex Classic Clean Toilet Tissue 24 Rolls at Tesco is linked to Toilet roll (1 pack = 24 rolls) and added to your Tesco favourites. It\'s bought from Tesco now.');
    expect(shop.state.favourites).toEqual(['1002']);
  });

  it('asks for a guessed pack size to be checked, and keeps a corrected one', async () => {
    const { core, tesco } = await setup();
    await core.products.create({ name: 'Baked beans', unit: 'tin' });
    const r = await core.assistant.call('link_listing', { item: 'baked beans', id_or_link: '3001', shop: 'tesco' });
    expect(r.text).toBe('Heinz Baked Beanz 4 X 415G at Tesco is linked to Baked beans (1 pack = 4 tins: check this). It\'s bought from Tesco now. Ask how many tin one pack holds if that\'s wrong, and say it with pack_quantity.');
    const beans = await core.resolve.product('baked beans');
    await call(core, 'PATCH', '/items/:productId/listings/:listingId', { shopId: tesco.id, packQuantity: 4 }, { productId: beans.id, listingId: '3001' });
    expect((await fields(core, beans.id)).shops[tesco.id]!.listings[0]).toMatchObject({ packQuantity: 4, guessed: false });
    // Linking it again (fresh details from the shop) keeps the checked pack size.
    await core.assistant.call('link_listing', { item: 'baked beans', id_or_link: '3001' });
    expect((await fields(core, beans.id)).shops[tesco.id]!.listings[0]).toMatchObject({ packQuantity: 4, guessed: false });
  });

  it('sets target prices, the on-offer amount and the pack rule', async () => {
    const { core, tesco, loo } = await setup();
    await core.assistant.call('link_listing', { item: 'loo roll', id_or_link: '1001' });
    const r = await core.assistant.call('set_buying_rules', { item: 'loo roll', target_price: 0.32, offer_stock_up_to: 36, pack_rule: 'fixed' });
    expect(r.text).toBe('Toilet roll: on offer at £0.32 a roll or less, stock up to 36 rolls when on offer, always the same pack at Tesco.');
    expect(await fields(core, loo.id)).toMatchObject({ targetPrice: 0.32, offerStockUpTo: 36, shops: { [tesco.id]: { packRule: 'fixed' } } });
    await expect(core.assistant.call('set_buying_rules', { item: 'loo roll' })).rejects.toThrow('Say what to change');

    // The normal stock-up amount is the item's own, set like the minimum.
    expect((await core.assistant.call('change_item', { item: 'loo roll', stock_up_to: 18 })).text).toBe('Toilet roll is updated: stock up to 18 rolls.');
    expect((await core.assistant.call('get_item', { item: 'loo roll' })).text).toContain('Stock up to 18 rolls when buying more.');
  });

  it('uses the shop\'s picture as the item\'s photo', async () => {
    const { core, tesco, loo, pictures } = await setup();
    await call(core, 'POST', '/items/:productId/listings', { shopId: tesco.id, idOrLink: '1002' }, { productId: loo.id });
    const r = await call<{ photoFileIds: string[] }>(core, 'POST', '/items/:productId/shop-image', { shopId: tesco.id, listingId: '1002' }, { productId: loo.id });
    expect(r.photoFileIds).toHaveLength(1);
    expect(pictures).toEqual(['https://digitalcontent.api.tesco.com/v2/media/ghs/1002.jpeg']);
  });

  it('looks a product up for an assistant', async () => {
    const { core } = await setup();
    await core.assistant.call('link_listing', { item: 'loo roll', id_or_link: '1002' });
    const r = await core.assistant.call('get_product', { id_or_link: '1002' });
    expect(r.text).toBe([
      'Andrex Classic Clean Toilet Tissue 24 Rolls (code 1002), pack 24, £9.00, £7.50 with Clubcard',
      'https://www.tesco.com/groceries/en-GB/products/1002',
      'Picture: https://digitalcontent.api.tesco.com/v2/media/ghs/1002.jpeg',
      'Linked to Toilet roll.',
    ].join('\n'));
  });
});
