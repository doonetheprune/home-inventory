import { z } from 'zod';
import {
  Delivery, Id, ProductSummary, Purchase, ShoppingList, ShoppingSummary, StockAdd, StockArrive, StockCharge, StockEntryPatch, StockExpect, StockMove, StockReturn, StockUse,
  type CoreApi,
} from '@larder/core';
import type { ZodApp } from '../app';
import { IdParams } from './common';

export function registerStockRoutes(app: ZodApp, { core }: { core: CoreApi }) {
  const tags = ['Stock'];
  const res = { 200: ProductSummary };
  app.post('/stock/add', { schema: { tags, summary: 'Add stock', body: StockAdd, response: res } }, (r) => core.stock.add(r.body));
  app.post('/stock/use', {
    schema: { tags, summary: 'Use stock (soonest-expiring first). For rechargeables this marks them flat.', body: StockUse, response: res },
  }, (r) => core.stock.use(r.body));
  app.post('/stock/move', {
    schema: { tags, summary: 'Move stock', description: '`temporary` leaves it out of place until it goes back; `permanent` changes where it usually lives.', body: StockMove, response: res },
  }, (r) => core.stock.move(r.body));
  app.post('/stock/return', { schema: { tags, summary: 'Put out-of-place stock back in its usual place', body: StockReturn, response: res } }, (r) => core.stock.returnHome(r.body));
  app.post('/stock/charge', { schema: { tags, summary: 'Rechargeables: mark flat ones as charged', body: StockCharge, response: res } }, (r) => core.stock.charge(r.body));
  app.post('/stock/expect', {
    schema: { tags, summary: 'Record stock that has been ordered but not arrived', description: 'Expected stock counts towards stock when deciding what is low.', body: StockExpect, response: res },
  }, (r) => core.stock.expect(r.body));
  app.post('/stock/arrive', {
    schema: { tags, summary: 'A delivery (or part of one) arrived', body: StockArrive, response: { 200: z.object({ arrived: z.number(), products: z.array(ProductSummary) }) } },
  }, (r) => core.stock.arrive(r.body));
  app.get('/stock/deliveries', { schema: { tags, summary: 'Deliveries on the way', response: { 200: z.array(Delivery) } } }, () => core.stock.deliveries());
  app.post('/products/:id/renew', { schema: { tags, summary: 'Renewals: restart the clock from today', params: IdParams, response: res } }, (r) => core.stock.renew(r.params.id));
  app.patch('/stock/entries/:id', { schema: { tags, summary: 'Edit one batch (amount, expiry, place)', params: IdParams, body: StockEntryPatch, response: res } }, (r) => core.stock.updateEntry(r.params.id, r.body));
  app.delete('/stock/entries/:id', { schema: { tags, summary: 'Remove one batch', params: IdParams, response: res } }, (r) => core.stock.removeEntry(r.params.id));

  const shopTags = ['Shopping'];
  app.get('/shopping', { schema: { tags: shopTags, summary: 'How much is on each shop’s list, and which shop to go to', response: { 200: ShoppingSummary } } }, () => core.shopping.summary());
  app.get('/shopping/unassigned', {
    schema: { tags: shopTags, summary: 'Things to buy that none of your shops sell', response: { 200: ShoppingList.shape.groups } },
  }, () => core.shopping.unassigned());
  app.get('/shopping/:shopId', {
    schema: { tags: shopTags, summary: "The list for one shop: its favourites plus any-shop items in categories it sells", params: z.object({ shopId: Id }), response: { 200: ShoppingList } },
  }, (r) => core.shopping.forShop(r.params.shopId));
  app.post('/shopping/purchase', {
    schema: { tags: shopTags, summary: 'Bought: add ticked items to stock', body: Purchase, response: { 200: z.array(ProductSummary) } },
  }, (r) => core.shopping.purchase(r.body));
}
