import { describe, expect, it } from 'vitest';
import { answerer, matchScore, pathKey, type OfflineCopy } from '../../src/web/src/offline/copy';
import { savedText, sizeText } from '../../src/web/src/format';
import { ApiError } from '../../src/web/src/apiError';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const place = (id: string, path: string, code: string | null = null) => ({ id, name: path.split(' › ').pop()!, path, code });
const garage = place('pl-garage', 'Garage');
const shelf = place('pl-shelf', 'Utility › Shelf 2', 'U2');
const item = (id: string, name: string, o: Any = {}) => ({
  product: { id, name, wish: false, categoryId: 'cat-house', aliases: [], notes: '', ...o.product },
  category: { id: 'cat-house', name: 'Household' },
  inStock: 4, expected: 0, pending: 0,
  status: { low: false, expiringSoon: false, expired: false, outOfPlace: false, hasExpected: false, ...o.status },
  places: [shelf], stockByPlace: [{ ...shelf, quantity: 4 }], nowIn: [],
  ...o.rest,
});

const loo = item('p-loo', 'Toilet roll', { product: { aliases: ['bog roll', 'loo roll'] }, status: { low: true } });
const candles = item('p-candles', 'Candles', { product: { categoryId: 'cat-power' }, rest: { places: [garage], stockByPlace: [{ ...garage, quantity: 12 }] } });
const milk = item('p-milk', 'Milk', { status: { expiringSoon: true }, rest: { inStock: 0 } });
const torch = item('p-torch', 'Head torch', { product: { wish: true, notes: 'For the power cut box' }, rest: { inStock: 0, places: [], stockByPlace: [] } });

const copy: OfflineCopy = {
  format: 'larder-offline-copy', version: 1, savedAt: '2026-11-05T14:32:00.000Z', larderVersion: 'test',
  responses: {
    '/products?status=all': [candles, milk, loo],
    '/products?status=wish': [torch],
    '/products?status=to_tidy': [milk],
    '/products/p-loo': { ...loo, variants: [{ name: 'Andrex 9 pack', barcodes: ['5029053038919'], shopCodes: [] }] },
    '/places': [garage, shelf],
    '/shops': [{ id: 's-aldi', name: 'Aldi', notes: '', sells: ['cat-house'] }],
    '/categories': [{ id: 'cat-house', name: 'Household' }],
    '/search': { sections: [{ id: 'recent', title: 'Recent', results: [] }] },
    '/modules/recipes?productId=p-loo&show=all': ['saved with its query in this order'],
  },
};
const answer = answerer(copy);
const names = (x: unknown) => (x as Any[]).map((s) => s.product.name);
const search = (q: string) => (answer('GET', `/search?q=${encodeURIComponent(q)}`) as { sections: Any[] }).sections;

describe('answering from an offline copy', () => {
  it('gives the saved answer, whatever order the query is in, as a fresh object', () => {
    expect(answer('GET', '/modules/recipes?show=all&productId=p-loo')).toEqual(['saved with its query in this order']);
    expect(pathKey('/a?b=2&a=1')).toBe('/a?a=1&b=2');
    const first = answer('GET', '/places') as Any[];
    first.pop();
    expect(answer('GET', '/places')).toHaveLength(2);
  });

  it('works out the stock filters from the saved lists', () => {
    expect(names(answer('GET', '/products?status=all'))).toEqual(['Candles', 'Milk', 'Toilet roll']);
    expect(names(answer('GET', '/products?status=low'))).toEqual(['Toilet roll']);
    expect(names(answer('GET', '/products?status=expiring'))).toEqual(['Milk']);
    expect(names(answer('GET', '/products?status=in_stock'))).toEqual(['Candles', 'Toilet roll']);
    expect(names(answer('GET', '/products?status=wish'))).toEqual(['Head torch']);
    expect(names(answer('GET', '/products?status=all&categoryId=cat-power'))).toEqual(['Candles']);
    expect(names(answer('GET', '/products?status=to_tidy'))).toEqual(['Milk']);
    expect(names(answer('GET', '/products?placeId=pl-garage'))).toEqual(['Candles']);
  });

  it('searches names, nicknames, places, codes and barcodes', () => {
    const titles = (q: string, section: string) => search(q).find((s) => s.id === section)?.results.map((r: Any) => r.title) ?? [];
    expect(titles('bog rol', 'stock')).toEqual(['Toilet roll']);
    expect(search('bog rol')[0]!.results[0]).toMatchObject({ type: 'product', href: '/products/p-loo', subtitle: 'Utility › Shelf 2 · Household' });
    expect(titles('garage', 'stock')).toEqual(['Candles']);
    expect(titles('garage', 'places')).toEqual(['Garage']);
    expect(titles('u2', 'places')).toEqual(['U2 · Shelf 2']);
    expect(titles('5029053038919', 'stock')).toEqual(['Toilet roll']);
    expect(titles('torch', 'wish')).toEqual(['Head torch']);
    expect(titles('aldi', 'shops')).toEqual(['Aldi']);
    expect(search('zzz')).toEqual([]);
    // Before anything is typed: the recent items as they were saved.
    expect(search('')).toEqual([{ id: 'recent', title: 'Recent', results: [] }]);
  });

  it('ranks names above other matches', () => {
    expect(matchScore(['roll'], 'Toilet roll', [])).toBeGreaterThan(matchScore(['roll'], 'Candles', ['roll of tape']));
    expect(matchScore(['loo', 'paper'], 'Toilet roll', ['loo roll'])).toBe(0);
  });

  it('says changes and pages it has no copy of can\'t be had', () => {
    const fails = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err as ApiError;
      }
      throw new Error('it answered');
    };
    expect(fails(() => answer('POST', '/stock/use'))).toMatchObject({ code: 'read_only', message: expect.stringContaining('saved copy') });
    expect(fails(() => answer('GET', '/products/p-unknown'))).toMatchObject({ code: 'not_saved', status: 404 });
  });
});

describe('copy wording', () => {
  it('says when a copy was saved in this device\'s time', () => {
    const now = new Date(2026, 10, 5, 18, 0);
    expect(savedText(new Date(2026, 10, 5, 14, 32).toISOString(), now)).toBe('Today, 14:32');
    expect(savedText(new Date(2026, 10, 4, 8, 5).toISOString(), now)).toBe('Yesterday, 08:05');
    expect(savedText(new Date(2026, 10, 2, 19, 45).toISOString(), now)).toBe('Mon 2 Nov, 19:45');
    expect(savedText(new Date(2025, 10, 3, 19, 45).toISOString(), now)).toBe('3 Nov 2025, 19:45');
    expect(sizeText(300)).toBe('1 KB');
    expect(sizeText(640 * 1024)).toBe('640 KB');
    expect(sizeText(1.25 * 1024 * 1024)).toBe('1.3 MB');
  });
});
