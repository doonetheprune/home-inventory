/**
 * Online shopping: Larder fills an online basket (Tesco first) from what's
 * low or on offer, books delivery slots, and brings in the shop's favourites.
 * Each shop's website is driven by a separate shopping provider behind one
 * fixed contract (see contract.ts); Larder holds the stock and the buying
 * rules and makes every decision.
 */
import { defineModule } from '@larder/core';
import { createFavourites } from './favourites';
import { favouriteFeatures } from './favourites-api';
import { hubFeatures } from './hub-api';
import { OnlineFields } from './items';
import { itemFeatures } from './items-api';
import { providerFeatures } from './providers-api';
import { createServices } from './services';
import { createShops } from './shop';
import { shopFeatures } from './shop-api';
import { slotFeatures } from './slots-api';

export { HubView } from './hub';
export { ProviderView } from './providers';
export { OnlineFields } from './items';

export default defineModule({
  id: 'online-shopping',
  name: 'Online shopping',
  description: 'Fills your online basket (Tesco first) from what\'s low or on offer, books delivery slots and brings in your shop favourites, through a shopping provider on your network.',
  version: '1.0.0',
  defaultEnabled: true,
  productFields: OnlineFields,
  setup(ctx) {
    const services = createServices(ctx);
    hubFeatures(ctx, services);
    providerFeatures(ctx, services);
    itemFeatures(ctx, services);
    const favourites = createFavourites(ctx, services);
    const shops = createShops(ctx, services, favourites);
    shopFeatures(ctx, services, shops);
    slotFeatures(ctx, services, shops);
    favouriteFeatures(ctx, services, favourites);

    // An item now counted in what's inside (2 boxes became 40 tea bags): pack sizes, target prices
    // and the on-offer amount follow, so a basket never buys 20 times too much.
    ctx.on('product.recounted', async (event) => {
      const { productId, factor } = event.data as { productId: string; factor: number };
      const per = (n: number | null) => (n === null ? null : Math.round((n / factor) * 1_000_000) / 1_000_000);
      await ctx.core.products.updateField<unknown>(productId, 'online-shopping', (cur) => {
        const f = OnlineFields.parse(cur ?? {});
        const shops = Object.fromEntries(Object.entries(f.shops).map(([id, r]) => [id, { ...r, targetPrice: per(r.targetPrice), listings: r.listings.map((l) => ({ ...l, packQuantity: l.packQuantity * factor })) }]));
        return OnlineFields.parse({ ...f, shops, targetPrice: per(f.targetPrice), offerStockUpTo: f.offerStockUpTo === null ? null : f.offerStockUpTo * factor });
      });
    });
  },
});
