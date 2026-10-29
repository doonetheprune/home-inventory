/**
 * Search everywhere. Results come back in sections (stock, shopping lists,
 * places, wish list, shops, plus any sections modules add).
 *
 * The text index is rebuilt lazily: change events mark it stale and the next
 * query rebuilds it. A household has a few thousand items at most, so a full
 * rebuild takes milliseconds.
 */
import type { SearchResult, SearchSectionResult } from '../model';
import type { SearchDoc, SearchHit } from '../ports';
import type { CoreContext } from './context';
import { andList } from '../util';
import { eligibleShops, loadWorld, needsBuying, placePath, summarise, type World } from './world';

export interface SearchSection {
  id: string;
  title: string;
  /** Core sections use 10 (stock), 20 (shopping), 30 (places), 50 (wish list), 60 (shops). */
  order: number;
  /** Extra documents for the shared index (type must be unique to the section). */
  documents?(): Promise<SearchDoc[]>;
  /** Turn index hits (and the raw query) into results. */
  results(query: string, hits: SearchHit[]): Promise<SearchResult[]>;
}

const PER_SECTION = 5;

function productDocs(world: World): SearchDoc[] {
  return world.products.map((p) => {
    const entries = world.entriesByProduct.get(p.id) ?? [];
    const placeWords = new Set<string>();
    for (const e of entries) {
      for (const id of [e.placeId, e.currentPlaceId]) {
        const pl = id ? world.placeById.get(id) : undefined;
        if (pl) {
          placeWords.add(placePath(world.placeById, pl.id));
          if (pl.code) placeWords.add(pl.code);
        }
      }
    }
    const cat = p.categoryId ? world.categoryById.get(p.categoryId)?.name : undefined;
    return {
      id: `product:${p.id}`, type: p.wish ? 'wish' : 'product', refId: p.id, title: p.name,
      keywords: [...p.aliases, cat ?? '', p.notes, ...placeWords].filter(Boolean),
    };
  });
}

export function createSearchService(ctx: CoreContext) {
  const sections: SearchSection[] = [];
  let stale = true;
  let building: Promise<void> | null = null;

  async function rebuild() {
    const world = await loadWorld(ctx);
    const variants = await Promise.all(world.products.map((p) => ctx.storage.variants.listByProduct(p.id)));
    const docs: SearchDoc[] = productDocs(world).map((d, i) => ({
      ...d,
      keywords: [...d.keywords, ...(variants[i] ?? []).flatMap((v) => [v.name, ...v.barcodes, ...v.shopCodes.map((s) => s.code)])],
    }));
    for (const p of world.places) {
      docs.push({ id: `place:${p.id}`, type: 'place', refId: p.id, title: p.name, keywords: [placePath(world.placeById, p.id), p.code ?? '', p.notes].filter(Boolean) });
    }
    for (const s of world.shops) docs.push({ id: `shop:${s.id}`, type: 'shop', refId: s.id, title: s.name, keywords: [s.notes].filter(Boolean) });
    for (const section of sections) if (section.documents) docs.push(...(await section.documents()));
    await ctx.search.replaceAll(docs);
    stale = false;
  }

  async function ready() {
    if (!stale) return;
    building ??= rebuild().finally(() => (building = null));
    await building;
  }

  ctx.events.subscribe((e) => {
    if (/^(product|stock|place|shop|category)\./.test(e.type) || e.type.startsWith('search.')) stale = true;
  });

  async function coreSections(query: string): Promise<SearchSectionResult[]> {
    const hits = await ctx.search.query(query, { limit: 60 });
    const world = await loadWorld(ctx);
    const summaries = new Map(world.products.map((p) => [p.id, summarise(world, p)]));
    const of = (type: string) => hits.filter((h) => h.type === type);

    const productHits = of('product').map((h) => summaries.get(h.refId)).filter((s) => !!s);
    const stock: SearchResult[] = productHits.slice(0, PER_SECTION).map((s) => ({
      type: 'product', id: s.product.id, title: s.product.name,
      subtitle: [s.places[0]?.path, s.category?.name].filter(Boolean).join(' · '), href: `/products/${s.product.id}`, product: s,
    }));
    const shopping: SearchResult[] = productHits
      .filter((s) => needsBuying(s))
      .slice(0, PER_SECTION)
      .map((s) => {
        const shops = eligibleShops(s.product, world.shops);
        return {
          type: 'shopping', id: s.product.id, title: s.product.name,
          subtitle: shops.length ? `On your ${andList(shops.map((x) => x.name))} list${shops.length > 1 ? 's' : ''}` : 'On the list, no shop set',
          href: shops[0] ? `/shop/${shops[0].id}` : '/shop', product: s, shopIds: shops.map((x) => x.id),
        };
      });
    const places: SearchResult[] = of('place')
      .slice(0, PER_SECTION)
      .map((h) => world.placeById.get(h.refId))
      .filter((p) => !!p)
      .map((p) => ({ type: 'place', id: p.id, title: p.code ? `${p.code} · ${p.name}` : p.name, subtitle: placePath(world.placeById, p.id), href: `/places/${p.id}` }));
    const wish: SearchResult[] = of('wish')
      .slice(0, PER_SECTION)
      .map((h) => summaries.get(h.refId))
      .filter((s) => !!s)
      .map((s) => ({ type: 'wish', id: s.product.id, title: s.product.name, subtitle: s.product.notes.slice(0, 80) || 'On the wish list', href: `/products/${s.product.id}`, product: s }));
    const shops: SearchResult[] = of('shop')
      .slice(0, PER_SECTION)
      .map((h) => world.shops.find((s) => s.id === h.refId))
      .filter((s) => !!s)
      .map((s) => ({ type: 'shop', id: s.id, title: s.name, subtitle: `Sells ${s.sells.map((c) => world.categoryById.get(c)?.name).filter(Boolean).join(', ') || 'nothing yet'}`, href: `/shop/${s.id}` }));

    const out: Array<SearchSectionResult & { order: number }> = [
      { id: 'stock', title: 'Stock', results: stock, order: 10 },
      { id: 'shopping', title: 'Shopping lists', results: shopping, order: 20 },
      { id: 'places', title: 'Places', results: places, order: 30 },
      { id: 'wish', title: 'Wish list', results: wish, order: 50 },
      { id: 'shops', title: 'Shops', results: shops, order: 60 },
    ];
    for (const section of sections) {
      const own = hits.filter((h) => h.type.startsWith(`${section.id}`));
      out.push({ id: section.id, title: section.title, results: (await section.results(query, own)).slice(0, PER_SECTION), order: section.order });
    }
    return out.sort((a, b) => a.order - b.order).map(({ order: _order, ...s }) => s);
  }

  return {
    addSection(section: SearchSection) {
      sections.push(section);
      stale = true;
    },
    markStale() {
      stale = true;
    },

    /** Raw index hits, best first, for code that needs to pick one thing (see resolve.ts). */
    async hits(text: string, options: { types?: string[]; limit?: number } = {}): Promise<SearchHit[]> {
      if (!text.trim()) return [];
      await ready();
      return ctx.search.query(text.trim(), options);
    },

    async query(text: string): Promise<SearchSectionResult[]> {
      const q = text.trim();
      if (!q) return this.recent();
      await ready();
      const sections = await coreSections(q);
      // An exact barcode or shop code match goes to the top of Stock.
      if (/^\S{4,}$/.test(q)) {
        const v = (await ctx.storage.variants.findByBarcode(q)) ?? (await ctx.storage.variants.findByShopCode(q));
        const stock = sections.find((s) => s.id === 'stock');
        if (v && stock && !stock.results.some((r) => r.id === v.productId)) {
          const world = await loadWorld(ctx);
          const p = world.productById.get(v.productId);
          if (p) {
            const s = summarise(world, p);
            stock.results.unshift({ type: 'product', id: p.id, title: p.name, subtitle: v.name, href: `/products/${p.id}`, product: s });
          }
        }
      }
      return sections.filter((s) => s.results.length);
    },

    /** Recently changed items, shown before anything is typed. */
    async recent(): Promise<SearchSectionResult[]> {
      const moves = await ctx.storage.movements.listRecent(50);
      const world = await loadWorld(ctx);
      const ids = [...new Set(moves.map((m) => m.productId))].filter((id) => world.productById.has(id)).slice(0, 5);
      const results: SearchResult[] = ids.map((id) => {
        const s = summarise(world, world.productById.get(id)!);
        return { type: 'product', id, title: s.product.name, subtitle: [s.places[0]?.path, s.category?.name].filter(Boolean).join(' · '), href: `/products/${id}`, product: s };
      });
      return results.length ? [{ id: 'recent', title: 'Recent', results }] : [];
    },
  };
}
