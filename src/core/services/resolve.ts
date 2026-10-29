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

// Apostrophes join words ("Sainsbury's" is one word), everything else separates them.
const words = (s: string) => s.toLowerCase().replace(/['’]/g, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** "Toilet rolls" and "toilet roll" are the same thing. */
const singular = (s: string) => words(s).split(' ').filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
const same = (a: string, b: string) => words(a) === words(b) || singular(a).join(' ') === singular(b).join(' ');

/**
 * Every word asked for is a whole word of the name (plural or not): "drill"
 * covers "Cordless drill", but "aa batteries" doesn't cover "AAA batteries"
 * and "salt" doesn't cover "Malt vinegar". Only names and aliases count, never
 * notes or the places things are kept.
 */
function covers(query: string, ...names: string[]): boolean {
  const want = singular(query);
  return want.length > 0 && names.some((name) => {
    const have = new Set(singular(name));
    return want.every((w) => have.has(w));
  });
}

const a = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);
const or = (names: string[]) => andList(names.map((n) => `"${n}"`)).replace(/ and ([^,]+)$/, ' or $1');

export function createResolver(ctx: CoreContext, search: ReturnType<typeof createSearchService>, lookup: ReturnType<typeof createLookupService>) {
  /**
   * Exact names win; then names that contain every word asked for. Anything
   * looser (typos, prefixes, notes) is never acted on: it's offered back as
   * "did you mean", so the person or assistant can say which.
   */
  function pick<T extends { name: string }>(what: string, ref: string, exact: T[], strong: T[], near: string[]): T {
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) throw new AmbiguousError(`More than one ${what} is called "${ref}": ${andList(exact.map((x) => x.name))}. Use its id instead.`, exact.map((x) => x.name));
    if (strong.length === 1) return strong[0]!;
    if (strong.length > 1) {
      const names = strong.slice(0, 6).map((x) => x.name);
      throw new AmbiguousError(`"${ref}" could be ${or(names)}. Say which one.`, names);
    }
    if (near.length) throw new AmbiguousError(`Larder doesn't have ${a(what)} called "${ref}". Did you mean ${or(near.slice(0, 5))}?`, near.slice(0, 5));
    throw new LarderError(`Larder doesn't know ${a(what)} called "${ref}". Check the spelling, or add it first.`, 404, 'not_found');
  }

  async function nearNames(q: string, types: string[], byId: Map<string, { name: string }>): Promise<string[]> {
    const hits = await search.hits(q, { types, limit: 10 });
    return [...new Set(hits.map((h) => byId.get(h.refId)?.name).filter((n): n is string => !!n))];
  }

  return {
    /** A product by id, name or alias, barcode, shop code or NFC tag (including the wish list). */
    async product(ref: string): Promise<Product> {
      const q = ref.trim();
      if (!q) throw new LarderError('Say which item.', 400, 'invalid');
      const byId = await ctx.storage.products.get(q);
      if (byId) return byId;
      const products = await ctx.storage.products.list();
      const exact = products.filter((p) => same(p.name, q) || p.aliases.some((a) => same(a, q)));
      if (exact.length) return pick('item', q, exact, [], []);
      const known = await lookup.identify(q, { offline: true });
      if (known.kind === 'product') return known.product.product;
      const strong = products.filter((p) => covers(q, p.name, ...p.aliases));
      const near = strong.length ? [] : await nearNames(q, ['product', 'wish'], new Map(products.map((p) => [p.id, p])));
      return pick('item', q, exact, strong, near);
    },

    /** A place by id, code ("G2-4"), NFC tag, name or path ("Garage › Racking"). */
    async place(ref: string): Promise<Place> {
      const q = ref.trim();
      if (!q) throw new LarderError('Say which place.', 400, 'invalid');
      const byId = await ctx.storage.places.get(q);
      if (byId) return byId;
      const places = await ctx.storage.places.list();
      const byPlaceId = new Map(places.map((p) => [p.id, p]));
      const path = (p: Place) => placePath(byPlaceId, p.id);
      const wanted = words(q.replace(/[›>/]/g, ' '));
      const exact = places.filter((p) => same(p.name, q) || (p.code && words(p.code) === words(q)) || words(path(p)) === wanted);
      if (exact.length) return pick('place', q, exact, [], []);
      const known = await lookup.identify(q, { offline: true });
      if (known.kind === 'place') return known.place;
      const strong = places.filter((p) => covers(q.replace(/[›>/]/g, ' '), p.name, path(p)));
      const near = strong.length ? [] : await nearNames(q, ['place'], byPlaceId);
      return pick('place', q, exact, strong, near);
    },

    /** A shop by id or name ("sainsburys" finds Sainsbury's, "screw" finds Screwfix). */
    async shop(ref: string): Promise<Shop> {
      const q = ref.trim();
      const squash = (s: string) => words(s).replace(/ /g, '');
      if (!squash(q)) throw new LarderError('Say which shop.', 400, 'invalid');
      const shops = await ctx.storage.shops.list();
      const byId = shops.find((s) => s.id === q);
      if (byId) return byId;
      const exact = shops.filter((s) => squash(s.name) === squash(q));
      // The start of a name counts only with enough letters to mean something.
      const strong = exact.length ? [] : shops.filter((s) => covers(q, s.name) || (squash(q).length >= 3 && squash(s.name).startsWith(squash(q))));
      if (!exact.length && !strong.length) {
        throw new LarderError(`Larder doesn't know a shop called "${q}".${shops.length ? ` The shops are ${andList(shops.map((s) => s.name))}.` : ''}`, 404, 'not_found');
      }
      return pick('shop', q, exact, strong, []);
    },
  };
}

export type Resolver = ReturnType<typeof createResolver>;
