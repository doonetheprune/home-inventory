/**
 * Shopping lists are worked out, not stored: everything low (or put on the
 * list by hand) that can come from the shop you're going to.
 */
import type { Category, Shop, ShoppingItem, ShoppingList, ShoppingSummary } from '../model';
import { Purchase as PurchaseSchema, type Purchase } from '../inputs';
import { NotFoundError } from '../errors';
import { roundQty } from '../util';
import type { CoreContext } from './context';
import type { createStockService } from './stock';
import { eligibleShops, loadWorld, needsBuying, summarise, type World } from './world';

function itemsFor(world: World, shop: Shop | null): ShoppingItem[] {
  const out: ShoppingItem[] = [];
  for (const product of world.products) {
    const summary = summarise(world, product);
    const reason = needsBuying(summary);
    if (!reason) continue;
    const shops = eligibleShops(product, world.shops);
    if (shop ? !shops.some((s) => s.id === shop.id) : shops.length) continue;
    const short = product.minQuantity !== null ? Math.ceil(roundQty(product.minQuantity - summary.inStock - summary.expected)) : 0;
    out.push({ summary, quantity: Math.max(1, short), reason, anyShop: product.preferredShopIds.length === 0 });
  }
  return out;
}

function group(world: World, items: ShoppingItem[]): ShoppingList['groups'] {
  const groups = new Map<string, { category: Category | null; items: ShoppingItem[] }>();
  for (const item of items) {
    const key = item.summary.category?.id ?? '';
    const g = groups.get(key) ?? { category: item.summary.category, items: [] };
    g.items.push(item);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => (a.category?.sortOrder ?? 1e9) - (b.category?.sortOrder ?? 1e9) || (a.category?.name ?? '').localeCompare(b.category?.name ?? ''))
    .map((g) => ({ ...g, items: g.items.sort((a, b) => a.summary.product.name.localeCompare(b.summary.product.name, 'en-GB')) }));
}

export function createShoppingService(ctx: CoreContext, stock: ReturnType<typeof createStockService>) {
  return {
    async summary(): Promise<ShoppingSummary> {
      const world = await loadWorld(ctx);
      const shops = [...world.shops]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map((shop) => ({ shop, count: itemsFor(world, shop).length }));
      const best = shops.reduce<{ shop: Shop; count: number } | null>((m, s) => (s.count > (m?.count ?? 0) ? s : m), null);
      return { shops, suggestedShopId: best?.shop.id ?? null, unassigned: itemsFor(world, null).length };
    },

    async forShop(shopId: string): Promise<ShoppingList> {
      const world = await loadWorld(ctx);
      const shop = world.shops.find((s) => s.id === shopId);
      if (!shop) throw new NotFoundError('Shop', shopId);
      const items = itemsFor(world, shop);
      return { shop, groups: group(world, items), count: items.length };
    },

    /** Things to buy that no shop on your list sells. */
    async unassigned(): Promise<ShoppingList['groups']> {
      const world = await loadWorld(ctx);
      return group(world, itemsFor(world, null));
    },

    /** Ticked off at the shop: add it all to stock. */
    async purchase(raw: Purchase) {
      const input = PurchaseSchema.parse(raw);
      if (input.shopId && !(await ctx.storage.shops.get(input.shopId))) throw new NotFoundError('Shop', input.shopId);
      const results = await stock.addMany(input.items.map((item) => ({ productId: item.productId, quantity: item.quantity, placeId: item.placeId ?? undefined, note: input.shopId ? 'Bought' : '' })));
      ctx.publish('shopping.purchased', { shopId: input.shopId ?? null, items: input.items });
      return results;
    },
  };
}
