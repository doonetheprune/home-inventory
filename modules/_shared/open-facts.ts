/**
 * Shared client for the Open Food Facts family (Open Food Facts, Open Beauty
 * Facts, Open Products Facts). They all use the same API on different hosts.
 * Helpers in modules/_shared may be imported by any module; they are not
 * modules themselves.
 */
import type { LookupProvider } from '@larder/core';

export interface OpenFactsOptions {
  id: string;
  name: string;
  /** e.g. https://world.openfoodfacts.org */
  baseUrl: string;
  /** Its name search (Open Food Facts only, e.g. https://search.openfoodfacts.org). Without one, it only answers barcodes. */
  searchUrl?: string;
  userAgent?: string;
  fetch?: typeof fetch;
}

interface OpenFactsProduct {
  product_name?: string;
  product_name_en?: string;
  generic_name?: string;
  brands?: string;
  quantity?: string;
  image_front_small_url?: string;
  image_url?: string;
  categories?: string;
}

/** A search hit: the same fields, but brands come back as a list. */
interface OpenFactsHit extends Omit<OpenFactsProduct, 'brands' | 'categories'> {
  brands?: string[] | string;
}

const FIELDS = 'product_name,product_name_en,generic_name,brands,quantity,image_front_small_url,image_url,categories';
const SEARCH_FIELDS = 'product_name,product_name_en,brands,quantity,image_front_small_url,image_url';

/** Letters, digits and apostrophes only, so nothing in a name is read as search syntax. */
const searchWords = (text: string) => text.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'’]/gu, '')).filter(Boolean);

export function openFactsProvider(options: OpenFactsOptions): LookupProvider {
  const base = options.baseUrl.replace(/\/+$/, '');
  const searchBase = options.searchUrl?.replace(/\/+$/, '');
  const get = (url: string, signal: AbortSignal) => (options.fetch ?? fetch)(url, {
    signal,
    headers: { 'User-Agent': options.userAgent ?? 'Larder home inventory (https://github.com/doonetheprune/home-inventory)', Accept: 'application/json' },
  });
  return {
    id: options.id,
    name: options.name,
    async lookup(barcode, { signal }) {
      const res = await get(`${base}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}`, signal);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${options.name} answered ${res.status}`);
      const body = (await res.json()) as { status?: number; product?: OpenFactsProduct };
      const p = body.product;
      if (body.status !== 1 || !p) return null;
      const name = (p.product_name_en || p.product_name || p.generic_name || '').trim();
      if (!name) return null;
      return {
        name,
        brand: p.brands?.split(',')[0]?.trim() || null,
        quantityText: p.quantity?.trim() || null,
        imageUrl: p.image_front_small_url || p.image_url || null,
        categories: (p.categories ?? '').split(',').map((c) => c.trim()).filter((c) => c && !c.includes(':')).slice(0, 5),
      };
    },
    ...(searchBase && {
      async search({ name, brand }, { signal }) {
        const brandPhrase = brand.replace(/["\\]/g, ' ').trim();
        const words = searchWords(name);
        if (!brandPhrase || !words.length) return [];
        const q = [`brands:"${brandPhrase}"`, ...words].join(' AND ');
        const res = await get(`${searchBase}/search?q=${encodeURIComponent(q)}&page_size=10&fields=${SEARCH_FIELDS}`, signal);
        if (!res.ok) throw new Error(`${options.name} search answered ${res.status}`);
        const body = (await res.json()) as { hits?: OpenFactsHit[] };
        return (body.hits ?? []).flatMap((h) => {
          const found = (h.product_name_en || h.product_name || '').trim();
          const brands = (Array.isArray(h.brands) ? h.brands : (h.brands ?? '').split(',')).map((b) => b.trim()).filter(Boolean);
          return found ? [{ name: found, brands, quantityText: h.quantity?.trim() || null, imageUrl: h.image_front_small_url || h.image_url || null }] : [];
        });
      },
    }),
  };
}
