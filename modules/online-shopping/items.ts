/**
 * Each item's online-shopping settings (`product.fields['online-shopping']`):
 * its listings at each shop (product codes, each with how many of the item one
 * pack gives), the pack rule, and the prices that count as an offer.
 * The normal stock-up amount is the item's own `stockUpTo`, used in the shop too.
 */
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError, amountText, canConvert, isLoose, roundQty, toBoughtIn, type ModuleContext, type Product, type Units } from '@larder/core';
import { PackSize, type Product as ShopProduct } from './contract';

export const Listing = z.object({
  /** The shop's product code. */
  listingId: z.string().min(1).max(200),
  name: z.string().max(300).default(''),
  /** How many of what the item is bought in one pack gives: 9 (rolls), 250 (g, for something bought loose), 1 (bag). */
  packQuantity: z.number().positive().max(1_000_000),
  /** Larder worked packQuantity out from the shop's pack size or name, and nobody has checked it. */
  guessed: z.boolean().default(false),
  /** The shop's own pack size, as the provider gave it. */
  packSize: PackSize.nullable().default(null),
  link: z.string().max(2000).nullable().default(null),
  imageUrl: z.string().max(2000).nullable().default(null),
  /** When the shop said this product has gone (often a new code for the same thing): link the new one. */
  deadSince: z.string().nullable().default(null),
  addedAt: z.string(),
});
export type Listing = z.infer<typeof Listing>;

export const PackRule = z.enum(['fixed', 'cheapest']);

export const ShopRules = z.object({
  listings: z.array(Listing).max(12).default([]),
  /** fixed: always this one listing. cheapest: the cheapest mix of listings that covers what's needed. */
  packRule: PackRule.default('cheapest'),
  /** For a fixed pack: which listing (the first, if not set). */
  fixedListingId: z.string().nullable().default(null),
  /** This shop's target price per one of what the item is bought in, instead of the item's own. */
  targetPrice: z.number().min(0).nullable().default(null),
});
export type ShopRules = z.infer<typeof ShopRules>;

export const OnlineFields = z.object({
  /** By shop id. */
  shops: z.record(z.string(), ShopRules).default({}),
  /** When it's on offer, top up to this (higher than the normal stock-up amount). */
  offerStockUpTo: z.number().min(0).nullable().default(null),
  /** The price per one of what the item is bought in the household is happy to pay: at or below it counts as on offer. */
  targetPrice: z.number().min(0).nullable().default(null),
});
export type OnlineFields = z.infer<typeof OnlineFields>;

const KEY = 'online-shopping';

export const fieldsOf = (p: Product): OnlineFields => OnlineFields.parse(p.fields[KEY] ?? {});
export const rulesFor = (p: Product, shopId: string): ShopRules => ShopRules.parse(fieldsOf(p).shops[shopId] ?? {});

/**
 * How many of what the item is bought in one pack gives, from the shop's pack size and name, through
 * the core's converter. A weight or volume is sure when the item is bought loose or has a Weight (a
 * 1.6 kg pack of 400 g tins is 4 tins). A count is sure when the name says what it is and
 * that's what the item is bought in or what's in its pack ("Toilet Tissue 9 Rolls"); otherwise it's a guess for
 * the person to check ("1 pack = 9 rolls").
 */
export function packQuantityFor(units: Units, pack: PackSize | null, name: string, item: Product): { quantity: number; guessed: boolean } {
  const sure = (n: number) => ({ quantity: roundQty(n), guessed: false });
  if (pack && pack.unit !== 'each' && canConvert(units, item, pack.unit)) return sure(toBoughtIn(units, item, pack.amount, pack.unit));
  if (pack?.unit === 'each') {
    // What it's bought in, or what's in its pack, said in the name: 9 rolls of a roll, or of packs of 9 rolls.
    const counted = [item.unit, ...(item.packSize ? [item.packSize.unit] : [])].map((k) => units.find(k)).filter((u) => !!u && u.kind === 'count');
    for (const u of counted) {
      const said = [u!.one, u!.many].some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(name));
      if (said || u!.key === 'each') return sure(toBoughtIn(units, item, pack.amount, u!.key));
    }
    return { quantity: pack.amount, guessed: true };
  }
  const multi = /(\d+)\s*[x×]\s*\d/i.exec(name);
  if (multi && !isLoose(units, item)) return { quantity: Number(multi[1]), guessed: true };
  return { quantity: 1, guessed: true };
}

/** Said after linking when the item had no shop: " It's bought from Tesco now." */
export const shopSetText = (shopSet: boolean, shopName: string) => (shopSet ? ` It's bought from ${shopName} now.` : '');

/** "1 pack = 9 rolls", "1 pack = 300 g" */
export function packText(units: Units, l: Pick<Listing, 'packQuantity'>, unit: string): string {
  return `1 pack = ${amountText(units, l.packQuantity, unit)}`;
}

export function createItems(ctx: ModuleContext) {
  async function product(id: string): Promise<Product> {
    const s = await ctx.core.products.summary(id).catch(() => null);
    if (!s) throw new NotFoundError('Item', id);
    return s.product;
  }

  /** Changes this module's field on an item from its current value. */
  function change(productId: string, fn: (f: OnlineFields) => OnlineFields): Promise<Product> {
    return ctx.core.products.updateField<unknown>(productId, KEY, (cur) => OnlineFields.parse(fn(OnlineFields.parse(cur ?? {}))));
  }

  /** Every linked listing: "<shopId>:<listingId>" → the item it belongs to. */
  async function linked(): Promise<Map<string, Product>> {
    const out = new Map<string, Product>();
    for (const s of [...(await ctx.core.products.list({ status: 'all' })), ...(await ctx.core.products.list({ status: 'wish' }))]) {
      for (const [shopId, rules] of Object.entries(fieldsOf(s.product).shops)) for (const l of rules.listings) out.set(`${shopId}:${l.listingId}`, s.product);
    }
    return out;
  }

  return {
    product,
    change,
    linked,

    /**
     * Links a shop's product to an item (or refreshes its details if it's already linked there).
     * An item with no preferred shop gets this one (`shopSet`); one already set to other shops keeps them.
     */
    async link(productId: string, shopId: string, p: ShopProduct, o: { packQuantity?: number } = {}): Promise<{ product: Product; listing: Listing; shopSet: boolean }> {
      const item = await product(productId);
      const owner = (await linked()).get(`${shopId}:${p.listing_id}`);
      if (owner && owner.id !== productId) throw new ConflictError(`${p.name} is already linked to ${owner.name}. Unlink it there first.`);
      const guess = packQuantityFor(await ctx.core.units.list(), p.pack_size, p.name, item);
      let listing: Listing | null = null;
      const updated = await change(productId, (f) => {
        const rules = ShopRules.parse(f.shops[shopId] ?? {});
        const old = rules.listings.find((l) => l.listingId === p.listing_id);
        listing = Listing.parse({
          listingId: p.listing_id, name: p.name, packSize: p.pack_size, link: p.link, imageUrl: p.image_urls[0] ?? null, deadSince: null,
          packQuantity: o.packQuantity ?? (old && !old.guessed ? old.packQuantity : guess.quantity),
          guessed: o.packQuantity !== undefined ? false : old && !old.guessed ? false : guess.guessed,
          addedAt: old?.addedAt ?? ctx.core.now(),
        });
        // A new code for a product that has gone replaces it: the one dead listing, or the dead one with the same pack size.
        const dead = old ? [] : rules.listings.filter((l) => l.deadSince);
        const replaced = dead.length === 1 ? dead[0] : dead.find((l) => Math.abs(l.packQuantity - listing!.packQuantity) <= listing!.packQuantity * 0.01);
        const kept = replaced ? rules.listings.filter((l) => l !== replaced) : rules.listings;
        if (!old && kept.length >= 12) throw new ValidationError(`${item.name} already has 12 listings at this shop. Remove one first.`);
        const listings = old ? kept.map((l) => (l.listingId === p.listing_id ? listing! : l)) : [...kept, listing];
        if (replaced && rules.fixedListingId === replaced.listingId) rules.fixedListingId = p.listing_id;
        return { ...f, shops: { ...f.shops, [shopId]: { ...rules, listings } } };
      });
      if (updated.preferredShopIds.length) return { product: updated, listing: listing!, shopSet: false };
      return { product: await ctx.core.products.update(productId, { preferredShopIds: [shopId] }), listing: listing!, shopSet: true };
    },

    async unlink(productId: string, shopId: string, listingId: string): Promise<Product> {
      await product(productId);
      return change(productId, (f) => {
        const rules = ShopRules.parse(f.shops[shopId] ?? {});
        if (!rules.listings.some((l) => l.listingId === listingId)) throw new NotFoundError('Listing', listingId);
        const listings = rules.listings.filter((l) => l.listingId !== listingId);
        return { ...f, shops: { ...f.shops, [shopId]: { ...rules, listings, fixedListingId: rules.fixedListingId === listingId ? null : rules.fixedListingId } } };
      });
    },

    async setPack(productId: string, shopId: string, listingId: string, packQuantity: number): Promise<Product> {
      await product(productId);
      return change(productId, (f) => {
        const rules = ShopRules.parse(f.shops[shopId] ?? {});
        if (!rules.listings.some((l) => l.listingId === listingId)) throw new NotFoundError('Listing', listingId);
        return { ...f, shops: { ...f.shops, [shopId]: { ...rules, listings: rules.listings.map((l) => (l.listingId === listingId ? { ...l, packQuantity, guessed: false } : l)) } } };
      });
    },

    async setShopRules(productId: string, shopId: string, patch: { packRule?: 'fixed' | 'cheapest'; fixedListingId?: string | null; targetPrice?: number | null }): Promise<Product> {
      await product(productId);
      return change(productId, (f) => {
        const rules = ShopRules.parse(f.shops[shopId] ?? {});
        if (patch.fixedListingId && !rules.listings.some((l) => l.listingId === patch.fixedListingId)) throw new ValidationError('Link that listing to the item first.');
        return { ...f, shops: { ...f.shops, [shopId]: ShopRules.parse({ ...rules, ...patch }) } };
      });
    },

    async setRules(productId: string, patch: { offerStockUpTo?: number | null; targetPrice?: number | null }): Promise<Product> {
      await product(productId);
      return change(productId, (f) => ({ ...f, ...patch }));
    },

    /** Marks listings the shop said have gone, so they can be relinked; clears the mark when one comes back. */
    async markDead(shopId: string, dead: Array<{ productId: string; listingId: string }>, alive: Array<{ productId: string; listingId: string }> = []): Promise<void> {
      const byItem = new Map<string, { dead: Set<string>; alive: Set<string> }>();
      for (const d of dead) (byItem.get(d.productId) ?? byItem.set(d.productId, { dead: new Set(), alive: new Set() }).get(d.productId)!).dead.add(d.listingId);
      for (const a of alive) (byItem.get(a.productId) ?? byItem.set(a.productId, { dead: new Set(), alive: new Set() }).get(a.productId)!).alive.add(a.listingId);
      const now = ctx.core.now();
      for (const [productId, ids] of byItem) {
        const rules = rulesFor(await product(productId), shopId);
        const changes = rules.listings.some((l) => (ids.dead.has(l.listingId) && !l.deadSince) || (ids.alive.has(l.listingId) && l.deadSince));
        if (!changes) continue;
        await change(productId, (f) => {
          const r = ShopRules.parse(f.shops[shopId] ?? {});
          return { ...f, shops: { ...f.shops, [shopId]: { ...r, listings: r.listings.map((l) => ({ ...l, deadSince: ids.dead.has(l.listingId) ? (l.deadSince ?? now) : ids.alive.has(l.listingId) ? null : l.deadSince })) } } };
        });
      }
    },

    /** Uses a listing's picture as the item's photo (first of its photos). */
    async useShopImage(productId: string, shopId: string, listingId: string): Promise<Product> {
      const item = await product(productId);
      const l = rulesFor(item, shopId).listings.find((x) => x.listingId === listingId);
      if (!l) throw new NotFoundError('Listing', listingId);
      if (!l.imageUrl) throw new ValidationError(`The shop has no picture of ${l.name || 'that product'}.`);
      const fileId = await ctx.core.lookup.savePhotoFromLink(l.imageUrl, item.name);
      if (!fileId) throw new ValidationError('Larder couldn\'t download the shop\'s picture. Try again later.');
      const fresh = await product(productId);
      return ctx.core.products.update(productId, { photoFileIds: [fileId, ...fresh.photoFileIds.filter((f) => f !== fileId)].slice(0, 6) });
    },
  };
}
export type Items = ReturnType<typeof createItems>;
