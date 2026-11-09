/**
 * Favourites: syncing them into Pending (the app, sync_favourites, and a Home
 * Assistant action for a schedule), deciding each one, dismissals in
 * Settings, and add_to_favourites.
 */
import { z } from 'zod';
import { Id, NotFoundError, ValidationError, type ModuleContext } from '@larder/core';
import { productLine } from './format';
import { Dismissed, PendingFavourite, SyncResult, type Favourites } from './favourites';
import { Listing, packText, shopSetText } from './items';
import { Shop } from './providers-api';
import type { Services } from './services';

export function favouriteFeatures(ctx: ModuleContext, s: Services, favourites: Favourites) {
  const { providers, items } = s;

  async function sync(shop: string | undefined, refresh = true): Promise<SyncResult> {
    const { provider, shop: sh } = await providers.resolve(shop);
    if (!s.can(provider, 'favourites')) throw new ValidationError(`The ${sh.name} provider can't read favourites.`);
    return favourites.sync(provider, { refresh });
  }

  /* ---------------------------------- Routes --------------------------------- */

  ctx.addRoute({
    method: 'GET', path: '/pending', summary: 'Shop favourites waiting in Pending: not linked to any item, not dismissed',
    response: z.array(PendingFavourite),
    handler: () => favourites.list(),
  });

  ctx.addRoute({
    method: 'POST', path: '/shops/:shopId/favourites/sync', summary: 'Read the shop\'s favourites and put new, unlinked ones in Pending',
    description: 'refresh: false uses the provider\'s copy without asking the shop (quicker). Favourites already linked to an item, or dismissed, are left out.',
    params: z.object({ shopId: Id }), body: z.object({ refresh: z.boolean().optional() }), response: SyncResult,
    async handler({ params, body }) {
      const shop = (await ctx.core.shops.list()).find((x) => x.id === params.shopId);
      if (!shop) throw new NotFoundError('Shop', params.shopId);
      return sync(shop.id, body?.refresh ?? true);
    },
  });

  ctx.addRoute({
    method: 'POST', path: '/pending/:id/link', summary: 'Link a pending favourite to an item you have; it leaves Pending',
    description: 'A new code for a product that has gone replaces the item\'s gone listing.',
    params: z.object({ id: z.string() }), body: z.object({ productId: Id }),
    response: z.object({ listing: Listing, message: z.string() }),
    async handler({ params, body }) {
      const r = await favourites.link(params.id, body.productId);
      return { listing: r.listing, message: `${r.favourite.name} is linked to ${r.product.name} (${packText(await ctx.core.units.list(), r.listing, r.product.unit)}${r.listing.guessed ? ': check this' : ''}).${shopSetText(r.shopSet, r.favourite.shopName)}` };
    },
  });

  ctx.addRoute({
    method: 'POST', path: '/pending/:id/photo', summary: 'Save a pending favourite\'s picture as a Larder photo, for the item about to be made from it',
    params: z.object({ id: z.string() }), response: z.object({ photoFileId: z.string().nullable() }),
    async handler({ params }) {
      return { photoFileId: await favourites.photo(params.id) };
    },
  });

  ctx.addRoute({
    method: 'POST', path: '/pending/:id/added', summary: 'A pending favourite became a new item (through the Add item page): it\'s linked and leaves Pending',
    params: z.object({ id: z.string() }), body: z.object({ productId: Id }), response: z.object({ listing: Listing }),
    async handler({ params, body }) {
      return { listing: (await favourites.link(params.id, body.productId)).listing };
    },
  });

  ctx.addRoute({
    method: 'POST', path: '/pending/:id/dismiss', summary: 'Not wanted: it leaves Pending and isn\'t suggested again (undo in Settings)',
    params: z.object({ id: z.string() }), response: PendingFavourite,
    handler: ({ params }) => favourites.dismiss(params.id),
  });

  ctx.addRoute({
    method: 'GET', path: '/dismissed', summary: 'Favourites dismissed from Pending, newest first',
    response: z.array(Dismissed),
    handler: () => favourites.dismissedList(),
  });

  ctx.addRoute({
    method: 'DELETE', path: '/dismissed/:id', summary: 'Undo a dismissal: the favourite is back in Pending',
    params: z.object({ id: z.string() }), response: PendingFavourite,
    handler: ({ params }) => favourites.undismiss(params.id),
  });

  /* ------------------------------ Tools and actions ----------------------------- */

  ctx.addTool({
    name: 'sync_favourites', title: 'Bring in shop favourites',
    description: 'Read the online shop\'s favourites and put any not linked to an item yet in Pending, for the person to make into items, link or dismiss in the app. Dismissed ones stay out.',
    input: z.object({ shop: Shop }),
    async run({ shop }) {
      const r = await sync(shop);
      return { text: r.message, data: r };
    },
  });

  ctx.addTool({
    name: 'add_to_favourites', title: 'Add a product to the shop\'s favourites',
    description: 'Add a product to the online shop\'s favourites by its exact code or link, optionally linking it to a Larder item at the same time. Unknown codes are refused, never guessed.',
    input: z.object({
      id_or_link: z.string().min(1).max(2000).describe('The shop\'s product code or a link to it'),
      shop: Shop,
      item: z.string().max(200).optional().describe('The Larder item to link it to, if any'),
    }),
    async run({ id_or_link, shop, item }) {
      const { provider, shop: sh } = await providers.resolve(shop);
      if (!s.can(provider, 'add_favourites')) throw new ValidationError(`The ${sh.name} provider can't add favourites yet. Add it on ${sh.name}'s website.`);
      const product = item ? await ctx.core.resolve.product(item) : null;
      const p = await (await s.ready(provider)).addFavourite(id_or_link.trim());
      const units = await ctx.core.units.list();
      const line = productLine(units, p, await s.currency(), sh.name === 'Tesco' ? 'Clubcard' : 'loyalty card');
      if (product) {
        const { listing, shopSet } = await items.link(product.id, sh.id, p);
        return { text: `Added to your ${sh.name} favourites: ${line}. Linked to ${product.name} (${packText(units, listing, product.unit)}${listing.guessed ? ': check this' : ''}).${shopSetText(shopSet, sh.name)}`, data: { product: p, item: product.name } };
      }
      const owner = (await items.linked()).get(`${sh.id}:${p.listing_id}`);
      if (!owner) await favourites.addPending(sh.id, p);
      return { text: `Added to your ${sh.name} favourites: ${line}. ${owner ? `It's linked to ${owner.name}.` : 'It\'s waiting in Pending to become an item or be linked to one.'}`, data: { product: p, item: owner?.name ?? null } };
    },
  });

  ctx.addAction({
    id: 'online_shopping_sync_favourites', name: 'Bring in shop favourites',
    description: 'Reads an online shop\'s favourites and puts new ones (not linked to an item, not dismissed) in Larder\'s Pending list. For a schedule, e.g. weekly.',
    input: z.object({ shop: z.string().max(80).optional().describe('The shop, e.g. Tesco. Leave out for the default online shop') }),
    async run({ shop }) {
      const r = await sync(shop);
      return { message: r.message, added: r.added, pending: r.pending };
    },
  });
}
