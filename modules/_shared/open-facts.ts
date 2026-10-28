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

const FIELDS = 'product_name,product_name_en,generic_name,brands,quantity,image_front_small_url,image_url,categories';

export function openFactsProvider(options: OpenFactsOptions): LookupProvider {
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    id: options.id,
    name: options.name,
    async lookup(barcode, { signal }) {
      const doFetch = options.fetch ?? fetch;
      const res = await doFetch(`${base}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}`, {
        signal,
        headers: { 'User-Agent': options.userAgent ?? 'Larder home inventory (https://github.com/doonetheprune/home-inventory)', Accept: 'application/json' },
      });
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
  };
}
