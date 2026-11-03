/**
 * An item's online-shopping settings: linking listings (by code or link, from
 * the provider), the pack rule, target prices and the on-offer stock-up
 * amount, the shop's picture as the item's photo; and the tools for them.
 */
import { z } from 'zod';
import { Id, LarderError, ValidationError, type ModuleContext } from '@larder/core';
import { productLine, perUnit, qty } from './format';
import { Listing, OnlineFields, PackRule, fieldsOf, packText } from './items';
import { Shop } from './providers-api';
import type { Services } from './services';

const ListingAnswer = z.object({ listing: Listing, fields: OnlineFields, message: z.string() });

export function itemFeatures(ctx: ModuleContext, s: Services) {
  const { providers, items } = s;

  /** Looks a product up by code or link, adding it to the shop's favourites too if asked. */
  async function fetchProduct(shopId: string, idOrLink: string, addToFavourites: boolean) {
    const provider = await providers.forShop(shopId);
    if (!provider) throw new LarderError(`Larder can't look things up at ${await providers.shopName(shopId)}: it has no shopping provider. Add one in Settings → Shopping providers.`, 409, 'no_provider');
    if (addToFavourites && !s.can(provider, 'add_favourites')) throw new ValidationError(`The ${await providers.shopName(shopId)} provider can't add favourites yet. Link it without adding it to favourites.`);
    const client = await s.ready(provider);
    return addToFavourites ? client.addFavourite(idOrLink.trim()) : client.product(idOrLink.trim());
  }

  async function linkText(productId: string, listing: Listing, shopId: string, favourite: boolean): Promise<string> {
    const item = await items.product(productId);
    const shop = await providers.shopName(shopId);
    return `${listing.name} at ${shop} is linked to ${item.name} (${packText(listing, item.unit)}${listing.guessed ? ': check this' : ''})${favourite ? ` and added to your ${shop} favourites` : ''}.`;
  }

  /* ---------------------------------- Routes --------------------------------- */

  ctx.addRoute({
    method: 'POST', path: '/items/:productId/listings', summary: 'Link a shop\'s product to an item by its code or link',
    description: 'Looks the product up with the shop\'s provider (adding it to the shop\'s favourites too with addToFavourites), and works out how many of the item one pack gives from its pack size (check it when it says guessed). A code or link the shop doesn\'t know is refused, never guessed.',
    params: z.object({ productId: Id }),
    body: z.object({ shopId: Id, idOrLink: z.string().min(1).max(2000), addToFavourites: z.boolean().optional(), packQuantity: z.number().positive().optional() }),
    response: ListingAnswer,
    async handler({ params, body }) {
      const p = await fetchProduct(body.shopId, body.idOrLink, !!body.addToFavourites);
      const { product, listing } = await items.link(params.productId, body.shopId, p, { packQuantity: body.packQuantity });
      return { listing, fields: OnlineFields.parse(product.fields['online-shopping']), message: await linkText(product.id, listing, body.shopId, !!body.addToFavourites) };
    },
  });

  ctx.addRoute({
    method: 'PATCH', path: '/items/:productId/listings/:listingId', summary: 'Say how many of the item one pack of a listing gives',
    params: z.object({ productId: Id, listingId: z.string().min(1) }),
    body: z.object({ shopId: Id, packQuantity: z.number().positive() }),
    response: OnlineFields,
    async handler({ params, body }) {
      return OnlineFields.parse((await items.setPack(params.productId, body.shopId, params.listingId, body.packQuantity)).fields['online-shopping']);
    },
  });

  ctx.addRoute({
    method: 'DELETE', path: '/items/:productId/listings/:listingId', summary: 'Unlink a listing from an item',
    params: z.object({ productId: Id, listingId: z.string().min(1) }), query: z.object({ shopId: Id }),
    response: OnlineFields,
    async handler({ params, query }) {
      return OnlineFields.parse((await items.unlink(params.productId, query.shopId, params.listingId)).fields['online-shopping']);
    },
  });

  ctx.addRoute({
    method: 'PUT', path: '/items/:productId/shops/:shopId', summary: 'Set an item\'s pack rule and target price at one shop',
    description: 'packRule: fixed (always one listing, fixedListingId or the first) or cheapest (the cheapest mix of listings that covers what\'s needed). targetPrice is per one of the item\'s unit and overrides the item\'s own (null to use it).',
    params: z.object({ productId: Id, shopId: Id }),
    body: z.object({ packRule: PackRule.optional(), fixedListingId: z.string().nullable().optional(), targetPrice: z.number().min(0).nullable().optional() }),
    response: OnlineFields,
    async handler({ params, body }) {
      return OnlineFields.parse((await items.setShopRules(params.productId, params.shopId, body)).fields['online-shopping']);
    },
  });

  ctx.addRoute({
    method: 'PUT', path: '/items/:productId/rules', summary: 'Set an item\'s target price and on-offer stock-up amount',
    description: 'targetPrice is per one of the item\'s unit: at or below it counts as on offer, and the order tops up to offerStockUpTo. The normal stock-up amount is the item\'s own stockUpTo.',
    params: z.object({ productId: Id }),
    body: z.object({ offerStockUpTo: z.number().min(0).nullable().optional(), targetPrice: z.number().min(0).nullable().optional() }),
    response: OnlineFields,
    async handler({ params, body }) {
      return OnlineFields.parse((await items.setRules(params.productId, body)).fields['online-shopping']);
    },
  });

  ctx.addRoute({
    method: 'POST', path: '/items/:productId/shop-image', summary: 'Use a linked listing\'s picture as the item\'s photo',
    params: z.object({ productId: Id }), body: z.object({ shopId: Id, listingId: z.string().min(1) }),
    response: z.object({ photoFileIds: z.array(z.string()) }),
    async handler({ params, body }) {
      return { photoFileIds: (await items.useShopImage(params.productId, body.shopId, body.listingId)).photoFileIds };
    },
  });

  /* ---------------------------------- Tools ---------------------------------- */

  ctx.addTool({
    name: 'get_product', title: 'Look up a product at an online shop', readOnly: true,
    description: 'A shop\'s product by its code or link: name, pack size, price, loyalty price, link and picture (e.g. to use as an item\'s photo). An unknown code or link is refused, never guessed.',
    input: z.object({ id_or_link: z.string().min(1).max(2000).describe('The shop\'s product code or a link to its page'), shop: Shop }),
    async run({ id_or_link, shop }) {
      const { provider, shop: sh } = await providers.resolve(shop);
      const p = await (await s.ready(provider)).product(id_or_link.trim());
      const owner = (await items.linked()).get(`${sh.id}:${p.listing_id}`);
      const text = [productLine(p, await s.currency(), sh.name === 'Tesco' ? 'Clubcard' : 'loyalty card'), p.link, ...(p.image_urls[0] ? [`Picture: ${p.image_urls[0]}`] : []), owner ? `Linked to ${owner.name}.` : 'Not linked to an item yet (link_listing).'].join('\n');
      return { text, data: { product: p, linked_to: owner?.name ?? null } };
    },
  });

  ctx.addTool({
    name: 'link_listing', title: 'Link a shop\'s product to an item',
    description: 'Say which product to buy online for an item, by the shop\'s code or a link to it (e.g. a Tesco link the person pasted). Optionally adds it to the shop\'s favourites too. An item can have several (a small and a large pack). Then set_buying_rules sets offers and pack choice.',
    input: z.object({
      item: z.string().min(1).max(200).describe('The Larder item, e.g. "toilet roll"'),
      id_or_link: z.string().min(1).max(2000).describe('The shop\'s product code or link'),
      shop: Shop,
      add_to_favourites: z.boolean().optional().describe('Also add it to the shop\'s favourites'),
      pack_quantity: z.number().positive().optional().describe('How many of the item one pack gives (e.g. 9 for 9 rolls), when it isn\'t clear from the pack size'),
    }),
    async run({ item, id_or_link, shop, add_to_favourites, pack_quantity }) {
      const product = await ctx.core.resolve.product(item);
      const { shop: sh } = await providers.resolve(shop);
      const p = await fetchProduct(sh.id, id_or_link, !!add_to_favourites);
      const { listing } = await items.link(product.id, sh.id, p, { packQuantity: pack_quantity });
      const text = await linkText(product.id, listing, sh.id, !!add_to_favourites);
      return { text: listing.guessed ? `${text} Ask how many ${product.unit} one pack holds if that's wrong, and say it with pack_quantity.` : text, data: { item: product.name, listing } };
    },
  });

  ctx.addTool({
    name: 'set_buying_rules', title: 'Set an item\'s online buying rules', destructive: true,
    description: 'For online shops: the target price per one of the item\'s unit (at or below it counts as on offer), how many to stock up to when on offer, and whether to always buy one pack or the cheapest mix. The normal stock-up amount and minimum are set with change_item. Only the fields given change.',
    input: z.object({
      item: z.string().min(1).max(200).describe('The Larder item'),
      target_price: z.number().min(0).nullable().optional().describe('Price per one of the item\'s unit, e.g. 0.25 for 25p a roll; null for none'),
      offer_stock_up_to: z.number().min(0).nullable().optional().describe('How many to have after buying when it\'s on offer, e.g. 36; null for the normal amount'),
      shop: Shop,
      pack_rule: PackRule.optional().describe('At that shop: "fixed" always buys the first linked pack, "cheapest" the cheapest mix of packs'),
      shop_target_price: z.number().min(0).nullable().optional().describe('A different target price at that shop only; null to use the item\'s'),
    }),
    async run(i) {
      const product = await ctx.core.resolve.product(i.item);
      const cur = await s.currency();
      const said: string[] = [];
      if (i.target_price !== undefined || i.offer_stock_up_to !== undefined) {
        await items.setRules(product.id, { ...(i.target_price !== undefined ? { targetPrice: i.target_price } : {}), ...(i.offer_stock_up_to !== undefined ? { offerStockUpTo: i.offer_stock_up_to } : {}) });
        if (i.target_price !== undefined) said.push(i.target_price === null ? 'no target price' : `on offer at ${perUnit(i.target_price, product.unit, cur)} or less`);
        if (i.offer_stock_up_to !== undefined) said.push(i.offer_stock_up_to === null ? 'no extra when on offer' : `stock up to ${qty(i.offer_stock_up_to, product.unit)} when on offer`);
      }
      if (i.pack_rule !== undefined || i.shop_target_price !== undefined) {
        const { shop: sh } = await providers.resolve(i.shop);
        await items.setShopRules(product.id, sh.id, { ...(i.pack_rule ? { packRule: i.pack_rule } : {}), ...(i.shop_target_price !== undefined ? { targetPrice: i.shop_target_price } : {}) });
        if (i.pack_rule) said.push(i.pack_rule === 'fixed' ? `always the same pack at ${sh.name}` : `the cheapest mix of packs at ${sh.name}`);
        if (i.shop_target_price !== undefined) said.push(i.shop_target_price === null ? `the usual target price at ${sh.name}` : `on offer at ${sh.name} at ${perUnit(i.shop_target_price, product.unit, cur)} or less`);
      }
      if (!said.length) throw new ValidationError('Say what to change: target_price, offer_stock_up_to, pack_rule or shop_target_price.');
      const fields = fieldsOf(await items.product(product.id));
      const listed = Object.values(fields.shops).some((r) => r.listings.length);
      return { text: `${product.name}: ${said.join(', ')}.${listed ? '' : ' It has no shop listings yet (link_listing).'}`, data: { item: product.name, ...fields } };
    },
  });
}
