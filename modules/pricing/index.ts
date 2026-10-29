/**
 * Unit pricing: each product keeps its usual price per unit (per roll, per kg,
 * per litre). A different pack size is compared by its price per unit, so
 * "24 rolls for £8" can be checked against the usual £0.36 a roll.
 */
import { z } from 'zod';
import { Id, NotFoundError, ValidationError, defineModule, type CoreApi, type Product } from '@larder/core';

export const PricingFields = z.object({
  /** Usual price per `priceUnit`, in the household currency. */
  usualUnitPrice: z.number().min(0).nullable().default(null),
  /** Unit the price is per. Defaults to the product's unit. */
  priceUnit: z.string().max(20).nullable().default(null),
  /** What the usual price came from, e.g. "Andrex 9 pack, £3.25 at Tesco". */
  basedOn: z.string().max(200).default(''),
  updatedAt: z.string().nullable().default(null),
});
export type PricingFields = z.infer<typeof PricingFields>;

export const PriceCheck = z.object({
  productId: Id,
  /** How many units are in the pack you're looking at (e.g. 24 rolls). */
  quantity: z.number().positive(),
  /** Price of the whole pack. */
  price: z.number().min(0),
});

export const PriceCheckResult = z.object({
  productId: z.string(),
  productName: z.string(),
  priceUnit: z.string(),
  unitPrice: z.number(),
  usualUnitPrice: z.number().nullable(),
  /** (unitPrice - usual) / usual, e.g. -0.08 is 8% cheaper. */
  difference: z.number().nullable(),
  verdict: z.enum(['cheaper', 'dearer', 'same', 'no_usual_price']),
  /** How much cheaper (positive) or dearer (negative) this pack is than the usual price. */
  savingOnPack: z.number().nullable(),
  /** One sentence for people (and AI assistants) to read out. */
  message: z.string(),
});
export type PriceCheckResult = z.infer<typeof PriceCheckResult>;

const PriceRecord = z.object({ productId: z.string(), shopId: z.string().nullable(), unitPrice: z.number(), quantity: z.number(), price: z.number(), at: z.string() });
type PriceRecord = z.infer<typeof PriceRecord>;

const SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' };
const SAME_WITHIN = 0.02;

export function money(amount: number, currency: string, decimals = 2): string {
  return `${SYMBOLS[currency] ?? `${currency} `}${amount.toFixed(decimals)}`;
}

function pricing(product: Product): PricingFields {
  return PricingFields.parse(product.fields.pricing ?? {});
}

export function checkPrice(product: Product, input: { quantity: number; price: number }, currency: string): PriceCheckResult {
  const p = pricing(product);
  const unit = p.priceUnit ?? product.unit;
  const unitPrice = input.price / input.quantity;
  const usual = p.usualUnitPrice;
  const per = (n: number) => `${money(n, currency, n < 1 ? 3 : 2)} a ${unit}`;
  if (usual === null || usual === 0) {
    return {
      productId: product.id, productName: product.name, priceUnit: unit, unitPrice, usualUnitPrice: usual, difference: null, verdict: 'no_usual_price', savingOnPack: null,
      message: `That's ${per(unitPrice)}. There's no usual price for ${product.name.toLowerCase()} yet, so this could become the usual price.`,
    };
  }
  const difference = (unitPrice - usual) / usual;
  const verdict = Math.abs(difference) < SAME_WITHIN ? 'same' : difference < 0 ? 'cheaper' : 'dearer';
  const savingOnPack = (usual - unitPrice) * input.quantity;
  const pct = Math.round(Math.abs(difference) * 100);
  const message =
    verdict === 'same'
      ? `That's ${per(unitPrice)}, about the same as the usual ${per(usual)}.`
      : `That's ${per(unitPrice)} against the usual ${money(usual, currency, usual < 1 ? 3 : 2)}: ${pct}% ${verdict}, ${verdict === 'cheaper' ? 'saving' : 'costing'} about ${money(Math.abs(savingOnPack), currency)} ${verdict === 'cheaper' ? 'on' : 'more for'} this pack.`;
  return { productId: product.id, productName: product.name, priceUnit: unit, unitPrice, usualUnitPrice: usual, difference, verdict, savingOnPack, message };
}

async function getProduct(core: CoreApi, id: string) {
  const s = await core.products.summary(id).catch(() => null);
  if (!s) throw new NotFoundError('Product', id);
  return s.product;
}

export default defineModule({
  id: 'pricing',
  name: 'Unit pricing',
  description: 'Keeps the usual price per unit for each item and checks whether a different pack is better value.',
  version: '1.0.0',
  productFields: PricingFields,
  setup(ctx) {
    const prices = ctx.collection<PriceRecord>('prices');

    ctx.addRoute({
      method: 'POST', path: '/check', summary: 'Is this pack cheaper than usual?',
      description: 'Give the pack size in the product\'s price unit and the pack price. Example: 24 rolls for £8.00.',
      body: PriceCheck, response: PriceCheckResult,
      async handler({ body }) {
        const input = PriceCheck.parse(body);
        const product = await getProduct(ctx.core, input.productId);
        const { currency } = await ctx.core.settings.get();
        return checkPrice(product, input, currency);
      },
    });

    ctx.addRoute({
      method: 'PUT', path: '/usual', summary: 'Set the usual price per unit',
      description: 'Either give unitPrice directly, or quantity and price for a pack and it works out the unit price.',
      body: z.object({ productId: Id, unitPrice: z.number().min(0).optional(), quantity: z.number().positive().optional(), price: z.number().min(0).optional(), priceUnit: z.string().max(20).optional(), basedOn: z.string().max(200).optional() }),
      response: PricingFields,
      async handler({ body }) {
        const b = body as { productId: string; unitPrice?: number; quantity?: number; price?: number; priceUnit?: string; basedOn?: string };
        const unitPrice = b.unitPrice ?? (b.quantity && b.price !== undefined ? b.price / b.quantity : undefined);
        if (unitPrice === undefined) throw new ValidationError('Give either unitPrice, or quantity and price.');
        const product = await getProduct(ctx.core, b.productId);
        const next = PricingFields.parse({ ...pricing(product), usualUnitPrice: Math.round(unitPrice * 10000) / 10000, priceUnit: b.priceUnit ?? pricing(product).priceUnit, basedOn: b.basedOn ?? '', updatedAt: ctx.core.now() });
        await ctx.core.products.update(product.id, { fields: { pricing: next } });
        return next;
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/history/:productId', summary: 'Prices paid for a product, newest first',
      params: z.object({ productId: Id }), response: z.array(PriceRecord),
      async handler({ params }) {
        const { productId } = params as { productId: string };
        return (await prices.list()).map((d) => d.data).filter((r) => r.productId === productId).sort((a, b) => b.at.localeCompare(a.at));
      },
    });

    // Remember what was paid at the till, and use the first price as the usual one.
    ctx.on('shopping.purchased', async (event) => {
      const data = event.data as { shopId: string | null; items: Array<{ productId: string; quantity: number; price?: number }> };
      for (const item of data.items) {
        if (item.price === undefined || item.quantity <= 0) continue;
        const rec: PriceRecord = { productId: item.productId, shopId: data.shopId, quantity: item.quantity, price: item.price, unitPrice: item.price / item.quantity, at: event.at };
        await prices.put(`${item.productId}:${event.at}`, rec);
        const product = await getProduct(ctx.core, item.productId).catch(() => null);
        if (product && pricing(product).usualUnitPrice === null) {
          await ctx.core.products.update(product.id, { fields: { pricing: { ...pricing(product), usualUnitPrice: Math.round(rec.unitPrice * 10000) / 10000, basedOn: 'First price paid', updatedAt: event.at } } });
        }
      }
    });
  },
});
