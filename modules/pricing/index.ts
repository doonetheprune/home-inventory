/**
 * Unit pricing: each product keeps its usual price per one of what it's bought
 * in (per roll, per bag), or per 100 g, kg or litre when that's how it's priced.
 * A different pack is compared by its price per unit, so "24 rolls for £8" can be
 * checked against the usual £0.36 a roll, and "£3.50 a kg" against the usual £0.40
 * per 100 g. Conversions go through the core's converter (./units.ts).
 */
import { z } from 'zod';
import { Id, NotFoundError, ValidationError, Weight, amountText, defineModule, isCount, isLoose, isMeasure, type CoreApi, type Product, type Units } from '@larder/core';
import { choicesFor, defaultShow, factorOrNull, measureFactor, packUnitsFor, perText, priceFactor, priceKey } from './units';

/** What one holds, as this module kept it before 0.10.0 (moved to the item's Weight when the module starts). */
export const ItemSize = z.object({
  amount: z.number().positive().max(1_000_000),
  unit: z.enum(['g', 'kg', 'ml', 'l']),
});
export type ItemSize = z.infer<typeof ItemSize>;

export const PricingFields = z.object({
  /** Usual price per `priceUnit`, in the household currency. */
  usualUnitPrice: z.number().min(0).nullable().default(null),
  /** The unit that price is per: null for what it's bought in, or a price label ("kg") for a bag whose Weight isn't known yet. */
  priceUnit: z.string().max(30).nullable().default(null),
  /** What the usual price came from, e.g. "Andrex 9 pack, £3.25 at Tesco". */
  basedOn: z.string().max(200).default(''),
  updatedAt: z.string().nullable().default(null),
  /** Before 0.10.0: what one weighed. Moved to the item's Weight when the module starts. */
  itemSize: ItemSize.nullable().default(null),
  /** The unit the price card shows prices per, e.g. "100g". */
  showPer: z.string().max(20).nullable().default(null),
});
export type PricingFields = z.infer<typeof PricingFields>;

export const PriceCheck = z.object({
  productId: Id,
  /** How much is in the pack you're looking at (e.g. 24 rolls, 500 g). */
  quantity: z.number().positive(),
  /** The unit `quantity` is in: what the item is bought in (default), what's in its pack, or g, kg, ml or L. */
  unit: z.string().max(30).optional(),
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
  /** `needsSize`: the price can't be worked out per this until the item has a Weight. */
  options: z.array(z.object({ unit: z.string(), per: z.string(), price: z.number().nullable(), needsSize: z.boolean() })),
  /** The item's Weight (as `weight`), for older apps. */
  itemSize: Weight.nullable(),
  /** What one weighs or holds, in g or ml: the item's Weight. */
  weight: Weight.nullable(),
  /** Whether the Weight is the item's own (false when it comes from its pack size, so it's changed there). */
  weightEditable: z.boolean(),
  /** One of what it's bought in, when that isn't g or ml (a bag, a roll): it can have a Weight. */
  itemUnit: z.string().nullable(),
  packUnits: z.array(z.string()),
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

/** Price per `from` as a price per `to`, or a ValidationError saying why it can't be. */
const convert = (units: Units, value: number, from: string, to: string, product: Product) => value * priceFactor(units, product, from, to);

/** The unit a stored price is per: what it's bought in, unless it was kept per a label. */
const storedPer = (product: Product) => pricing(product).priceUnit ?? product.unit;

export function priceView(units: Units, product: Product, currency: string): PriceView {
  const p = pricing(product);
  const stored = storedPer(product);
  const wanted = p.showPer ?? defaultShow(units, product);
  const options = choicesFor(units, product).map((unit) => {
    const f = factorOrNull(units, product, stored, unit);
    return { unit, per: perText(units, product, unit), price: p.usualUnitPrice !== null && f !== null ? Math.round(p.usualUnitPrice * f * 1_000_000) / 1_000_000 : null, needsSize: f === null };
  });
  // Show the chosen unit when the price can be worked out in it, else the first that can.
  const shown = options.find((o) => o.unit === wanted && !o.needsSize) ?? options.find((o) => !o.needsSize) ?? options[0]!;
  const fromPackSize = !!product.packSize && !isCount(units, product.packSize.unit);
  return {
    usual: p.usualUnitPrice !== null && shown.price !== null ? { price: shown.price, unit: shown.unit, per: `${price(shown.price, currency)} ${shown.per}` } : null,
    basedOn: p.basedOn,
    showPer: shown.unit,
    options,
    itemSize: product.weight,
    weight: product.weight,
    weightEditable: !fromPackSize,
    itemUnit: isLoose(units, product) ? null : (units.find(product.unit)?.key === 'each' ? 'item' : (units.find(product.unit)?.one ?? product.unit)),
    packUnits: packUnitsFor(units, product),
  };
}

export function checkPrice(units: Units, product: Product, input: { quantity: number; unit?: string; price: number }, currency: string): PriceCheckResult {
  const p = pricing(product);
  const show = priceView(units, product, currency).showPer;
  const unitPrice = convert(units, input.price / input.quantity, input.unit ?? product.unit, show, product);
  const usual = p.usualUnitPrice === null ? null : convert(units, p.usualUnitPrice, storedPer(product), show, product);
  const per = (n: number) => `${price(n, currency)} ${perText(units, product, show)}`;
  const base = { productId: product.id, productName: product.name, priceUnit: show, per: perText(units, product, show), unitPrice, usualUnitPrice: usual };
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

const UNIT_HELP = 'The unit: what the item is bought in (default, e.g. "roll"), what\'s in its pack (e.g. "tea bag"), or "g", "100 g", "kg", "ml", "100 ml", "litre".';

export default defineModule({
  id: 'pricing',
  name: 'Unit pricing',
  description: 'Keeps the usual price per unit for each item (per item, per 100 g, per kg…) and checks whether a different pack is better value.',
  version: '1.1.0',
  productFields: PricingFields,
  async setup(ctx) {
    const prices = ctx.collection<PriceRecord>('prices');
    const currency = async () => (await ctx.core.settings.get()).currency;
    const units = () => ctx.core.units.list();

    /**
     * Makes a price per `unit` the usual one. It's kept per one of what the item is bought in
     * when it can be turned into that, else per the weight or volume given (a price per kg for
     * a bag whose Weight isn't known yet).
     */
    async function setUsual(product: Product, unitPrice: number, unit?: string, basedOn?: string): Promise<PricingFields> {
      const u = await units();
      const given = unit ?? product.unit;
      const f = factorOrNull(u, product, given, product.unit);
      if (f === null && !['100g', 'kg', '100ml', 'l', 'g', 'ml'].includes(priceKey(u, product, given))) priceFactor(u, product, given, product.unit);
      const value = f === null ? unitPrice : unitPrice * f;
      const priceUnit = f === null ? priceKey(u, product, given) : null;
      const updated = await ctx.core.products.updateField<unknown>(product.id, 'pricing', (cur) => PricingFields.parse({ ...PricingFields.parse(cur ?? {}), usualUnitPrice: Math.round(value * 1_000_000) / 1_000_000, priceUnit, basedOn: basedOn ?? '', updatedAt: ctx.core.now() }));
      return pricing(updated);
    }

    ctx.addRoute({
      method: 'POST', path: '/check', summary: 'Is this pack cheaper than usual?',
      description: 'Give the pack size (in the product\'s unit, or g, kg, ml, l) and the pack price. Examples: 24 rolls for £8.00; 250 g for £1.20; a shelf price of £3.50/kg is 1 kg for 3.50.',
      body: PriceCheck, response: PriceCheckResult,
      async handler({ body }) {
        const input = PriceCheck.parse(body);
        return checkPrice(await units(), await getProduct(ctx.core, input.productId), input, await currency());
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/view/:productId', summary: 'The usual price per each unit it can be shown in (for the price card)',
      params: z.object({ productId: Id }), response: PriceView,
      async handler({ params }) {
        return priceView(await units(), await getProduct(ctx.core, (params as { productId: string }).productId), await currency());
      },
    });

    ctx.addRoute({
      method: 'PUT', path: '/display', summary: 'Choose the unit prices are shown per, and the item\'s Weight',
      description: 'showPer: e.g. "100g", "kg" or what the item is bought in. weight (or itemSize, for older apps): what one weighs or holds, e.g. { amount: 200, unit: "g" } for a 200 g bag, null to forget it. It\'s the item\'s Weight, so the product service checks it (refused when the pack size is an amount, or for things bought loose).',
      body: z.object({ productId: Id, showPer: z.string().max(30).nullable().optional(), weight: ItemSize.nullable().optional(), itemSize: ItemSize.nullable().optional() }),
      response: PriceView,
      async handler({ body }) {
        const b = body as { productId: string; showPer?: string | null; weight?: ItemSize | null; itemSize?: ItemSize | null };
        const product = await getProduct(ctx.core, b.productId);
        const u = await units();
        // The Weight is the item's (it works out usage in grams too); the shown unit is this card's.
        const weight = b.weight !== undefined ? b.weight : b.itemSize;
        if (weight !== undefined) await ctx.core.products.update(product.id, { weight });
        const updated = b.showPer !== undefined
          ? await ctx.core.products.updateField<unknown>(product.id, 'pricing', (cur) => PricingFields.parse({ ...PricingFields.parse(cur ?? {}), showPer: b.showPer && priceKey(u, product, b.showPer) }))
          : await getProduct(ctx.core, product.id);
        return priceView(u, updated, await currency());
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
        const r = checkPrice(await units(), product, { quantity, unit, price: packPrice }, await currency());
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
        const [cur, u] = await Promise.all([currency(), units()]);
        await setUsual(product, packPrice / quantity, unit, `${amountText(u, quantity, unit ?? product.unit)} for ${money(packPrice, cur)}${where ? ` at ${where}` : ''}`);
        const view = priceView(u, await getProduct(ctx.core, product.id), cur);
        return { text: `The usual price for ${product.name} is now ${view.usual?.per ?? 'set'}.`, data: view };
      },
    });

    ctx.addTool({
      name: 'convert_price', title: 'Convert a price to another unit', readOnly: true,
      description: 'Turn a price per one unit into a price per another, e.g. £3.50 a kg is £0.35 per 100 g. Give the item to convert between what it\'s bought in or what\'s in its pack (a bag, a tea bag) and a weight or volume, through its Weight.',
      input: z.object({
        price: z.number().min(0).describe('The price, e.g. 3.5 for £3.50'),
        per: z.string().min(1).max(20).describe('The unit it\'s per, e.g. "kg"'),
        to: z.string().min(1).max(20).describe('The unit wanted, e.g. "100 g"'),
        item: z.string().max(200).optional().describe('The item, needed when either unit is what it\'s bought in or what\'s in its pack (e.g. "bag")'),
      }),
      async run({ price: value, per, to, item }) {
        const [cur, u] = await Promise.all([currency(), units()]);
        const product = item ? await ctx.core.resolve.product(item) : null;
        const f = product ? priceFactor(u, product, per, to) : measureFactor(u, per, to);
        const out = value * f;
        const on = product ?? { unit: 'g' };
        return { text: `${price(value, cur)} ${perText(u, on, per)} is ${price(out, cur)} ${perText(u, on, to)}.`, data: { price: out, per: priceKey(u, on, to) } };
      },
    });

    ctx.addTool({
      name: 'get_price', title: 'An item\'s usual price', readOnly: true,
      description: 'The usual price of an item in each unit it can be shown in (per tea bag, per box, per kg…), and what it\'s based on.',
      input: z.object({ item: z.string().min(1).max(200).describe('The item, e.g. "tea bags"') }),
      async run({ item }) {
        const product = await ctx.core.resolve.product(item);
        const [cur, u] = await Promise.all([currency(), units()]);
        const view = priceView(u, product, cur);
        const prices = view.options.filter((o) => o.price !== null).map((o) => `${price(o.price!, cur)} ${o.per}`);
        const lines = [view.usual ? `${product.name}: usually ${prices.join(', ')}${view.basedOn ? ` (from ${view.basedOn})` : ''}.` : `${product.name}: no usual price yet.`];
        const needs = view.options.filter((o) => o.needsSize).map((o) => o.per);
        if (view.usual && needs.length && view.itemUnit) lines.push(`Not ${needs.join(' or ')} until Larder knows what one ${view.itemUnit} weighs (change_item weight).`);
        return { text: lines.join('\n'), data: view };
      },
    });

    // An item now counted in another unit (the 0.10.0 upgrade: 80 tea bags are 4 boxes, 1.6 kg is 1600 g): prices per one follow,
    // and so does a weight still kept here (it was per what it was counted in).
    ctx.on('product.recounted', async (event) => {
      const { productId, from, factor } = event.data as { productId: string; from: string; factor: number };
      const u = await units();
      await ctx.core.products.updateField<unknown>(productId, 'pricing', (cur) => {
        const p = PricingFields.parse(cur ?? {});
        const perOld = p.priceUnit === null || u.find(p.priceUnit)?.key === u.find(from)?.key || p.priceUnit === from;
        return PricingFields.parse({
          ...p,
          ...(perOld && p.usualUnitPrice !== null ? { usualUnitPrice: Math.round((p.usualUnitPrice / factor) * 1_000_000) / 1_000_000, priceUnit: null } : {}),
          ...(p.itemSize ? { itemSize: { ...p.itemSize, amount: Math.round((p.itemSize.amount / factor) * 1000) / 1000 } } : {}),
        });
      }).catch(() => undefined);
      for (const { id, data } of await prices.list()) {
        if (data.productId !== productId) continue;
        await prices.put(id, { ...data, quantity: Math.round(data.quantity * factor * 1000) / 1000, unitPrice: Math.round((data.unitPrice / factor) * 1_000_000) / 1_000_000 });
      }
    });

    // 0.9.0: measures moved out of pricing. A weight or volume is already its size; "1 pack = 5 items" is
    // now "counted in items, comes in packs of 5", which needs a recount the owner chooses, so it's dropped.
    // A price kept for a measure becomes the usual price when there isn't one.
    await (async () => {
      type Old = { unit: string; amount: number; price?: number | null };
      for (const s of await ctx.core.products.list({ status: 'all' }).catch(() => [])) {
        const raw = s.product.fields.pricing as { measures?: Old[] } | undefined;
        if (!raw || !('measures' in raw)) continue;
        const old = (raw.measures ?? []).filter((m) => m && typeof m.unit === 'string' && m.amount > 0);
        const u = await units();
        const measure = (unit: string) => isMeasure(u, unit);
        const counts = old.filter((m) => !measure(m.unit));
        if (counts.length) ctx.log.info(`${s.product.name} had "1 ${s.product.unit} = ${counts.map((m) => `${m.amount} ${m.unit}`).join(' = ')}" on its price card: say what it comes in on its Edit page instead.`);
        await ctx.core.products.updateField<unknown>(s.product.id, 'pricing', (cur) => {
          const p = PricingFields.parse(cur ?? {});
          const priced = old.find((m) => typeof m.price === 'number');
          if (p.usualUnitPrice !== null || !priced) return p;
          // A weight's price stays per that weight; "£1.20 an item" with 5 to a pack is £6 a pack.
          return measure(priced.unit)
            ? { ...p, usualUnitPrice: priced.price!, priceUnit: priceKey(u, s.product, priced.unit) }
            : { ...p, usualUnitPrice: Math.round(priced.price! * priced.amount * 1_000_000) / 1_000_000, priceUnit: null };
        }).catch(() => undefined);
      }
    })();

    // 0.10.0: what one weighs is the item's Weight, so recipes, usage in grams and prices all use it.
    // The move clears this module's copy, so it happens once. It finishes before the core's upgrade
    // (which runs once the modules have started), so a pack turned round there turns this weight too.
    await (async () => {
      for (const s of await ctx.core.products.list({ status: 'all' }).catch(() => [])) {
        const kept = pricing(s.product).itemSize;
        if (!kept) continue;
        // Not for something bought loose, and never over a Weight the item has: the product service refuses those.
        if (!s.product.weight) await ctx.core.products.update(s.product.id, { weight: kept }).catch(() => undefined);
        await ctx.core.products.updateField<unknown>(s.product.id, 'pricing', (cur) => PricingFields.parse({ ...PricingFields.parse(cur ?? {}), itemSize: null })).catch(() => undefined);
      }
    })();

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
            return p.usualUnitPrice !== null ? p : { ...p, usualUnitPrice: Math.round(rec.unitPrice * 1_000_000) / 1_000_000, priceUnit: null, basedOn: 'First price paid', updatedAt: event.at };
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
    await set('Baby spinach', { usualUnitPrice: 1.1, basedOn: '200 g bag for £1.10 at Aldi' });
    await set('Mature cheddar', { usualUnitPrice: 0.0095, basedOn: '400 g for £3.80 at Aldi' });
  },
});
