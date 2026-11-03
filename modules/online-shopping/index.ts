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
    const shops = createShops(ctx, services);
    shopFeatures(ctx, services, shops);
    slotFeatures(ctx, services, shops);
    favouriteFeatures(ctx, services, createFavourites(ctx, services));
  },
});
