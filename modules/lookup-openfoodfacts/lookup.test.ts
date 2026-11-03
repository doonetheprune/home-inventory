import { describe, expect, it } from 'vitest';
import { openFactsProvider } from '../_shared/open-facts';

const fakeFetch = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const signal = new AbortController().signal;

describe('Open Facts lookup', () => {
  it('maps a found product', async () => {
    const p = openFactsProvider({
      id: 'off', name: 'Open Food Facts', baseUrl: 'https://example.test',
      fetch: fakeFetch(200, { status: 1, product: { product_name: 'Baked Beanz', brands: 'Heinz, Kraft Heinz', quantity: '415 g', image_front_small_url: 'https://img/1.jpg', categories: 'Canned foods, Beans, en:legumes' } }),
    });
    expect(await p.lookup('5000157024671', { signal })).toEqual({ name: 'Baked Beanz', brand: 'Heinz', quantityText: '415 g', imageUrl: 'https://img/1.jpg', categories: ['Canned foods', 'Beans'] });
  });

  it('returns null for unknown barcodes', async () => {
    const notFound = openFactsProvider({ id: 'off', name: 'OFF', baseUrl: 'https://example.test', fetch: fakeFetch(404, { status: 0 }) });
    expect(await notFound.lookup('1', { signal })).toBeNull();
    const noName = openFactsProvider({ id: 'off', name: 'OFF', baseUrl: 'https://example.test', fetch: fakeFetch(200, { status: 1, product: { brands: 'X' } }) });
    expect(await noName.lookup('1', { signal })).toBeNull();
  });

  it('throws on server errors so the next provider is tried', async () => {
    const down = openFactsProvider({ id: 'off', name: 'OFF', baseUrl: 'https://example.test', fetch: fakeFetch(503, {}) });
    await expect(down.lookup('1', { signal })).rejects.toThrow('503');
  });

  it('searches a brand by name, keeping search syntax out of the query', async () => {
    const asked: string[] = [];
    const p = openFactsProvider({
      id: 'off', name: 'OFF', baseUrl: 'https://example.test', searchUrl: 'https://search.example.test/',
      fetch: (async (url: string) => {
        asked.push(url);
        return new Response(JSON.stringify({ hits: [
          { product_name: 'Porridge Original', brands: ["Flahavan's"], quantity: '1 kg', image_front_small_url: 'https://img/2.jpg' },
          { brands: ['Nameless'] },
        ] }));
      }) as unknown as typeof fetch,
    });
    expect(await p.search!({ name: 'Porridge (oats)*', brand: 'Flahavan\'s"' }, { signal })).toEqual([
      { name: 'Porridge Original', brands: ["Flahavan's"], quantityText: '1 kg', imageUrl: 'https://img/2.jpg' },
    ]);
    const url = new URL(asked[0]!);
    expect(url.origin + url.pathname).toBe('https://search.example.test/search');
    expect(url.searchParams.get('q')).toBe('brands:"Flahavan\'s" AND Porridge AND oats');
  });

  it('only searches where a search server is set', () => {
    expect(openFactsProvider({ id: 'obf', name: 'Open Beauty Facts', baseUrl: 'https://example.test' }).search).toBeUndefined();
  });
});
