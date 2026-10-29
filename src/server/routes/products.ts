import { z } from 'zod';
import { Product, ProductCreate, ProductDetail, ProductFilter, ProductPatch, ProductSummary, Variant, VariantCreate, VariantPatch, type CoreApi } from '@larder/core';
import type { ZodApp } from '../app';
import { IdParams, Ok } from './common';

export function registerProductRoutes(app: ZodApp, { core }: { core: CoreApi }) {
  const tags = ['Products'];
  app.get('/products', {
    schema: { tags, summary: 'List products with stock summaries', description: 'Wish list items only appear with status=wish.', querystring: ProductFilter, response: { 200: z.array(ProductSummary) } },
  }, (r) => core.products.list(r.query));
  app.post('/products', { schema: { tags, summary: 'Add a product (no stock yet)', body: ProductCreate, response: { 200: Product } } }, (r) => core.products.create(r.body));
  app.get('/products/:id', { schema: { tags, summary: 'A product with its stock, variants, shops and history', params: IdParams, response: { 200: ProductDetail } } }, (r) => core.products.get(r.params.id));
  app.patch('/products/:id', { schema: { tags, summary: 'Change a product', params: IdParams, body: ProductPatch, response: { 200: Product } } }, (r) => core.products.update(r.params.id, r.body));
  app.delete('/products/:id', { schema: { tags, summary: 'Remove a product and its stock', params: IdParams, response: { 200: Ok } } }, async (r) => {
    await core.products.remove(r.params.id);
    return { ok: true as const };
  });
  app.put('/products/:id/shopping-list', {
    schema: { tags: ['Products', 'Shopping'], summary: 'Put a product on (or take it off) the shopping list by hand', params: IdParams, body: z.object({ onShoppingList: z.boolean() }), response: { 200: Product } },
  }, (r) => core.products.setOnList(r.params.id, r.body.onShoppingList));
  app.post('/products/:id/nfc', {
    schema: { tags, summary: 'Link an NFC tag to a product', params: IdParams, body: z.object({ tag: z.string().min(1).max(200) }), response: { 200: Product } },
  }, (r) => core.products.addNfcTag(r.params.id, r.body.tag));
  app.post('/products/:id/variants', { schema: { tags, summary: 'Add a brand, pack or barcode', params: IdParams, body: VariantCreate, response: { 200: Variant } } }, (r) => core.products.addVariant(r.params.id, r.body));
  app.patch('/variants/:id', { schema: { tags, summary: 'Change a variant', params: IdParams, body: VariantPatch, response: { 200: Variant } } }, (r) => core.products.updateVariant(r.params.id, r.body));
  app.delete('/variants/:id', { schema: { tags, summary: 'Remove a variant', params: IdParams, response: { 200: Ok } } }, async (r) => {
    await core.products.removeVariant(r.params.id);
    return { ok: true as const };
  });
}
