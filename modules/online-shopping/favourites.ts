/**
 * Shop favourites into Pending: favourites not linked to any item wait there
 * to become a new item, be linked to one, or be dismissed. Dismissed ones are
 * remembered (by shop and code) and never come back unless the dismissal is undone.
 */
import { z } from 'zod';
import { NotFoundError, singularGuess, type ModuleContext } from '@larder/core';
import { PackSize, type Product as ShopProduct } from './contract';
import type { Provider } from './providers';
import type { Services } from './services';

export const PendingFavourite = z.object({
  /** "<shopId>:<listingId>" */
  id: z.string(),
  shopId: z.string(),
  shopName: z.string(),
  listingId: z.string(),
  name: z.string(),
  packSize: PackSize.nullable(),
  link: z.string(),
  imageUrl: z.string().nullable(),
  /** As of when the favourites were fetched. */
  price: z.number().nullable(),
  loyaltyPrice: z.number().nullable(),
  foundAt: z.string(),
}).meta({ id: 'PendingFavourite' });
export type PendingFavourite = z.infer<typeof PendingFavourite>;

export const Dismissed = PendingFavourite.extend({ dismissedAt: z.string() }).meta({ id: 'DismissedFavourite' });
export type Dismissed = z.infer<typeof Dismissed>;

export const SyncResult = z.object({
  shop: z.string(),
  /** New in Pending this time. */
  added: z.number(),
  /** Waiting in Pending for this shop now. */
  pending: z.number(),
  linked: z.number(),
  dismissed: z.number(),
  /** The provider couldn't reach the shop, so this is its older copy. */
  stale: z.boolean(),
  fetchedAt: z.string().nullable(),
  message: z.string(),
});
export type SyncResult = z.infer<typeof SyncResult>;

const key = (shopId: string, listingId: string) => `${shopId}:${listingId}`;

export function asShopProduct(f: PendingFavourite): ShopProduct {
  return { listing_id: f.listingId, name: f.name, pack_size: f.packSize, price: f.price, loyalty_price: f.loyaltyPrice, loyalty_price_valid: null, link: f.link, image_urls: f.imageUrl ? [f.imageUrl] : [] };
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The one favourite an item with no listing stands for: every word of its name
 * (else of one of its aliases) is in the favourite's name, and no other
 * favourite's. "Whole milk" is "Tesco British Whole Milk 4 Pints". More than
 * one is never guessed between: they come back as options.
 */
export function matchFavourite(item: { name: string; aliases: string[] }, favourites: PendingFavourite[]): { match: PendingFavourite | null; options: PendingFavourite[] } {
  // Plural or not ("pints" and "pint"), by the unit helpers' guess at a singular.
  const one = (text: string) => words(text).map(singularGuess);
  const named = favourites.map((f) => ({ f, words: new Set(one(f.name)) }));
  for (const term of [item.name, ...item.aliases]) {
    const want = one(term);
    if (!want.length) continue;
    const hits = named.filter((n) => want.every((w) => n.words.has(w))).map((n) => n.f);
    if (hits.length) return { match: hits.length === 1 ? hits[0]! : null, options: hits.length === 1 ? [] : hits };
  }
  return { match: null, options: [] };
}

export function createFavourites(ctx: ModuleContext, s: Services) {
  const pending = ctx.collection<PendingFavourite>('pending');
  const dismissed = ctx.collection<Dismissed>('dismissed');

  const toPending = (shopId: string, shopName: string, p: ShopProduct, foundAt: string): PendingFavourite => PendingFavourite.parse({
    id: key(shopId, p.listing_id), shopId, shopName, listingId: p.listing_id, name: p.name, packSize: p.pack_size, link: p.link, imageUrl: p.image_urls[0] ?? null,
    price: p.price, loyaltyPrice: p.loyalty_price, foundAt,
  });

  async function one(id: string): Promise<PendingFavourite> {
    const p = await pending.get(id);
    if (!p) throw new NotFoundError('Pending favourite', id);
    return PendingFavourite.parse(p);
  }

  return {
    async list(): Promise<PendingFavourite[]> {
      return (await pending.list()).map((d) => PendingFavourite.parse(d.data)).sort((a, b) => b.foundAt.localeCompare(a.foundAt) || a.name.localeCompare(b.name, 'en-GB'));
    },
    one,
    async dismissedList(): Promise<Dismissed[]> {
      return (await dismissed.list()).map((d) => Dismissed.parse(d.data)).sort((a, b) => b.dismissedAt.localeCompare(a.dismissedAt));
    },

    /** Reads the shop's favourites and puts new, unlinked, undismissed ones in Pending. */
    async sync(provider: Provider, o: { refresh?: boolean } = {}): Promise<SyncResult> {
      const shopName = await s.providers.shopName(provider.shopId);
      const client = await s.ready(provider);
      const list = await client.favourites(o.refresh ?? true);
      const linked = await s.items.linked();
      const gone = new Set((await dismissed.list()).map((d) => d.id));
      const waiting = new Map((await pending.list()).map((d) => [d.id, PendingFavourite.parse(d.data)]));
      const now = ctx.core.now();
      let added = 0;
      let linkedCount = 0;
      let dismissedCount = 0;
      const seen = new Set<string>();
      for (const f of list.favourites) {
        const id = key(provider.shopId, f.listing_id);
        seen.add(id);
        if (linked.has(id)) {
          linkedCount++;
          if (waiting.has(id)) await pending.remove(id);
          continue;
        }
        if (gone.has(id)) {
          dismissedCount++;
          continue;
        }
        const before = waiting.get(id);
        if (!before) added++;
        await pending.put(id, toPending(provider.shopId, shopName, f, before?.foundAt ?? now));
      }
      // Taken out of the shop's favourites since: no longer waiting (only when the list is fresh).
      if (!list.stale) for (const [id, p] of waiting) if (p.shopId === provider.shopId && !seen.has(id)) await pending.remove(id);
      const count = (await pending.list()).filter((d) => d.data.shopId === provider.shopId).length;
      const result = {
        shop: shopName, added, pending: count, linked: linkedCount, dismissed: dismissedCount, stale: list.stale, fetchedAt: list.fetched_at,
        message: [
          list.stale ? `Couldn't reach ${shopName} (${list.stale_reason?.message ?? 'no answer'}), so this is the copy from ${list.fetched_at?.slice(0, 10) ?? 'before'}.` : '',
          added ? `${added} new ${shopName} favourite${added === 1 ? ' is' : 's are'} in Pending (${count} waiting).` : count ? `No new ${shopName} favourites; ${count} still waiting in Pending.` : `No new ${shopName} favourites.`,
          `${linkedCount} ${linkedCount === 1 ? 'is' : 'are'} already linked to items${dismissedCount ? `, and ${dismissedCount} you dismissed ${dismissedCount === 1 ? 'was' : 'were'} left out` : ''}.`,
        ].filter(Boolean).join(' '),
      };
      if (added) ctx.publish('online-shopping.favourites_pending', { shop: shopName, added, pending: count });
      return SyncResult.parse(result);
    },

    /** Puts one product in Pending (e.g. just added to favourites without an item). */
    async addPending(shopId: string, p: ShopProduct): Promise<PendingFavourite | null> {
      const id = key(shopId, p.listing_id);
      if ((await s.items.linked()).has(id) || (await dismissed.get(id))) return null;
      const entry = toPending(shopId, await s.providers.shopName(shopId), p, ctx.core.now());
      await pending.put(id, entry);
      return entry;
    },

    /** Linked to an item (an existing one, or one just made from it): it leaves Pending. */
    async link(id: string, productId: string) {
      const f = await one(id);
      const r = await s.items.link(productId, f.shopId, asShopProduct(f));
      await pending.remove(id);
      return { ...r, favourite: f };
    },

    async dismiss(id: string): Promise<PendingFavourite> {
      const f = await one(id);
      await dismissed.put(id, Dismissed.parse({ ...f, dismissedAt: ctx.core.now() }));
      await pending.remove(id);
      return f;
    },

    /** Undoes a dismissal: it's back in Pending. */
    async undismiss(id: string): Promise<PendingFavourite> {
      const d = await dismissed.get(id);
      if (!d) throw new NotFoundError('Dismissed favourite', id);
      const { dismissedAt: _, ...f } = Dismissed.parse(d);
      await dismissed.remove(id);
      if (!(await s.items.linked()).has(id)) await pending.put(id, PendingFavourite.parse({ ...f, foundAt: ctx.core.now() }));
      return PendingFavourite.parse(f);
    },

    /** Saves its picture as a Larder photo, for the item made from it. */
    async photo(id: string): Promise<string | null> {
      const f = await one(id);
      return f.imageUrl ? ctx.core.lookup.savePhotoFromLink(f.imageUrl, f.name) : null;
    },
  };
}
export type Favourites = ReturnType<typeof createFavourites>;
