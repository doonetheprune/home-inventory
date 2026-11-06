/**
 * Answers the web app's requests from an offline copy: the API's own answers
 * to the app's GET requests, saved on the device (GET /api/v1/offline/copy).
 * Stock filters (low, expiring…) and searches are worked out here from the
 * saved lists, since a copy can't hold every possible one. Changes aren't
 * possible: a copy is a snapshot. No DOM here, so it's tested in Node.
 */
import type { Category, PlaceRef, ProductDetail, ProductSummary, SearchResult, SearchSectionResult, Shop } from '@larder/core';
import { ApiError } from '../apiError';

export interface OfflineCopy {
  format: 'larder-offline-copy';
  version: number;
  savedAt: string;
  larderVersion: string;
  /** The API's answer to each GET, by path under /api/v1. */
  responses: Record<string, unknown>;
}

export function isOfflineCopy(x: unknown): x is OfflineCopy {
  const c = x as Partial<OfflineCopy> | null;
  return !!c && c.format === 'larder-offline-copy' && typeof c.savedAt === 'string' && !!c.responses && typeof c.responses === 'object';
}

/** A path with its query in a fixed order, so "?b=1&a=2" and "?a=2&b=1" are the same page. */
export function pathKey(path: string): string {
  const at = path.indexOf('?');
  if (at < 0) return path;
  const params = new URLSearchParams(path.slice(at + 1));
  params.sort();
  const q = params.toString();
  return q ? `${path.slice(0, at)}?${q}` : path.slice(0, at);
}

const PER_SECTION = 5;
const norm = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * How well every word matches: 0 if any word is missing. A word at the start
 * of a word in the name counts most, then anywhere in the name, then in the
 * other text (aliases, category, notes, places, barcodes).
 */
export function matchScore(words: string[], title: string, extra: string[]): number {
  const name = norm(title);
  const nameWords = name.split(/[^\p{L}\p{N}]+/u);
  const rest = norm(extra.join(' '));
  const restWords = rest.split(/[^\p{L}\p{N}]+/u);
  let score = 0;
  for (const w of words) {
    if (nameWords.some((n) => n.startsWith(w))) score += 4;
    else if (name.includes(w)) score += 3;
    else if (restWords.some((n) => n.startsWith(w))) score += 2;
    else if (rest.includes(w)) score += 1;
    else return 0;
  }
  return score;
}

export function answerer(copy: OfflineCopy) {
  const saved = new Map(Object.entries(copy.responses).map(([k, v]) => [pathKey(k), v]));
  const list = <T,>(path: string) => (Array.isArray(saved.get(path)) ? (saved.get(path) as T[]) : []);
  const readOnly = () => new ApiError("This is a saved copy, so nothing can be changed. Go back to the live Larder (the bar at the top) to make changes.", 0, 'read_only');
  const notSaved = () => new ApiError("That isn't in this saved copy. Go back to the live Larder (the bar at the top) to see it.", 404, 'not_saved');

  /** The stock filters, as the server's products.list does them. */
  function products(params: URLSearchParams): ProductSummary[] {
    const status = params.get('status') || 'all';
    const categoryId = params.get('categoryId');
    const placeId = params.get('placeId');
    const all = [...list<ProductSummary>('/products?status=all'), ...list<ProductSummary>('/products?status=wish')];
    const base = status === 'to_tidy' ? list<ProductSummary>('/products?status=to_tidy') : all;
    return base
      .filter((s) => {
        if (categoryId && s.product.categoryId !== categoryId) return false;
        if (placeId && ![...s.stockByPlace.filter((p) => p.quantity > 0), ...s.places, ...s.nowIn].some((p) => p.id === placeId)) return false;
        switch (status) {
          case 'low': return s.status.low;
          case 'expiring': return s.status.expiringSoon;
          case 'out_of_place': return s.status.outOfPlace;
          case 'expected': return s.status.hasExpected;
          case 'wish': return s.product.wish;
          case 'in_stock': return !s.product.wish && s.inStock > 0;
          case 'to_tidy': return true;
          default: return !s.product.wish;
        }
      })
      .sort((a, b) => a.product.name.localeCompare(b.product.name, 'en-GB'));
  }

  function productText(s: ProductSummary): string[] {
    const d = saved.get(`/products/${s.product.id}`) as ProductDetail | undefined;
    const places = [...s.stockByPlace, ...s.places, ...s.nowIn].flatMap((p) => [p.path, p.code ?? '']);
    const variants = (d?.variants ?? []).flatMap((v) => [v.name, ...v.barcodes, ...v.shopCodes.map((c) => c.code)]);
    return [...s.product.aliases, s.category?.name ?? '', s.product.notes, ...places, ...variants];
  }

  function best<T>(items: T[], words: string[], title: (x: T) => string, extra: (x: T) => string[]): T[] {
    return items
      .map((x) => ({ x, score: matchScore(words, title(x), extra(x)) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || title(a.x).localeCompare(title(b.x), 'en-GB'))
      .slice(0, PER_SECTION)
      .map((m) => m.x);
  }

  /** Search everywhere, in the same sections as the server (without modules' own). */
  function search(q: string): { sections: SearchSectionResult[] } {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return (saved.get('/search') as { sections: SearchSectionResult[] } | undefined) ?? { sections: [] };
    const categories = new Map(list<Category>('/categories').map((c) => [c.id, c.name]));
    const name = (s: ProductSummary) => s.product.name;
    const stock: SearchResult[] = best(list<ProductSummary>('/products?status=all'), words, name, productText).map((s) => ({
      type: 'product', id: s.product.id, title: s.product.name, subtitle: [s.places[0]?.path, s.category?.name].filter(Boolean).join(' · '), href: `/products/${s.product.id}`, product: s,
    }));
    const places: SearchResult[] = best(list<PlaceRef>('/places'), words, (p) => p.name, (p) => [p.path, p.code ?? '']).map((p) => ({
      type: 'place', id: p.id, title: p.code ? `${p.code} · ${p.name}` : p.name, subtitle: p.path, href: `/places/${p.id}`,
    }));
    const wish: SearchResult[] = best(list<ProductSummary>('/products?status=wish'), words, name, productText).map((s) => ({
      type: 'wish', id: s.product.id, title: s.product.name, subtitle: s.product.notes.slice(0, 80) || 'On the wish list', href: `/products/${s.product.id}`, product: s,
    }));
    const shops: SearchResult[] = best(list<Shop>('/shops'), words, (s) => s.name, (s) => [s.notes]).map((s) => ({
      type: 'shop', id: s.id, title: s.name, subtitle: `Sells ${s.sells.map((c) => categories.get(c)).filter(Boolean).join(', ') || 'nothing yet'}`, href: `/shop/${s.id}`,
    }));
    const sections: SearchSectionResult[] = [
      { id: 'stock', title: 'Stock', results: stock },
      { id: 'places', title: 'Places', results: places },
      { id: 'wish', title: 'Wish list', results: wish },
      { id: 'shops', title: 'Shops', results: shops },
    ];
    return { sections: sections.filter((s) => s.results.length) };
  }

  /** The answer to one request, or an ApiError saying why there isn't one. */
  return function answer(method: string, path: string): unknown {
    if (method !== 'GET' && method !== 'HEAD') throw readOnly();
    const key = pathKey(path);
    const hit = saved.get(key);
    if (hit !== undefined) return structuredClone(hit);
    const at = key.indexOf('?');
    const pathname = at < 0 ? key : key.slice(0, at);
    const params = new URLSearchParams(at < 0 ? '' : key.slice(at + 1));
    if (pathname === '/products') return products(params);
    if (pathname === '/search') return search(params.get('q') ?? '');
    throw notSaved();
  };
}
