/**
 * Working out what a scanned or typed code is: a product you already have, a
 * place label, an NFC tag, or a barcode one of the lookup providers knows.
 * Unknown barcodes are named once and remembered locally.
 */
import type { IdentifyResult, LookupRecord, LookupResult, ProductSummary, Variant } from '../model';
import { Variant as VariantSchema } from '../model';
import { Remember as RememberSchema, type Remember } from '../inputs';
import { NotFoundError } from '../errors';
import type { CoreContext } from './context';
import type { createProductService } from './products';
import { loadWorld, placePath, summarise } from './world';

/** A barcode database such as Open Food Facts. Modules register these. */
export interface LookupProvider {
  id: string;
  name: string;
  lookup(barcode: string, options: { signal: AbortSignal }): Promise<Omit<LookupResult, 'provider' | 'barcode'> | null>;
}

const MISS_TTL_DAYS = 7;
const BARCODE = /^\d{6,14}$/;

/** Codes inside Larder's own QR labels and links. */
function parseLarderCode(code: string): { kind: 'place' | 'product'; id: string } | null {
  const m = code.match(/^larder:(place|product):(.+)$/i) ?? code.match(/#\/(places|products)\/([^/?#\s]+)/);
  if (!m) return null;
  return { kind: m[1]!.toLowerCase().startsWith('place') ? 'place' : 'product', id: decodeURIComponent(m[2]!) };
}

export function createLookupService(ctx: CoreContext, products: ReturnType<typeof createProductService>, isEnabled: (providerId: string) => boolean) {
  const providers: LookupProvider[] = [];

  async function productResult(code: string, productId: string, variant: Variant | null): Promise<IdentifyResult | null> {
    const world = await loadWorld(ctx);
    const p = world.productById.get(productId);
    return p ? { kind: 'product', code, product: summarise(world, p), variant } : null;
  }

  async function suggestionsFor(name: string): Promise<ProductSummary[]> {
    const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (!words.length) return [];
    const all = await products.list({ status: 'all' });
    return all
      .map((s) => ({ s, score: words.filter((w) => [s.product.name, ...s.product.aliases].join(' ').toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.s);
  }

  async function askProviders(barcode: string): Promise<{ result: LookupResult | null; tried: string[] }> {
    const tried: string[] = [];
    for (const p of providers) {
      if (!isEnabled(p.id)) continue;
      tried.push(p.name);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ctx.lookupTimeoutMs);
      try {
        const found = await p.lookup(barcode, { signal: controller.signal });
        if (found?.name) return { result: { ...found, provider: p.id, barcode }, tried };
      } catch {
        // A provider being down or slow shouldn't stop the others.
      } finally {
        clearTimeout(timer);
      }
    }
    return { result: null, tried };
  }

  return {
    registerProvider(provider: LookupProvider) {
      providers.push(provider);
    },
    providers: () => providers.map((p) => ({ id: p.id, name: p.name, enabled: isEnabled(p.id) })),

    async identify(raw: string, options: { offline?: boolean } = {}): Promise<IdentifyResult> {
      const code = raw.trim();
      const own = parseLarderCode(code);
      if (own?.kind === 'product') {
        const r = await productResult(code, own.id, null);
        if (r) return r;
      }
      if (own?.kind === 'place') {
        const place = await ctx.storage.places.get(own.id);
        if (place) {
          const places = await ctx.storage.places.list();
          return { kind: 'place', code, place, path: placePath(new Map(places.map((p) => [p.id, p])), place.id) };
        }
      }

      const variant = await ctx.storage.variants.findByBarcode(code);
      if (variant) {
        const r = await productResult(code, variant.productId, variant);
        if (r) return r;
      }
      const place = (await ctx.storage.places.findByCode(code)) ?? (await ctx.storage.places.findByNfcTag(code));
      if (place) {
        const places = await ctx.storage.places.list();
        return { kind: 'place', code, place, path: placePath(new Map(places.map((p) => [p.id, p])), place.id) };
      }
      const tagged = await ctx.storage.products.findByNfcTag(code);
      if (tagged) return (await productResult(code, tagged.id, null))!;
      const byShopCode = await ctx.storage.variants.findByShopCode(code);
      if (byShopCode) {
        const r = await productResult(code, byShopCode.productId, byShopCode);
        if (r) return r;
      }

      if (!BARCODE.test(code)) return { kind: 'unknown', code, providersTried: [] };

      const cached = await ctx.storage.lookups.get(code);
      const fresh = cached && Date.parse(ctx.now()) - Date.parse(cached.fetchedAt) < MISS_TTL_DAYS * 86_400_000;
      if (cached?.found && cached.name) {
        const result: LookupResult = { provider: cached.provider ?? 'cache', barcode: code, name: cached.name, brand: cached.brand, quantityText: cached.quantityText, imageUrl: cached.imageUrl, categories: cached.categories };
        return { kind: 'external', code, result, suggestions: await suggestionsFor(result.name) };
      }
      if ((cached && fresh) || options.offline) return { kind: 'unknown', code, providersTried: [] };

      const { result, tried } = await askProviders(code);
      const record: LookupRecord = {
        barcode: code, found: !!result, provider: result?.provider ?? null, name: result?.name ?? null, brand: result?.brand ?? null,
        quantityText: result?.quantityText ?? null, imageUrl: result?.imageUrl ?? null, categories: result?.categories ?? [], fetchedAt: ctx.now(),
      };
      await ctx.storage.lookups.put(record);
      if (!result) return { kind: 'unknown', code, providersTried: tried };
      return { kind: 'external', code, result, suggestions: await suggestionsFor(result.name) };
    },

    /** Name an unknown barcode once (or link it to an existing product) so it's instant next time. */
    async remember(raw: Remember): Promise<{ product: ProductSummary; variant: Variant }> {
      const input = RememberSchema.parse(raw);
      let productId = input.productId;
      if (!productId) productId = (await products.create(input.create!)).id;
      else if (!(await ctx.storage.products.get(productId))) throw new NotFoundError('Product', productId);
      const product = (await ctx.storage.products.get(productId))!;
      const existing = await ctx.storage.variants.findByBarcode(input.barcode);
      let variant: Variant;
      if (existing && existing.productId === productId) variant = existing;
      else {
        const cached = await ctx.storage.lookups.get(input.barcode);
        variant = await products.addVariant(productId, VariantSchema.omit({ id: true, productId: true, createdAt: true }).parse({
          name: input.variantName ?? ([cached?.brand, cached?.name].filter(Boolean).join(' ') || product.name),
          barcodes: [input.barcode],
          imageUrl: input.imageUrl ?? cached?.imageUrl ?? null,
          source: input.source ?? cached?.provider ?? 'local',
        }));
      }
      return { product: await products.summary(productId), variant };
    },
  };
}
