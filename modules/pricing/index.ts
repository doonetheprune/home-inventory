/**
 * Unit pricing: each product keeps its usual price per unit (per roll, per
 * bag, per 100 g, per kg, per litre). A different pack size is compared by
 * its price per unit, so "24 rolls for £8" can be checked against the usual
 * £0.36 a roll, and "£3.50 a kg" against the usual £0.40 per 100 g.
 */
import { z } from 'zod';
import { Id, NotFoundError, ValidationError, defineModule, pluralWord, type CoreApi, type Product } from '@larder/core';
import { ItemSize, MEASURES, choicesFor, defaultShow, isMeasure, packUnitsFor, perText, priceFactor, unitKey, whyNot, type Count } from './units';

export { ItemSize } from './units';

/**
 * Another measure of one of the item: 1 pack = 1 kg, or 1 pack = 5 items. `price` is the usual price
 * per one `unit` when it's bought that way (loose by the kg, single items), if known.
 */
export const Measure = z.object({
  unit: z.string().min(1).max(20),
  amount: z.number().positive().max(1_000_000),
  price: z.number().min(0).nullable().default(null),
});
export type Measure = z.infer<typeof Measure>;

export const PricingFields = z.object({
  /** Usual price per `priceUnit`, in the household currency. */
  usualUnitPrice: z.number().min(0).nullable().default(null),
  /** The unit that price is per. Defaults to the product's unit. */
  priceUnit: z.string().max(20).nullable().default(null),
  /** What the usual price came from, e.g. "Andrex 9 pack, £3.25 at Tesco". */
  basedOn: z.string().max(200).default(''),
  updatedAt: z.string().nullable().default(null),
  /** How much one of the product's unit holds (1 bag = 200 g), so prices can be per kg or per 100 g. */
  itemSize: ItemSize.nullable().default(null),
  /** The unit the price card shows prices per, e.g. "100g". */
  showPer: z.string().max(20).nullable().default(null),
  /** Other measures of one: its weight or volume (kept as `itemSize` too) and other ways of counting it, each with a price if known. */
  measures: z.array(Measure).max(10).default([]),
});
export type PricingFields = z.infer<typeof PricingFields>;

export const PriceCheck = z.object({
  productId: Id,
  /** How much is in the pack you're looking at (e.g. 24 rolls, 500 g). */
  quantity: z.number().positive(),
  /** The unit `quantity` is in: the product's own unit (default), or g, kg, ml, l. */
  unit: z.string().max(20).optional(),
  /** Price of the whole pack. */
  price: z.number().min(0),
});

export const PriceCheckResult = z.object({
  productId: z.string(),
  productName: z.string(),
  /** The unit prices below are per (the one the price card shows). */
  priceUnit: z.string(),
  /** That unit in words, e.g. "per 100 g". */
  per: z.string(),
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

/** What the price card shows: the usual price per each unit it can be shown in. */
export const PriceView = z.object({
  usual: z.object({ price: z.number(), unit: z.string(), per: z.string() }).nullable(),
  basedOn: z.string(),
  showPer: z.string(),
  options: z.array(z.object({ unit: z.string(), per: z.string(), price: z.number().nullable(), needsSize: z.boolean() })),
  itemSize: ItemSize.nullable(),
  /** The item's own unit, when it isn't a weight or volume (a bag, a roll): it can have a size. */
  itemUnit: z.string().nullable(),
  packUnits: z.array(z.string()),
  /** Its measures: "1 pack = 1 kg", "1 pack = 5 items", each with its price, recorded or worked out from the usual price. */
  measures: z.array(z.object({
    unit: z.string(), amount: z.number(), label: z.string(),
    price: z.number().nullable(), per: z.string().nullable(),
    /** True when the price was recorded for buying it this way, false when it's worked out from the usual price. */
    recorded: z.boolean(),
    /** The recorded price per one `unit` as stored (null when none), to send back when changing the list. */
    recordedPrice: z.number().nullable(),
  })).default([]),
}).meta({ id: 'PriceView' });
export type PriceView = z.infer<typeof PriceView>;

const PriceRecord = z.object({ productId: z.string(), shopId: z.string().nullable(), unitPrice: z.number(), quantity: z.number(), price: z.number(), at: z.string() });
type PriceRecord = z.infer<typeof PriceRecord>;

const SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' };
const SAME_WITHIN = 0.02;

export function money(amount: number, currency: string, decimals = 2): string {
  return `${SYMBOLS[currency] ?? `${currency} `}${amount.toFixed(decimals)}`;
}
/** Prices under £1 get a third decimal place when it matters: £0.333 a roll, but £0.55 per 100 g. */
export const priceText = (n: number, currency: string) => money(n, currency, n < 1 && Math.round(n * 1000) % 10 !== 0 ? 3 : 2);
const price = priceText;

function pricing(product: Product): PricingFields {
  return PricingFields.parse(product.fields.pricing ?? {});
}

/** Its measures, the weight or volume first. Older records only have `itemSize`. */
export function measuresOf(p: PricingFields): Measure[] {
  const list = p.measures.map((m) => ({ ...m, unit: unitKey(m.unit) }));
  if (p.itemSize && !list.some((m) => isMeasure(m.unit))) list.unshift({ unit: p.itemSize.unit, amount: p.itemSize.amount, price: null });
  return [...list.filter((m) => isMeasure(m.unit)), ...list.filter((m) => !isMeasure(m.unit))];
}
const sizeOf = (p: PricingFields): ItemSize | null => {
  const m = measuresOf(p).find((x) => isMeasure(x.unit));
  return m ? { amount: m.amount, unit: m.unit as ItemSize['unit'] } : null;
};
const countsOf = (p: PricingFields): Count[] => measuresOf(p).filter((m) => !isMeasure(m.unit)).map(({ unit, amount }) => ({ unit, amount }));

/** Checks and tidies a list of measures for a product: one weight or volume at most, none in its own unit. */
export function checkMeasures(product: Product, list: Array<z.input<typeof Measure>>): Measure[] {
  const own = unitKey(product.unit);
  const out = new Map<string, Measure>();
  for (const raw of list) {
    const m = Measure.parse(raw);
    const unit = unitKey(m.unit);
    if (unit === own || (['each', 'item', 'unit', 'one'].includes(unit) && own === 'each')) throw new ValidationError(`${product.name} is counted in ${own === 'each' ? 'ones' : pluralWord(own, 2)} already. Give another measure, e.g. 1 ${own} = 200 g, or = 5 slices.`);
    if (MEASURES[unit] && !['g', 'kg', 'ml', 'l'].includes(unit)) throw new ValidationError('Give a weight or volume in g, kg, ml or l.');
    if (isMeasure(unit) && isMeasure(own)) throw new ValidationError(`${product.name} is already counted in ${product.unit}, so it doesn't need a size.`);
    out.set(unit, { unit, amount: m.amount, price: m.price === null ? null : Math.round(m.price * 1_000_000) / 1_000_000 });
  }
  const sized = [...out.values()].filter((m) => isMeasure(m.unit));
  if (sized.length > 1) throw new ValidationError(`Give one weight or volume for one ${own} (e.g. 1 ${own} = 1 kg), not ${sized.length}.`);
  return [...sized, ...[...out.values()].filter((m) => !isMeasure(m.unit))];
}

/** Fields with a new list of measures, keeping `itemSize` in step with the weight or volume among them. */
function withMeasures(p: PricingFields, measures: Measure[]): PricingFields {
  const next = { ...p, measures, itemSize: null };
  return PricingFields.parse({ ...next, itemSize: sizeOf(next) });
}

/** Fields with a new size, which replaces the weight or volume among the measures (keeping its price if the unit is the same). */
function withSize(p: PricingFields, size: ItemSize | null): PricingFields {
  const old = measuresOf(p).find((m) => isMeasure(m.unit));
  const rest = measuresOf(p).filter((m) => !isMeasure(m.unit));
  return withMeasures(p, size ? [{ unit: size.unit, amount: size.amount, price: old?.unit === size.unit ? old.price : null }, ...rest] : rest);
}

/** Price per `from` as a price per `to`, or a ValidationError saying why it can't be. */
function convert(value: number, from: string, to: string, product: Product): number {
  const p = pricing(product);
  const f = priceFactor(from, to, product.unit, sizeOf(p), countsOf(p));
  if (f === null) throw new ValidationError(whyNot(from, to, product, countsOf(p)));
  return value * f;
}

/** "1 pack = 1 kg", "1 pack = 5 items", "1 bottle = 1.5 litres". */
function measureLabel(product: Product, m: Measure): string {
  const name = m.unit === 'l' ? (m.amount === 1 ? 'litre' : 'litres') : isMeasure(m.unit) ? m.unit : pluralWord(m.unit, m.amount);
  const own = unitKey(product.unit);
  return `${own === 'each' ? 'One' : `1 ${own}`} = ${Math.round(m.amount * 1000) / 1000} ${name}`;
}

export function priceView(product: Product, currency: string): PriceView {
  const p = pricing(product);
  const size = sizeOf(p);
  const counts = countsOf(p);
  const stored = p.priceUnit ?? product.unit;
  const choices = choicesFor(product.unit, size, counts);
  const wanted = p.showPer ? unitKey(p.showPer) : defaultShow(product.unit);
  const usualPer = (unit: string) => {
    const f = priceFactor(stored, unit, product.unit, size, counts);
    return p.usualUnitPrice !== null && f !== null ? Math.round(p.usualUnitPrice * f * 1_000_000) / 1_000_000 : null;
  };
  const options = choices.map((unit) => {
    const f = priceFactor(stored, unit, product.unit, size, counts);
    return { unit, per: perText(unit, product.unit, counts), price: usualPer(unit), needsSize: f === null };
  });
  const measures = measuresOf(p).map((m) => {
    // Shown as on a shelf label: per 100 g or 100 ml rather than per gram.
    const shelf = ({ g: '100g', ml: '100ml' } as Record<string, string>)[m.unit] ?? m.unit;
    const f = priceFactor(m.unit, shelf, product.unit, size, counts) ?? 1;
    const value = m.price !== null ? m.price * f : usualPer(shelf);
    return { unit: m.unit, amount: m.amount, label: measureLabel(product, m), price: value, per: value === null ? null : `${price(value, currency)} ${perText(shelf, product.unit, counts)}`, recorded: m.price !== null, recordedPrice: m.price };
  });
  // Show the chosen unit when the price can be worked out in it, else the one it's stored in.
  const shown = options.find((o) => o.unit === wanted && !o.needsSize) ?? options.find((o) => !o.needsSize) ?? options[0]!;
  return {
    usual: p.usualUnitPrice !== null && shown.price !== null ? { price: shown.price, unit: shown.unit, per: `${price(shown.price, currency)} ${shown.per}` } : null,
    basedOn: p.basedOn,
    showPer: shown.unit,
    options,
    itemSize: size,
    itemUnit: isMeasure(product.unit) ? null : unitKey(product.unit),
    packUnits: packUnitsFor(product.unit, counts),
    measures,
  };
}

export function checkPrice(product: Product, input: { quantity: number; unit?: string; price: number }, currency: string): PriceCheckResult {
  const p = pricing(product);
  const stored = p.priceUnit ?? product.unit;
  const show = priceView(product, currency).showPer;
  const packUnit = input.unit ?? product.unit;
  const unitPrice = convert(input.price / input.quantity, packUnit, show, product);
  // Bought by a measure with its own price (loose by the kg, single items): that's the usual to compare with.
  const byMeasure = measuresOf(p).find((m) => m.price !== null && m.unit === unitKey(packUnit));
  const usual = byMeasure ? convert(byMeasure.price!, byMeasure.unit, show, product) : p.usualUnitPrice === null ? null : convert(p.usualUnitPrice, stored, show, product);
  const per = (n: number) => `${price(n, currency)} ${perText(show, product.unit, countsOf(p))}`;
  const base = { productId: product.id, productName: product.name, priceUnit: show, per: perText(show, product.unit, countsOf(p)), unitPrice, usualUnitPrice: usual };
  if (usual === null || usual === 0) {
    return { ...base, difference: null, verdict: 'no_usual_price', savingOnPack: null, message: `That's ${per(unitPrice)}. There's no usual price for ${product.name.toLowerCase()} yet, so this could become the usual price.` };
  }
  const difference = (unitPrice - usual) / usual;
  const verdict = Math.abs(difference) < SAME_WITHIN ? 'same' : difference < 0 ? 'cheaper' : 'dearer';
  // How much of the shown unit the pack holds, for the saving on the whole pack.
  const packInShown = input.price / unitPrice;
  const savingOnPack = (usual - unitPrice) * (Number.isFinite(packInShown) ? packInShown : 0);
  const pct = Math.round(Math.abs(difference) * 100);
  const message =
    verdict === 'same'
      ? `That's ${per(unitPrice)}, about the same as the usual ${per(usual)}.`
      : `That's ${per(unitPrice)} against the usual ${price(usual, currency)}: ${pct}% ${verdict}, ${verdict === 'cheaper' ? 'saving' : 'costing'} about ${money(Math.abs(savingOnPack), currency)} ${verdict === 'cheaper' ? 'on' : 'more for'} this pack.`;
  return { ...base, difference, verdict, savingOnPack, message };
}

async function getProduct(core: CoreApi, id: string) {
  const s = await core.products.summary(id).catch(() => null);
  if (!s) throw new NotFoundError('Product', id);
  return s.product;
}

const UNIT_HELP = 'The unit: the item\'s own (default, e.g. "roll"), or "g", "100 g", "kg", "ml", "100 ml", "litre".';

export default defineModule({
  id: 'pricing',
  name: 'Unit pricing',
  description: 'Keeps the usual price per unit for each item (per item, per 100 g, per kg…) and checks whether a different pack is better value.',
  version: '1.1.0',
  productFields: PricingFields,
  setup(ctx) {
    const prices = ctx.collection<PriceRecord>('prices');
    const currency = async () => (await ctx.core.settings.get()).currency;

    /**
     * Makes a price per `unit` the usual one. It's kept per the item's own
     * unit when it can be converted to that, else per the unit given (a price
     * per kg for a bag of unknown size).
     */
    async function setUsual(product: Product, unitPrice: number, unit?: string, basedOn?: string): Promise<PricingFields> {
      const given = unit ?? product.unit;
      const p = pricing(product);
      const f = priceFactor(given, product.unit, product.unit, sizeOf(p), countsOf(p));
      if (f === null && !isMeasure(given)) throw new ValidationError(whyNot(given, product.unit, product, countsOf(p)));
      const value = f === null ? unitPrice : unitPrice * f;
      const priceUnit = f === null ? unitKey(given) : product.unit;
      const updated = await ctx.core.products.updateField<unknown>(product.id, 'pricing', (cur) => PricingFields.parse({ ...PricingFields.parse(cur ?? {}), usualUnitPrice: Math.round(value * 1_000_000) / 1_000_000, priceUnit, basedOn: basedOn ?? '', updatedAt: ctx.core.now() }));
      return pricing(updated);
    }

    ctx.addRoute({
      method: 'POST', path: '/check', summary: 'Is this pack cheaper than usual?',
      description: 'Give the pack size (in the product\'s unit, or g, kg, ml, l) and the pack price. Examples: 24 rolls for £8.00; 250 g for £1.20; a shelf price of £3.50/kg is 1 kg for 3.50.',
      body: PriceCheck, response: PriceCheckResult,
      async handler({ body }) {
        const input = PriceCheck.parse(body);
        return checkPrice(await getProduct(ctx.core, input.productId), input, await currency());
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/view/:productId', summary: 'The usual price per each unit it can be shown in (for the price card)',
      params: z.object({ productId: Id }), response: PriceView,
      async handler({ params }) {
        return priceView(await getProduct(ctx.core, (params as { productId: string }).productId), await currency());
      },
    });

    ctx.addRoute({
      method: 'PUT', path: '/display', summary: 'Choose the unit prices are shown per, and how much one item holds',
      description: 'showPer: e.g. "100g", "kg" or the item\'s own unit. itemSize: e.g. { amount: 200, unit: "g" } for a 200 g bag (null forgets it).',
      body: z.object({ productId: Id, showPer: z.string().max(20).nullable().optional(), itemSize: ItemSize.nullable().optional() }),
      response: PriceView,
      async handler({ body }) {
        const b = body as { productId: string; showPer?: string | null; itemSize?: ItemSize | null };
        const product = await getProduct(ctx.core, b.productId);
        if (b.itemSize && isMeasure(product.unit)) throw new ValidationError(`${product.name} is already counted in ${product.unit}, so it doesn't need a size.`);
        const updated = await ctx.core.products.updateField<unknown>(product.id, 'pricing', (cur) => {
          const p = PricingFields.parse(cur ?? {});
          const sized = b.itemSize !== undefined ? withSize(p, b.itemSize) : p;
          return PricingFields.parse({ ...sized, ...(b.showPer !== undefined ? { showPer: b.showPer && unitKey(b.showPer) } : {}) });
        });
        return priceView(updated, await currency());
      },
    });

    ctx.addRoute({
      method: 'PUT', path: '/usual', summary: 'Set the usual price per unit',
      description: 'Either give unitPrice (per `unit`), or quantity and price for a pack and it works out the price per unit. `unit` defaults to the product\'s own.',
      body: z.object({ productId: Id, unitPrice: z.number().min(0).optional(), quantity: z.number().positive().optional(), price: z.number().min(0).optional(), unit: z.string().max(20).optional(), priceUnit: z.string().max(20).optional(), basedOn: z.string().max(200).optional() }),
      response: PricingFields,
      async handler({ body }) {
        const b = body as { productId: string; unitPrice?: number; quantity?: number; price?: number; unit?: string; priceUnit?: string; basedOn?: string };
        const unitPrice = b.unitPrice ?? (b.quantity && b.price !== undefined ? b.price / b.quantity : undefined);
        if (unitPrice === undefined) throw new ValidationError('Give either unitPrice, or quantity and price.');
        return setUsual(await getProduct(ctx.core, b.productId), unitPrice, b.unit ?? b.priceUnit, b.basedOn);
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

    ctx.addTool({
      name: 'check_price', title: 'Is this pack cheaper than usual?', readOnly: true,
      description: 'Compare a pack or shelf price seen in a shop with the item\'s usual price, e.g. "24 rolls for £8 at Aldi", "250 g for £1.20", or a shelf label "£3.50/kg" (quantity 1, unit "kg", price 3.5). If it\'s good value, offer to make it the usual price with set_usual_price.',
      input: z.object({
        item: z.string().min(1).max(200).describe('The item, e.g. "toilet roll"'),
        quantity: z.number().positive().describe('How much is in the pack, e.g. 24 (rolls) or 250 (g)'),
        unit: z.string().max(20).optional().describe(UNIT_HELP),
        price: z.number().min(0).describe('Price of the whole pack, e.g. 8 for £8.00'),
      }),
      async run({ item, quantity, unit, price: packPrice }) {
        const product = await ctx.core.resolve.product(item);
        const r = checkPrice(product, { quantity, unit, price: packPrice }, await currency());
        return { text: r.message, data: r };
      },
    });

    ctx.addTool({
      name: 'set_usual_price', title: 'Set the usual price', destructive: true,
      description: 'Make a pack or shelf price the usual price for an item (only after the person agrees). Give the pack size, its unit and price; the price per unit is worked out.',
      input: z.object({
        item: z.string().min(1).max(200).describe('The item, e.g. "toilet roll"'),
        quantity: z.number().positive().describe('How much is in the pack, e.g. 24'),
        unit: z.string().max(20).optional().describe(UNIT_HELP),
        price: z.number().min(0).describe('Pack price, e.g. 8'),
        where: z.string().max(120).optional().describe('Where it was seen, e.g. "Aldi"'),
      }),
      async run({ item, quantity, unit, price: packPrice, where }) {
        const product = await ctx.core.resolve.product(item);
        const cur = await currency();
        const given = unit ? unitKey(unit) : unitKey(product.unit);
        await setUsual(product, packPrice / quantity, unit, `${quantity} ${given} for ${money(packPrice, cur)}${where ? ` at ${where}` : ''}`);
        const view = priceView(await getProduct(ctx.core, product.id), cur);
        return { text: `The usual price for ${product.name} is now ${view.usual?.per ?? 'set'}.`, data: view };
      },
    });

    ctx.addTool({
      name: 'convert_price', title: 'Convert a price to another unit', readOnly: true,
      description: 'Turn a price per one unit into a price per another, e.g. £3.50 a kg is £0.35 per 100 g. Give the item to convert between its own unit (a bag, a tin) and a weight or volume, using its size.',
      input: z.object({
        price: z.number().min(0).describe('The price, e.g. 3.5 for £3.50'),
        per: z.string().min(1).max(20).describe('The unit it\'s per, e.g. "kg"'),
        to: z.string().min(1).max(20).describe('The unit wanted, e.g. "100 g"'),
        item: z.string().max(200).optional().describe('The item, needed when either unit is the item\'s own (e.g. "bag")'),
      }),
      async run({ price: value, per, to, item }) {
        const cur = await currency();
        const product = item ? await ctx.core.resolve.product(item) : null;
        const itemUnit = product?.unit ?? 'each';
        if (!product && !(isMeasure(per) && isMeasure(to))) throw new ValidationError(`Say which item, so Larder knows how much one ${isMeasure(per) ? to : per} holds.`);
        const p = product ? pricing(product) : null;
        const counts = p ? countsOf(p) : [];
        const f = priceFactor(per, to, itemUnit, p ? sizeOf(p) : null, counts);
        if (f === null) throw new ValidationError(whyNot(per, to, product ?? { name: 'that item', unit: 'each' }, counts));
        const out = value * f;
        return { text: `${price(value, cur)} ${perText(per, itemUnit, counts)} is ${price(out, cur)} ${perText(to, itemUnit, counts)}.`, data: { price: out, per: unitKey(to) } };
      },
    });

    ctx.addTool({
      name: 'set_item_size', title: 'Say how much one item holds', destructive: true,
      description: 'Record how much one of an item holds, e.g. a bag of baby spinach is 200 g, so its prices can be compared per kg or per 100 g. Not needed for things already counted by weight or volume.',
      input: z.object({
        item: z.string().min(1).max(200).describe('The item, e.g. "baby spinach"'),
        amount: z.number().positive().describe('How much one holds, e.g. 200'),
        unit: z.enum(['g', 'kg', 'ml', 'l']).describe('g, kg, ml or l'),
      }),
      async run({ item, amount, unit }) {
        const product = await ctx.core.resolve.product(item);
        if (isMeasure(product.unit)) throw new ValidationError(`${product.name} is already counted in ${product.unit}, so it doesn't need a size.`);
        await ctx.core.products.updateField<unknown>(product.id, 'pricing', (cur) => withSize(PricingFields.parse(cur ?? {}), { amount, unit }));
        const by = unit === 'ml' || unit === 'l' ? 'per 100 ml and per litre' : 'per 100 g and per kg';
        return { text: `One ${unitKey(product.unit)} of ${product.name} is ${amount} ${unit}. Its prices can now be compared ${by}.`, data: { amount, unit } };
      },
    });

    ctx.addRoute({
      method: 'PUT', path: '/measures', summary: 'Set an item\'s measures: 1 pack = 1 kg, 1 pack = 5 items, each with its price if known',
      description: 'Replaces the list. At most one weight or volume (g, kg, ml or l), which is also the item\'s size; any other unit is another way of counting it. `price` is the usual price per one of that unit when bought that way.',
      body: z.object({ productId: Id, measures: z.array(Measure).max(10) }),
      response: PriceView,
      async handler({ body }) {
        const b = body as { productId: string; measures: Array<z.input<typeof Measure>> };
        const product = await getProduct(ctx.core, b.productId);
        const list = checkMeasures(product, b.measures);
        const updated = await ctx.core.products.updateField<unknown>(product.id, 'pricing', (cur) => withMeasures(PricingFields.parse(cur ?? {}), list));
        return priceView(updated, await currency());
      },
    });

    ctx.addTool({
      name: 'get_price', title: 'An item\'s usual price and measures', readOnly: true,
      description: 'The usual price of an item in each unit it can be shown in (per pack, per kg, per item…), what it\'s based on, and its measures ("1 pack = 1 kg", "1 pack = 5 items") with a price for each.',
      input: z.object({ item: z.string().min(1).max(200).describe('The item, e.g. "chicken breasts"') }),
      async run({ item }) {
        const product = await ctx.core.resolve.product(item);
        const cur = await currency();
        const view = priceView(product, cur);
        const prices = view.options.filter((o) => o.price !== null).map((o) => `${price(o.price!, cur)} ${o.per}`);
        const lines = [
          view.usual ? `${product.name}: usually ${prices.join(', ')}${view.basedOn ? ` (from ${view.basedOn})` : ''}.` : `${product.name}: no usual price yet.`,
          ...view.measures.map((m) => `- ${m.label}${m.per ? `: ${m.per}${m.recorded ? ' when bought that way' : ' (worked out)'}` : ''}`),
        ];
        if (!view.measures.length && view.itemUnit) lines.push(`No measures yet: set_measure records how much one ${view.itemUnit} holds (e.g. 1 kg, or 5 items).`);
        return { text: lines.join('\n'), data: view };
      },
    });

    ctx.addTool({
      name: 'set_measure', title: 'Record a measure of an item', destructive: true,
      description: 'Record how much one of an item holds in another unit, optionally with its price: "a pack of chicken is 1 kg", "a pack is 5 breasts", "loose bananas are £0.90 a kg". A weight or volume (g, kg, ml, l) is its size, for prices per kg; any other unit is another way of counting it. Replaces a measure in the same unit.',
      input: z.object({
        item: z.string().min(1).max(200).describe('The item, e.g. "chicken breasts"'),
        amount: z.number().positive().describe('How much of `unit` one of the item holds, e.g. 1 (kg) or 5 (items)'),
        unit: z.string().min(1).max(20).describe('g, kg, ml, l, or another way of counting it, e.g. "item", "slice", "breast"'),
        price: z.number().min(0).nullable().optional().describe('The usual price for one `unit` when bought that way, e.g. 6 for £6 a kg (for g or ml, per gram or ml). null forgets it'),
      }),
      async run({ item, amount, unit, price: each }) {
        const product = await ctx.core.resolve.product(item);
        const cur = measuresOf(pricing(product));
        const key = unitKey(unit);
        const old = cur.find((m) => m.unit === key);
        // A new weight replaces an old one, and a new volume an old one.
        const kept = cur.filter((m) => m.unit !== key && !(isMeasure(key) && isMeasure(m.unit)));
        const list = checkMeasures(product, [...kept, { unit: key, amount, price: each === undefined ? (old?.price ?? null) : each }]);
        const updated = await ctx.core.products.updateField<unknown>(product.id, 'pricing', (c) => withMeasures(PricingFields.parse(c ?? {}), list));
        const view = priceView(updated, await currency());
        const m = view.measures.find((x) => x.unit === key)!;
        return { text: `${product.name}: ${m.label}${m.per ? `, ${m.per}${m.recorded ? '' : ' worked out from the usual price'}` : ''}.`, data: view };
      },
    });

    ctx.addTool({
      name: 'remove_measure', title: 'Forget a measure of an item', destructive: true,
      description: 'Forget one of an item\'s measures, e.g. its weight, or "items" when 1 pack = 5 items.',
      input: z.object({
        item: z.string().min(1).max(200).describe('The item'),
        unit: z.string().min(1).max(20).describe('The measure\'s unit, e.g. "kg" or "item"'),
      }),
      async run({ item, unit }) {
        const product = await ctx.core.resolve.product(item);
        const key = unitKey(unit);
        const cur = measuresOf(pricing(product));
        if (!cur.some((m) => m.unit === key)) throw new ValidationError(`${product.name} has no measure in ${unit}. It has: ${cur.map((m) => m.unit).join(', ') || 'none'}.`);
        await ctx.core.products.updateField<unknown>(product.id, 'pricing', (c) => withMeasures(PricingFields.parse(c ?? {}), measuresOf(PricingFields.parse(c ?? {})).filter((m) => m.unit !== key)));
        return { text: `${product.name} no longer has a measure in ${unit}.`, data: { unit: key } };
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
          await ctx.core.products.updateField<unknown>(product.id, 'pricing', (cur) => {
            const p = PricingFields.parse(cur ?? {});
            return p.usualUnitPrice !== null ? p : { ...p, usualUnitPrice: Math.round(rec.unitPrice * 1_000_000) / 1_000_000, priceUnit: product.unit, basedOn: 'First price paid', updatedAt: event.at };
          });
        }
      }
    });
  },

  // Usual prices for a few of the example household's items, so the price card has something to show.
  async demo(ctx, seed) {
    const set = (name: string, fields: Partial<PricingFields>) => {
      const id = seed.products[name];
      return id ? ctx.core.products.updateField<unknown>(id, 'pricing', (cur) => PricingFields.parse({ ...PricingFields.parse(cur ?? {}), ...fields, updatedAt: ctx.core.now() })) : null;
    };
    await set('Toilet roll', { usualUnitPrice: 0.3611, basedOn: 'Andrex 9 rolls for £3.25 at Tesco' });
    await set('Baby spinach', { usualUnitPrice: 1.1, basedOn: '200 g bag for £1.10 at Aldi', itemSize: { amount: 200, unit: 'g' } });
    await set('Mature cheddar', { usualUnitPrice: 0.0095, basedOn: '400 g for £3.80 at Aldi' });
  },
});
