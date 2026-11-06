/**
 * Purchase history: every time something is bought, what, how many, what it
 * cost, where, and the evidence (a receipt's photo, or the online order).
 * Recorded from the core's events, so it works however the purchase came in:
 * ticked off a shopping list, added from a receipt, an online order arriving,
 * or added with a price on an item's page. Kept for reports on spending.
 */
import { z } from 'zod';
import { Id, IsoDate, NotFoundError, PurchaseEvidence, ValidationError, amount, defineModule, localDate, newId, type ModuleContext, type Shop } from '@larder/core';

export const PurchaseRecord = z.object({
  id: z.string(),
  productId: z.string(),
  /** The item's name when it was bought (it may be renamed or removed later). */
  name: z.string(),
  /** How much, in the item's own unit. */
  quantity: z.number(),
  unit: z.string(),
  /** What the line cost, in the household currency. Null when nobody said. */
  price: z.number().nullable(),
  currency: z.string(),
  shopId: z.string().nullable(),
  /** The shop's name when it was bought. */
  shop: z.string().nullable(),
  /** How it came in: ticked off at a shop (or added with a price), from a receipt, or an order that arrived. */
  how: z.enum(['shop', 'receipt', 'order']),
  /** The day it was bought: the receipt's date, or the day it arrived. */
  on: IsoDate,
  /** When it was recorded. */
  at: z.string(),
  evidence: PurchaseEvidence,
}).meta({ id: 'PurchaseRecord' });
export type PurchaseRecord = z.infer<typeof PurchaseRecord>;

const Total = z.object({ total: z.number(), count: z.number() });
export const SpendingReport = z.object({
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  currency: z.string(),
  /** What the purchases with a price cost in all. */
  total: z.number(),
  count: z.number(),
  /** Purchases with no price, so not in the totals. */
  unpriced: z.number(),
  byShop: z.array(Total.extend({ shop: z.string() })),
  byItem: z.array(Total.extend({ productId: z.string(), name: z.string(), quantity: z.number(), unit: z.string() })),
  byMonth: z.array(Total.extend({ month: z.string() })),
}).meta({ id: 'SpendingReport' });
export type SpendingReport = z.infer<typeof SpendingReport>;

const Filter = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  productId: Id.optional(),
  shopId: Id.optional(),
});
type Filter = z.infer<typeof Filter>;

const PurchasePatch = z.object({
  price: z.number().min(0).nullable().optional(),
  quantity: z.number().positive().optional(),
  shopId: Id.nullable().optional(),
  on: IsoDate.optional(),
  /** Only the fields given change, e.g. `{ receiptFileId }` to add the receipt's photo later. */
  evidence: PurchaseEvidence.partial().optional(),
});

const pence = (n: number) => Math.round(n * 100) / 100;
const SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' };
const money = (n: number, currency: string) => `${SYMBOLS[currency] ?? `${currency} `}${n.toFixed(2)}`;

/** Newest first. */
const newest = (a: PurchaseRecord, b: PurchaseRecord) => b.on.localeCompare(a.on) || b.at.localeCompare(a.at);

export function matches(r: PurchaseRecord, f: Filter): boolean {
  return (!f.from || r.on >= f.from) && (!f.to || r.on <= f.to) && (!f.productId || r.productId === f.productId) && (!f.shopId || r.shopId === f.shopId);
}

export function report(records: PurchaseRecord[], f: Filter, currency: string): SpendingReport {
  const rows = records.filter((r) => matches(r, f));
  const priced = rows.filter((r) => r.price !== null);
  const group = <K extends string>(key: (r: PurchaseRecord) => K) => {
    const out = new Map<K, { total: number; count: number; rows: PurchaseRecord[] }>();
    for (const r of rows) {
      const g = out.get(key(r)) ?? { total: 0, count: 0, rows: [] };
      g.total = pence(g.total + (r.price ?? 0));
      g.count++;
      g.rows.push(r);
      out.set(key(r), g);
    }
    return [...out.entries()];
  };
  return {
    from: f.from ?? null,
    to: f.to ?? null,
    currency,
    total: pence(priced.reduce((n, r) => n + r.price!, 0)),
    count: rows.length,
    unpriced: rows.length - priced.length,
    byShop: group((r) => r.shop ?? 'No shop').map(([shop, g]) => ({ shop, total: g.total, count: g.count })).sort((a, b) => b.total - a.total || b.count - a.count),
    byItem: group((r) => r.productId)
      .map(([productId, g]) => ({ productId, name: g.rows[0]!.name, unit: g.rows[0]!.unit, quantity: Math.round(g.rows.reduce((n, r) => n + r.quantity, 0) * 1000) / 1000, total: g.total, count: g.count }))
      .sort((a, b) => b.total - a.total || b.count - a.count),
    byMonth: group((r) => r.on.slice(0, 7)).map(([month, g]) => ({ month, total: g.total, count: g.count })).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/** "6 Nov 2026: 2 packs, £3.20 at Aldi (receipt photo)" */
export function line(r: PurchaseRecord, withName = false): string {
  const what = withName ? `${amount(r.quantity, r.unit)}${r.unit === 'each' ? ' ×' : ' of'} ${r.name}` : amount(r.quantity, r.unit);
  const where = r.shop ? ` at ${r.shop}` : r.how === 'order' && r.evidence.source ? ` from ${r.evidence.source}` : '';
  const proof = [
    r.evidence.receiptFileId ? 'receipt photo' : r.how === 'receipt' ? 'from a receipt' : null,
    r.how === 'order' ? `order${r.evidence.reference ? ` ${r.evidence.reference}` : ''}${r.evidence.orderedOn ? `, ordered ${r.evidence.orderedOn}` : ''}` : null,
    r.evidence.note,
  ].filter(Boolean);
  return `${r.on}: ${what}, ${r.price === null ? 'no price' : money(r.price, r.currency)}${where}${proof.length ? ` (${proof.join('; ')})` : ''}`;
}

const DateInput = IsoDate.optional();

export default defineModule({
  id: 'purchases',
  name: 'Purchase history',
  description: 'Keeps every purchase: what, how many, the price, the shop, and the receipt\'s photo or the online order. Reports what was spent.',
  version: '1.0.0',
  setup(ctx) {
    const store = ctx.collection<PurchaseRecord>('purchases');
    const all = async () => (await store.list()).map((d) => PurchaseRecord.parse(d.data)).sort(newest);
    const currency = async () => (await ctx.core.settings.get()).currency;
    /** The household's day when something happened (an event's time). */
    const dayOf = async (at: string) => localDate(new Date(at), (await ctx.core.settings.get()).timeZone);

    async function record(input: Omit<PurchaseRecord, 'id' | 'name' | 'unit' | 'currency' | 'at'> & { at?: string }) {
      const product = await ctx.core.products.summary(input.productId).catch(() => null);
      if (!product) return;
      const id = newId();
      const rec = PurchaseRecord.parse({ ...input, id, name: product.product.name, unit: product.product.unit, currency: await currency(), at: input.at ?? ctx.core.now() });
      await store.put(id, rec);
      return rec;
    }

    /** The shop an order came from: "Tesco delivery" is Tesco. */
    const shopFor = (shops: Shop[], source: string | null) => {
      const s = source?.trim().toLowerCase();
      return s ? (shops.find((x) => s === x.name.toLowerCase() || s.startsWith(`${x.name.toLowerCase()} `)) ?? null) : null;
    };

    // Ticked off at a shop, added from a receipt, or added with a price.
    ctx.on('shopping.purchased', async (event) => {
      const data = event.data as { shopId: string | null; items: Array<{ productId: string; quantity: number; price?: number }>; evidence?: unknown };
      const evidence = PurchaseEvidence.parse(data.evidence ?? {});
      const shop = data.shopId ? ((await ctx.core.shops.list()).find((s) => s.id === data.shopId) ?? null) : null;
      const how = evidence.receiptFileId || evidence.source?.toLowerCase() === 'receipt' ? 'receipt' : 'shop';
      for (const item of data.items) {
        await record({ productId: item.productId, quantity: item.quantity, price: item.price ?? null, shopId: shop?.id ?? null, shop: shop?.name ?? null, how, on: evidence.boughtOn ?? (await dayOf(event.at)), evidence, at: event.at });
      }
    });

    // An online order (or any delivery) arrived.
    ctx.on('stock.arrived', async (event) => {
      const data = event.data as { items: Array<{ productId: string; quantity: number; source: string | null; reference: string | null; orderedOn: string | null; price: number | null }> };
      const shops = await ctx.core.shops.list();
      for (const item of data.items) {
        const shop = shopFor(shops, item.source);
        await record({
          productId: item.productId, quantity: item.quantity, price: item.price, shopId: shop?.id ?? null, shop: shop?.name ?? null, how: 'order', on: await dayOf(event.at), at: event.at,
          evidence: PurchaseEvidence.parse({ source: item.source, reference: item.reference, orderedOn: item.orderedOn }),
        });
      }
    });

    async function change(id: string, patch: z.infer<typeof PurchasePatch>): Promise<PurchaseRecord> {
      const cur = await store.get(id);
      if (!cur) throw new NotFoundError('Purchase', id);
      const shop = patch.shopId === undefined ? undefined : patch.shopId === null ? null : ((await ctx.core.shops.list()).find((s) => s.id === patch.shopId) ?? null);
      if (patch.shopId && !shop) throw new NotFoundError('Shop', patch.shopId);
      const next = PurchaseRecord.parse({
        ...cur,
        ...(patch.price !== undefined ? { price: patch.price === null ? null : pence(patch.price) } : {}),
        ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
        ...(shop !== undefined ? { shopId: shop?.id ?? null, shop: shop?.name ?? null } : {}),
        ...(patch.on ? { on: patch.on } : {}),
        evidence: { ...cur.evidence, ...(patch.evidence ?? {}) },
      });
      await store.put(id, next);
      return next;
    }

    ctx.addRoute({
      method: 'GET', path: '/item/:productId', summary: 'One item\'s purchases, newest first',
      params: z.object({ productId: Id }), response: z.array(PurchaseRecord),
      handler: async ({ params }) => (await all()).filter((r) => r.productId === (params as { productId: string }).productId),
    });

    ctx.addRoute({
      method: 'GET', path: '/list', summary: 'Purchases, newest first, optionally between two dates, for one item or at one shop',
      query: Filter, response: z.array(PurchaseRecord),
      handler: async ({ query }) => (await all()).filter((r) => matches(r, Filter.parse(query ?? {}))),
    });

    ctx.addRoute({
      method: 'GET', path: '/report', summary: 'What was spent: in all, by shop, by item and by month',
      description: 'Only purchases with a price count towards the totals; `unpriced` says how many had none.',
      query: Filter, response: SpendingReport,
      handler: async ({ query }) => report(await all(), Filter.parse(query ?? {}), await currency()),
    });

    ctx.addRoute({
      method: 'PATCH', path: '/:id', summary: 'Correct a purchase: its price, how many, the shop, the day, or add the receipt\'s photo',
      params: z.object({ id: z.string().min(1).max(100) }), body: PurchasePatch, response: PurchaseRecord,
      handler: async ({ params, body }) => change((params as { id: string }).id, PurchasePatch.parse(body)),
    });

    ctx.addRoute({
      method: 'DELETE', path: '/:id', summary: 'Remove a purchase recorded by mistake (stock is not changed)',
      params: z.object({ id: z.string().min(1).max(100) }), response: z.object({ removed: z.boolean() }),
      async handler({ params }) {
        const id = (params as { id: string }).id;
        if (!(await store.get(id))) throw new NotFoundError('Purchase', id);
        await store.remove(id);
        return { removed: true };
      },
    });

    ctx.addSensor({
      id: 'purchases_this_month', name: 'Spent this month', icon: 'mdi:cash-register',
      description: 'What purchases with a price have cost since the start of the month, with the shops.',
      async read() {
        const today = ctx.core.today();
        const r = report(await all(), { from: `${today.slice(0, 8)}01`, to: today }, await currency());
        return { state: r.total, attributes: { currency: r.currency, purchases: r.count, unpriced: r.unpriced, shops: Object.fromEntries(r.byShop.slice(0, 10).map((s) => [s.shop, s.total])) } };
      },
    });

    addTools(ctx, { all, change, currency, remove: (id) => store.remove(id) });
  },

  // A few purchases for the example household, so the history and report have something to show.
  async demo(ctx, seed) {
    const store = ctx.collection<PurchaseRecord>('purchases');
    const shops = await ctx.core.shops.list();
    const today = ctx.core.today();
    const day = (n: number) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().slice(0, 10);
    };
    const { currency } = await ctx.core.settings.get();
    const add = async (name: string, quantity: number, price: number | null, shopName: string | null, ago: number, how: PurchaseRecord['how'], evidence: Partial<PurchaseEvidence> = {}) => {
      const productId = seed.products[name];
      const s = productId ? await ctx.core.products.summary(productId).catch(() => null) : null;
      if (!s) return;
      const shop = shopName ? (shops.find((x) => x.name === shopName) ?? null) : null;
      const id = newId();
      await store.put(id, PurchaseRecord.parse({ id, productId: s.product.id, name: s.product.name, quantity, unit: s.product.unit, price, currency, shopId: shop?.id ?? null, shop: shop?.name ?? null, how, on: day(ago), at: `${day(ago)}T10:00:00.000Z`, evidence: PurchaseEvidence.parse(evidence) }));
    };
    await add('Toilet roll', 9, 3.25, 'Tesco', 24, 'shop');
    await add('Baked beans', 4, 2.2, 'Aldi', 12, 'receipt', { source: 'Receipt', note: 'Read by Claude' });
    await add('Semi-skimmed milk', 2, 1.3, 'Aldi', 12, 'receipt', { source: 'Receipt', note: 'Read by Claude' });
    await add('Oat milk', 3, 4.5, 'Tesco', 9, 'order', { source: 'Tesco delivery', reference: 'TESCO-58213', orderedOn: day(11) });
    await add('Dog food', 15, 52.99, 'Pets at Home', 30, 'shop');
    await add('Water filter cartridges', 3, 12.5, null, 40, 'order', { source: 'Amazon', reference: '204-118', orderedOn: day(42) });
  },
});

function addTools(ctx: ModuleContext, deps: { all: () => Promise<PurchaseRecord[]>; change: (id: string, patch: z.infer<typeof PurchasePatch>) => Promise<PurchaseRecord>; currency: () => Promise<string>; remove: (id: string) => Promise<void> }) {
  const { all, change, currency, remove } = deps;
  const Item = z.string().min(1).max(200).describe('The item, by name or alias, e.g. "butter"');

  /** An item's latest purchase, or its purchase on a day. */
  async function pick(item: string, on?: string): Promise<PurchaseRecord> {
    const product = await ctx.core.resolve.product(item);
    const found = (await all()).find((r) => r.productId === product.id && (!on || r.on === on));
    if (!found) throw new ValidationError(`There's no purchase of ${product.name}${on ? ` on ${on}` : ''} in the history.`);
    return found;
  }

  ctx.addTool({
    name: 'purchase_history', title: 'Purchase history', readOnly: true,
    description: 'What was bought, newest first: how many, the price, the shop and the evidence (a receipt\'s photo, or the online order). For one item ("what did we pay for butter last time?"), one shop, or between two dates.',
    input: z.object({
      item: Item.optional(),
      shop: z.string().max(80).optional().describe('Only purchases at this shop'),
      from: DateInput.describe('From this day (YYYY-MM-DD)'),
      to: DateInput.describe('Up to this day (YYYY-MM-DD)'),
      limit: z.number().int().min(1).max(100).default(15).describe('Most to list (default 15)'),
    }),
    async run({ item, shop, from, to, limit }) {
      const productId = item ? (await ctx.core.resolve.product(item)).id : undefined;
      const shopId = shop ? (await ctx.core.resolve.shop(shop)).id : undefined;
      const rows = (await all()).filter((r) => matches(r, { productId, shopId, from, to }));
      if (!rows.length) return { text: 'No purchases like that in the history.', data: { purchases: [] } };
      const r = report(rows, {}, await currency());
      const shown = rows.slice(0, limit);
      const more = rows.length > shown.length ? `\n…and ${rows.length - shown.length} more.` : '';
      return { text: `${shown.map((x) => `- ${line(x, !productId)}`).join('\n')}${more}\nIn all: ${money(r.total, r.currency)} on ${r.count} purchase${r.count === 1 ? '' : 's'}${r.unpriced ? ` (${r.unpriced} without a price)` : ''}.`, data: { purchases: shown, total: r.total } };
    },
  });

  ctx.addTool({
    name: 'spending', title: 'What was spent', readOnly: true,
    description: 'Totals of what was spent between two dates (default this month): in all, by shop, on which items, and by month. Only purchases with a price count.',
    input: z.object({
      from: DateInput.describe('From this day (YYYY-MM-DD). Default: the 1st of this month'),
      to: DateInput.describe('Up to this day (YYYY-MM-DD). Default: today'),
      shop: z.string().max(80).optional().describe('Only this shop'),
      item: Item.optional(),
    }),
    async run({ from, to, shop, item }) {
      const today = ctx.core.today();
      const f = { from: from ?? `${today.slice(0, 8)}01`, to: to ?? today, shopId: shop ? (await ctx.core.resolve.shop(shop)).id : undefined, productId: item ? (await ctx.core.resolve.product(item)).id : undefined };
      const r = report(await all(), f, await currency());
      if (!r.count) return { text: `No purchases between ${f.from} and ${f.to}.`, data: r };
      const top = (xs: Array<[string, number]>) => xs.slice(0, 8).map(([label, total]) => `${label} ${money(total, r.currency)}`).join(', ');
      const text = [
        `${money(r.total, r.currency)} on ${r.count} purchase${r.count === 1 ? '' : 's'} between ${f.from} and ${f.to}${r.unpriced ? ` (${r.unpriced} without a price, not counted)` : ''}.`,
        r.byShop.length > 1 ? `By shop: ${top(r.byShop.map((x) => [x.shop, x.total]))}.` : '',
        `Most spent on: ${top(r.byItem.map((x) => [x.name, x.total]))}.`,
        r.byMonth.length > 1 ? `By month: ${top(r.byMonth.map((x) => [x.month, x.total]))}.` : '',
      ].filter(Boolean).join('\n');
      return { text, data: r };
    },
  });

  ctx.addTool({
    name: 'change_purchase', title: 'Correct a purchase', destructive: true,
    description: 'Correct an item\'s latest purchase in the history (or the one on a day): its price, how many, the shop or a note. Stock isn\'t changed (use correct_stock for that).',
    input: z.object({
      item: Item,
      on: DateInput.describe('The day it was bought, if not the latest (YYYY-MM-DD)'),
      price: z.number().min(0).nullable().optional().describe('What the line cost, e.g. 3.2; null if not known'),
      quantity: z.number().positive().optional().describe('How many were bought, in the item\'s own unit'),
      shop: z.string().max(80).nullable().optional().describe('The shop; null for none'),
      note: z.string().max(200).optional(),
    }),
    async run({ item, on, price, quantity, shop, note }) {
      const r = await pick(item, on);
      const shopId = shop === undefined ? undefined : shop === null ? null : (await ctx.core.resolve.shop(shop)).id;
      const next = await change(r.id, { price, quantity, shopId, ...(note !== undefined ? { evidence: { note } } : {}) });
      return { text: `Changed: ${line(next, true)}.`, data: next };
    },
  });

  ctx.addTool({
    name: 'remove_purchase', title: 'Remove a purchase', destructive: true,
    description: 'Take a purchase recorded by mistake out of the history (an item\'s latest, or the one on a day). Stock isn\'t changed.',
    input: z.object({ item: Item, on: DateInput.describe('The day it was bought, if not the latest (YYYY-MM-DD)') }),
    async run({ item, on }) {
      const r = await pick(item, on);
      await remove(r.id);
      return { text: `Removed from the history: ${line(r, true)}.`, data: { removed: r.id } };
    },
  });
}
