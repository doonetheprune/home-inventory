/** Products (generic items like "milk") and their variants (brands, packs, barcodes). */
import { z } from 'zod';
import { Product, Variant, type ProductDetail, type ProductSummary, type StockEntryView } from '../model';
import { ProductCreate, ProductPatch, VariantCreate, VariantPatch, type ProductFilter } from '../inputs';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { newId, unique } from '../util';
import type { CoreContext } from './context';
import { eligibleShops, loadWorld, placeRef, summarise } from './world';

export function createProductService(ctx: CoreContext, validateFields: (fields: Record<string, unknown>) => Record<string, unknown>) {
  async function assertRefs(p: Pick<Product, 'categoryId' | 'preferredShopIds' | 'defaultPlaceId'>) {
    if (p.categoryId && !(await ctx.storage.categories.get(p.categoryId))) throw new NotFoundError('Category', p.categoryId);
    for (const s of p.preferredShopIds) if (!(await ctx.storage.shops.get(s))) throw new NotFoundError('Shop', s);
    if (p.defaultPlaceId && !(await ctx.storage.places.get(p.defaultPlaceId))) throw new NotFoundError('Place', p.defaultPlaceId);
  }

  function tidy(p: Product): Product {
    const aliases = unique(p.aliases.map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== p.name.trim().toLowerCase()));
    return { ...p, name: p.name.trim(), aliases, preferredShopIds: unique(p.preferredShopIds), fields: validateFields(p.fields) };
  }

  async function assertBarcodesFree(barcodes: string[], exceptVariantId?: string) {
    for (const code of barcodes) {
      const v = await ctx.storage.variants.findByBarcode(code);
      if (v && v.id !== exceptVariantId) {
        const owner = await ctx.storage.products.get(v.productId);
        throw new ConflictError(`Barcode ${code} already belongs to ${owner?.name ?? 'another item'}.`);
      }
    }
  }

  const service = {
    async list(filter: ProductFilter = {}): Promise<ProductSummary[]> {
      const world = await loadWorld(ctx);
      const status = filter.status ?? 'all';
      return world.products
        .map((p) => summarise(world, p))
        .filter((s) => {
          if (filter.categoryId && s.product.categoryId !== filter.categoryId) return false;
          if (filter.placeId) {
            const here = (world.entriesByProduct.get(s.product.id) ?? []).some((e) => e.placeId === filter.placeId || e.currentPlaceId === filter.placeId);
            if (!here) return false;
          }
          switch (status) {
            case 'low': return s.status.low;
            case 'expiring': return s.status.expiringSoon;
            case 'out_of_place': return s.status.outOfPlace;
            case 'expected': return s.status.hasExpected;
            case 'wish': return s.product.wish;
            case 'in_stock': return !s.product.wish && s.inStock > 0;
            default: return !s.product.wish;
          }
        })
        .sort((a, b) => a.product.name.localeCompare(b.product.name, 'en-GB'));
    },

    async summary(id: string): Promise<ProductSummary> {
      const world = await loadWorld(ctx);
      const p = world.productById.get(id);
      if (!p) throw new NotFoundError('Product', id);
      return summarise(world, p);
    },

    async get(id: string): Promise<ProductDetail> {
      const world = await loadWorld(ctx);
      const product = world.productById.get(id);
      if (!product) throw new NotFoundError('Product', id);
      const [variants, history] = await Promise.all([ctx.storage.variants.listByProduct(id), ctx.storage.movements.listByProduct(id, 30)]);
      const variantName = new Map(variants.map((v) => [v.id, v.name]));
      const entries: StockEntryView[] = (world.entriesByProduct.get(id) ?? [])
        .filter((e) => e.quantity > 0)
        .map((e) => ({
          ...e,
          place: placeRef(world, e.placeId),
          currentPlace: placeRef(world, e.currentPlaceId),
          variantName: e.variantId ? (variantName.get(e.variantId) ?? null) : null,
        }))
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'in_stock' ? -1 : 1) || (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999'));
      return {
        ...summarise(world, product),
        variants: variants.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        entries,
        shops: eligibleShops(product, world.shops),
        history,
      };
    },

    async create(input: z.input<typeof ProductCreate>): Promise<Product> {
      const data = ProductCreate.parse(input);
      await assertRefs(data);
      const now = ctx.now();
      const product = tidy(Product.parse({ ...data, id: newId(), createdAt: now, updatedAt: now }));
      if (product.rechargeable && product.unit === 'each') product.unit = 'battery';
      await ctx.storage.products.put(product);
      ctx.publish('product.created', { id: product.id, name: product.name });
      return product;
    },

    async update(id: string, patch: z.infer<typeof ProductPatch>): Promise<Product> {
      const cur = await ctx.storage.products.get(id);
      if (!cur) throw new NotFoundError('Product', id);
      const fields = patch.fields ? { ...cur.fields, ...patch.fields } : cur.fields;
      const next = tidy(Product.parse({ ...cur, ...patch, fields, id, createdAt: cur.createdAt, updatedAt: ctx.now() }));
      await assertRefs(next);
      await ctx.storage.products.put(next);
      ctx.publish('product.updated', { id, name: next.name });
      return next;
    },

    /** Removes the product, its variants and its stock. History is kept. */
    async remove(id: string): Promise<void> {
      const cur = await ctx.storage.products.get(id);
      if (!cur) throw new NotFoundError('Product', id);
      const entries = await ctx.storage.stock.listByProduct(id);
      await ctx.storage.applyStockChanges({ remove: entries.map((e) => e.id) });
      for (const v of await ctx.storage.variants.listByProduct(id)) await ctx.storage.variants.remove(v.id);
      await ctx.storage.products.remove(id);
      ctx.publish('product.deleted', { id, name: cur.name });
    },

    async setOnList(id: string, onShoppingList: boolean): Promise<Product> {
      return service.update(id, { onShoppingList });
    },

    async addVariant(productId: string, input: z.input<typeof VariantCreate>): Promise<Variant> {
      if (!(await ctx.storage.products.get(productId))) throw new NotFoundError('Product', productId);
      const data = VariantCreate.parse(input);
      const barcodes = unique(data.barcodes.map((b) => b.trim()).filter(Boolean));
      await assertBarcodesFree(barcodes);
      const variant = Variant.parse({ ...data, barcodes, id: newId(), productId, createdAt: ctx.now() });
      await ctx.storage.variants.put(variant);
      ctx.publish('product.updated', { id: productId });
      return variant;
    },

    async updateVariant(variantId: string, patch: z.infer<typeof VariantPatch>): Promise<Variant> {
      const cur = await ctx.storage.variants.get(variantId);
      if (!cur) throw new NotFoundError('Variant', variantId);
      const barcodes = patch.barcodes ? unique(patch.barcodes.map((b) => b.trim()).filter(Boolean)) : cur.barcodes;
      await assertBarcodesFree(barcodes, variantId);
      const next = Variant.parse({ ...cur, ...patch, barcodes, id: cur.id, productId: cur.productId, createdAt: cur.createdAt });
      await ctx.storage.variants.put(next);
      ctx.publish('product.updated', { id: cur.productId });
      return next;
    },

    async removeVariant(variantId: string): Promise<void> {
      const cur = await ctx.storage.variants.get(variantId);
      if (!cur) throw new NotFoundError('Variant', variantId);
      const entries = (await ctx.storage.stock.listByProduct(cur.productId)).filter((e) => e.variantId === variantId);
      if (entries.length) await ctx.storage.applyStockChanges({ put: entries.map((e) => ({ ...e, variantId: null })) });
      await ctx.storage.variants.remove(variantId);
      ctx.publish('product.updated', { id: cur.productId });
    },

    async addNfcTag(productId: string, tag: string): Promise<Product> {
      const t = tag.trim();
      if (!t) throw new ValidationError('The NFC tag id is empty.');
      const other = (await ctx.storage.products.findByNfcTag(t)) ?? (await ctx.storage.places.findByNfcTag(t));
      if (other && other.id !== productId) throw new ConflictError(`That tag is already linked to ${other.name}.`);
      const cur = await ctx.storage.products.get(productId);
      if (!cur) throw new NotFoundError('Product', productId);
      return service.update(productId, { nfcTags: unique([...cur.nfcTags, t]) });
    },
  };
  return service;
}
