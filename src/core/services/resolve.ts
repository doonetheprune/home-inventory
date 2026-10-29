/**
 * Turns what a person, an automation or an AI assistant calls something into
 * the record it means: an id, a barcode, a shop code, an NFC tag, a place code
 * like "G2-4", or a name or alias like "loo roll".
 *
 * Used by Home Assistant actions and MCP tools, where people type names
 * rather than ids. It never guesses between close matches: an ambiguous name
 * is refused with the candidates, so the caller can ask which one.
 */
import { LarderError } from '../errors';
import type { Place, Product, Shop } from '../model';
import type { CoreContext } from './context';
import type { createLookupService } from './lookup';
import type { createSearchService } from './search';
import { placePath } from './world';
import { andList } from '../util';

/** A name matched more than one thing. `candidates` are the names to choose from. */
export class AmbiguousError extends LarderError {
  constructor(
    message: string,
    readonly candidates: string[],
  ) {
    super(message, 409, 'ambiguous');
  }
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** "Toilet rolls" and "toilet roll" are the same thing. */
const singular = (s: string) => words(s).split(' ').map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
const same = (a: string, b: string) => words(a) === words(b) || singular(a) === singular(b);

/** A search result counts as the answer only when it clearly beats the next one. */
const CLEAR_LEAD = 1.5;

export function createResolver(ctx: CoreContext, search: ReturnType<typeof createSearchService>, lookup: ReturnType<typeof createLookupService>) {
  function pick<T extends { name: string }>(what: string, ref: string, exact: T[], fuzzy: Array<{ item: T; score: number }>): T {
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) throw new AmbiguousError(`More than one ${what} is called "${ref}": ${andList(exact.map((x) => x.name))}. Use its id instead.`, exact.map((x) => x.name));
    const [first, second] = fuzzy;
    if (first && (!second || first.score >= second.score * CLEAR_LEAD)) return first.item;
    if (first) {
      const names = fuzzy.slice(0, 5).map((f) => f.item.name);
      throw new AmbiguousError(`"${ref}" could be ${andList(names.map((n) => `"${n}"`)).replace(/ and ([^,]+)$/, ' or $1')}. Say which one.`, names);
    }
    throw new LarderError(`Larder doesn't know a ${what} called "${ref}". Check the spelling, or add it first.`, 404, 'not_found');
  }

  return {
    /** A product by id, barcode, shop code, NFC tag or name/alias (including the wish list). */
    async product(ref: string): Promise<Product> {
      const q = ref.trim();
      if (!q) throw new LarderError('Say which item.', 400, 'invalid');
      const byId = await ctx.storage.products.get(q);
      if (byId) return byId;
      const known = await lookup.identify(q, { offline: true });
      if (known.kind === 'product') return known.product.product;
      const products = await ctx.storage.products.list();
      const exact = products.filter((p) => same(p.name, q) || p.aliases.some((a) => same(a, q)));
      const hits = exact.length ? [] : await search.hits(q, { types: ['product', 'wish'], limit: 10 });
      const byIdMap = new Map(products.map((p) => [p.id, p]));
      const fuzzy = hits.map((h) => ({ item: byIdMap.get(h.refId)!, score: h.score })).filter((f) => f.item);
      return pick('item', q, exact, fuzzy);
    },

    /** A place by id, code ("G2-4"), NFC tag, name or path ("Garage › Racking"). */
    async place(ref: string): Promise<Place> {
      const q = ref.trim();
      if (!q) throw new LarderError('Say which place.', 400, 'invalid');
      const byId = await ctx.storage.places.get(q);
      if (byId) return byId;
      const known = await lookup.identify(q, { offline: true });
      if (known.kind === 'place') return known.place;
      const places = await ctx.storage.places.list();
      const byPlaceId = new Map(places.map((p) => [p.id, p]));
      const path = (p: Place) => placePath(byPlaceId, p.id);
      const wanted = words(q.replace(/[›>/]/g, ' '));
      const exact = places.filter((p) => same(p.name, q) || (p.code && words(p.code) === words(q)) || words(path(p)) === wanted);
      const hits = exact.length ? [] : await search.hits(q, { types: ['place'], limit: 10 });
      const fuzzy = hits.map((h) => ({ item: byPlaceId.get(h.refId)!, score: h.score })).filter((f) => f.item);
      return pick('place', q, exact, fuzzy);
    },

    /** A shop by id or name ("sainsburys" finds Sainsbury's). */
    async shop(ref: string): Promise<Shop> {
      const q = ref.trim();
      if (!q) throw new LarderError('Say which shop.', 400, 'invalid');
      const shops = await ctx.storage.shops.list();
      const byId = shops.find((s) => s.id === q);
      if (byId) return byId;
      const squash = (s: string) => words(s).replace(/ /g, '');
      const exact = shops.filter((s) => squash(s.name) === squash(q));
      const starts = exact.length ? [] : shops.filter((s) => squash(s.name).startsWith(squash(q)));
      return pick('shop', q, exact, starts.map((item, i) => ({ item, score: starts.length === 1 ? 1 : 1 - i * 0.01 })));
    },
  };
}

export type Resolver = ReturnType<typeof createResolver>;
