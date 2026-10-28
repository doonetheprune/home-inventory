/**
 * Loads everything a read needs in one go and computes summaries in memory.
 * A household has thousands of records at most, so this is fast and keeps
 * storage adapters simple (no joins).
 */
import type { Category, Place, PlaceRef, Product, ProductSummary, Shop, StockEntry } from '../model';
import type { CoreContext } from './context';
import { daysBetween, roundQty } from '../util';

export interface World {
  products: Product[];
  productById: Map<string, Product>;
  entries: StockEntry[];
  entriesByProduct: Map<string, StockEntry[]>;
  categories: Category[];
  categoryById: Map<string, Category>;
  places: Place[];
  placeById: Map<string, Place>;
  shops: Shop[];
  today: string;
  warnDays: number;
}

export async function loadWorld(ctx: CoreContext): Promise<World> {
  const [products, entries, categories, places, shops, settings] = await Promise.all([
    ctx.storage.products.list(),
    ctx.storage.stock.list(),
    ctx.storage.categories.list(),
    ctx.storage.places.list(),
    ctx.storage.shops.list(),
    ctx.household(),
  ]);
  const entriesByProduct = new Map<string, StockEntry[]>();
  for (const e of entries) {
    const list = entriesByProduct.get(e.productId);
    if (list) list.push(e);
    else entriesByProduct.set(e.productId, [e]);
  }
  return {
    products,
    productById: new Map(products.map((p) => [p.id, p])),
    entries,
    entriesByProduct,
    categories,
    categoryById: new Map(categories.map((c) => [c.id, c])),
    places,
    placeById: new Map(places.map((p) => [p.id, p])),
    shops,
    today: ctx.today(),
    warnDays: settings.expiryWarningDays,
  };
}

/** "Garage › Garage racking › Shelf 2, box 4" */
export function placePath(placeById: Map<string, Place>, id: string): string {
  const names: string[] = [];
  let cur = placeById.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parentId ? placeById.get(cur.parentId) : undefined;
  }
  return names.join(' › ');
}

export function placeRef(world: Pick<World, 'placeById'>, id: string | null): PlaceRef | null {
  if (!id) return null;
  const p = world.placeById.get(id);
  if (!p) return null;
  return { id: p.id, name: p.name, path: placePath(world.placeById, p.id), code: p.code };
}

export function summarise(world: World, product: Product): ProductSummary {
  const entries = world.entriesByProduct.get(product.id) ?? [];
  const inStockEntries = entries.filter((e) => e.status === 'in_stock' && e.quantity > 0);
  const inStock = roundQty(inStockEntries.reduce((n, e) => n + e.quantity, 0));
  const expected = roundQty(entries.filter((e) => e.status === 'expected').reduce((n, e) => n + e.quantity, 0));
  const charged = product.rechargeable ? roundQty(inStockEntries.filter((e) => e.charge !== 'flat').reduce((n, e) => n + e.quantity, 0)) : null;
  const flat = product.rechargeable ? roundQty(inStockEntries.filter((e) => e.charge === 'flat').reduce((n, e) => n + e.quantity, 0)) : null;

  const expiries = inStockEntries.map((e) => e.expiresOn).filter((d): d is string => !!d).sort();
  const nextExpiry = expiries[0] ?? null;
  const daysToExpiry = nextExpiry ? daysBetween(world.today, nextExpiry) : null;
  const category = product.categoryId ? (world.categoryById.get(product.categoryId) ?? null) : null;
  const warn = category?.warnDays ?? world.warnDays;

  const min = product.minQuantity;
  const low = !product.wish && min !== null && min > 0 && roundQty(inStock + expected) < min;

  const byPlace = new Map<string, number>();
  const nowIn = new Set<string>();
  let outOfPlace = false;
  for (const e of inStockEntries) {
    if (e.placeId) byPlace.set(e.placeId, (byPlace.get(e.placeId) ?? 0) + e.quantity);
    if (e.currentPlaceId && e.currentPlaceId !== e.placeId) {
      outOfPlace = true;
      nowIn.add(e.currentPlaceId);
    }
  }
  const places = [...byPlace.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => placeRef(world, id))
    .filter((p): p is PlaceRef => !!p);

  return {
    product,
    category,
    inStock,
    expected,
    charged,
    flat,
    nextExpiry,
    daysToExpiry,
    status: {
      low,
      expiringSoon: daysToExpiry !== null && daysToExpiry <= warn,
      expired: daysToExpiry !== null && daysToExpiry < 0,
      outOfPlace,
      hasExpected: expected > 0,
    },
    places,
    nowIn: [...nowIn].map((id) => placeRef(world, id)).filter((p): p is PlaceRef => !!p),
  };
}

/** Shops a product can come from: its preferred shops, or any shop that sells its category. */
export function eligibleShops(product: Product, shops: Shop[]): Shop[] {
  if (product.preferredShopIds.length) return shops.filter((s) => product.preferredShopIds.includes(s.id));
  if (!product.categoryId) return [];
  return shops.filter((s) => s.sells.includes(product.categoryId!));
}

export function needsBuying(s: ProductSummary): 'low' | 'out' | 'manual' | null {
  if (s.product.wish) return null;
  if (s.status.low) return s.inStock + s.expected <= 0 ? 'out' : 'low';
  if (s.product.onShoppingList) return 'manual';
  return null;
}
