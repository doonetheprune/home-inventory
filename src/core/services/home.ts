/** The home screen: what needs attention today. */
import type { Dashboard } from '../model';
import type { CoreContext } from './context';
import type { createShoppingService } from './shopping';
import type { createStockService } from './stock';
import { loadWorld, summarise } from './world';

const LIMIT = 6;

export function createHomeService(ctx: CoreContext, stock: ReturnType<typeof createStockService>, shopping: ReturnType<typeof createShoppingService>) {
  return {
    async dashboard(): Promise<Dashboard> {
      const world = await loadWorld(ctx);
      const all = world.products.map((p) => summarise(world, p));
      const owned = all.filter((s) => !s.product.wish);
      const expiring = owned.filter((s) => s.status.expiringSoon).sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0));
      const low = owned.filter((s) => s.status.low).sort((a, b) => a.inStock + a.expected - (b.inStock + b.expected) || a.product.name.localeCompare(b.product.name));
      const outOfPlace = owned.filter((s) => s.status.outOfPlace);
      const [deliveries, shoppingSummary] = await Promise.all([stock.deliveries(), shopping.summary()]);
      return {
        today: world.today,
        counts: {
          products: owned.length,
          low: low.length,
          expiringSoon: expiring.length,
          outOfPlace: outOfPlace.length,
          expected: owned.filter((s) => s.status.hasExpected).length,
          wish: all.length - owned.length,
        },
        expiringSoon: expiring.slice(0, LIMIT),
        low: low.slice(0, LIMIT),
        outOfPlace: outOfPlace.slice(0, LIMIT),
        deliveries,
        shopping: shoppingSummary,
      };
    },
  };
}
