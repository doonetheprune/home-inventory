/**
 * Receipts: the AI reads a photo of a till receipt (or an online order) and
 * matches each line to an item the household already has. Nothing new is made
 * from a receipt: a line that isn't an item in Larder is shown and left out.
 * What's confirmed is added to stock in one go with the prices paid (the
 * pricing module keeps those), and the shop's name for each item is
 * remembered, so the next receipt from that shop matches without guessing.
 */
import { z } from 'zod';
import { LarderError, type ModuleContext, type Product } from '@larder/core';
import type { Source, Task } from './providers';

/** What the AI read from the receipt. */
export const ReceiptReading = z.object({
  readable: z.boolean().describe('False if the photo is not a receipt or order you can read'),
  shop: z.string().nullable().describe('The shop, e.g. "Tesco"'),
  date: z.string().nullable().describe('The date bought, as YYYY-MM-DD'),
  total: z.number().nullable().describe('The total paid'),
  lines: z.array(z.object({
    text: z.string().describe('The line as printed'),
    count: z.number().describe('How many were bought'),
    price: z.number().nullable().describe('What was paid for the line'),
    item: z.number().nullable().describe('The number of the household item it is, or null if none is'),
    quantity: z.number().nullable().describe('How much of that item\'s unit it adds in all'),
    sure: z.boolean().describe('True if it is certainly that item'),
  })),
});
export type ReceiptReading = z.infer<typeof ReceiptReading>;

const GEMINI_LINE = {
  type: 'OBJECT',
  properties: {
    text: { type: 'STRING' },
    count: { type: 'NUMBER' },
    price: { type: 'NUMBER', nullable: true },
    item: { type: 'INTEGER', nullable: true },
    quantity: { type: 'NUMBER', nullable: true },
    sure: { type: 'BOOLEAN' },
  },
  required: ['text', 'count', 'price', 'item', 'quantity', 'sure'],
};
const GEMINI_RECEIPT = {
  type: 'OBJECT',
  properties: {
    readable: { type: 'BOOLEAN' },
    shop: { type: 'STRING', nullable: true },
    date: { type: 'STRING', nullable: true },
    total: { type: 'NUMBER', nullable: true },
    lines: { type: 'ARRAY', items: GEMINI_LINE },
  },
  required: ['readable', 'shop', 'date', 'total', 'lines'],
};

/** An item the household has, as the AI is shown it. */
export interface Known { id: string; name: string; unit: string; aliases: string[]; brands: string[] }

/** How a shop named an item on an earlier receipt (`ai:receipt-names`). */
export interface Learnt {
  shopId: string | null;
  /** The line as printed, and squashed for matching ("hnz bkd bnz"). */
  text: string;
  said: string;
  productId: string;
  /** How much of the item's unit one of that line adds, e.g. 9 rolls for a 9-pack. */
  each: number;
  at: string;
}

/** Enough for any household; a longer list is cut (the rest can still be matched by hand). */
export const MAX_ITEMS = 2000;
const MAX_LEARNT = 400;
export const MAX_LINES = 200;

/** A line as words: "HNZ BKD-BNZ 4X415G" is "hnz bkd bnz 4x415g". */
export const saidAs = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
const nameKey = (shopId: string | null, said: string) => `${shopId ?? 'any'}:${said.replace(/ /g, '-')}`;
const tidyNum = (n: number) => Math.round(n * 1000) / 1000;
const pence = (n: number) => Math.round(n * 100) / 100;
const cap = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const quote = (s: string) => JSON.stringify(s);

/** The household's items, numbered for the AI, and the lines it matched before (shared by receipts and order emails). */
export function householdItems(known: Known[], learnt: Learnt[], shopName: (id: string | null) => string | null): string[] {
  const number = new Map(known.map((k, i) => [k.id, i + 1]));
  const items = known.map((k, i) => {
    const more = [k.aliases.length ? `also ${k.aliases.slice(0, 4).join(', ')}` : '', k.brands.length ? `brands ${k.brands.slice(0, 3).map((b) => b.slice(0, 60)).join('; ')}` : ''].filter(Boolean);
    return `${i + 1}. ${k.name} (counted in ${k.unit}${more.length ? `; ${more.join('; ')}` : ''})`;
  });
  const before = learnt
    .filter((l) => number.has(l.productId))
    .map((l) => {
      const shop = shopName(l.shopId);
      const k = known[number.get(l.productId)! - 1]!;
      return `${quote(l.text)}${shop ? ` at ${shop}` : ''} is item ${number.get(l.productId)}, ${l.each} ${k.unit} for each one bought`;
    });
  return [
    'The household\'s items:',
    ...(items.length ? items : ['(none yet)']),
    ...(before.length ? ['', 'Lines this household matched before (match the same text the same way):', ...before] : []),
  ];
}

/** The request that goes with the photo: what to read, and the household's items to match against. */
export function receiptPrompt(known: Known[], learnt: Learnt[], shopName: (id: string | null) => string | null): string {
  return [
    'This is a photo of a till receipt or an online order. List what was bought, and match each line to one of the household\'s items listed below. Fill in each field:',
    '- shop: the shop, e.g. "Tesco", "Sainsbury\'s", "Aldi", "Screwfix". Null if it is not shown.',
    '- date: the date bought, as YYYY-MM-DD. Null if it is not shown.',
    '- total: the total paid, as a number (12.5 for £12.50). Null if it is not shown.',
    '- lines: one for each thing bought, in order. Leave out totals, subtotals, VAT, payment, change, carrier bags, coupons, points and savings lines. A thing printed on several lines is one line with its count. For each line:',
    '  - text: the line as printed, e.g. "HNZ BKD BNZ 4X415G".',
    '  - count: how many were bought, e.g. 2 for "2 @ £0.85" or a line printed twice. 1 if it does not say, and 1 for something weighed.',
    '  - price: what was paid for the line in all, as a number, after any discount printed straight under it. Null if it is not shown.',
    '  - item: the number of the household\'s item it is. Receipts shorten names ("HNZ" is Heinz, "SEMI SKMD" is semi-skimmed milk), so match on what it is, not the exact words. Another brand or size of the same thing is still that item. Null if none of the items is it: never pick the nearest one just to have one.',
    '  - quantity: how much of that item\'s unit the line adds in all. Two 9-roll packs of an item counted in rolls is 18; 0.85 kg of something counted in kg is 0.85. Null if item is null.',
    '  - sure: true if it is certainly that item, false if it might be something else.',
    '- readable: false if the photo is not a receipt or order, or cannot be read. Then give what you can.',
    '',
    ...householdItems(known, learnt, shopName),
  ].join('\n');
}

export const receiptTask = (prompt: string): Task<ReceiptReading> => ({ prompt, schema: ReceiptReading, gemini: GEMINI_RECEIPT, effort: 'medium' });

const ProviderName = z.enum(['claude', 'gemini']);

const ItemRef = z.object({ id: z.string(), name: z.string(), unit: z.string() });
export const ReceiptLine = z.object({
  /** The line as printed. */
  text: z.string(),
  /** How many were bought on that line. */
  count: z.number(),
  /** Paid for the whole line, or null when the receipt doesn't say. */
  price: z.number().nullable(),
  /** The household's item, or null when none is. */
  item: ItemRef.nullable(),
  /** How much of the item's unit it adds (e.g. 18 rolls for two 9-packs). */
  quantity: z.number(),
  /** learnt: matched the same way before at this shop. sure / guess: the AI's match. none: not an item in Larder. */
  match: z.enum(['learnt', 'sure', 'guess', 'none']),
});

export const Receipt = z.object({
  readable: z.boolean(),
  /** `id` is null when Larder doesn't have the shop; `preset` when it's a known UK shop. */
  shop: z.object({ name: z.string(), id: z.string().nullable(), preset: z.boolean() }).nullable(),
  date: z.string().nullable(),
  total: z.number().nullable(),
  lines: z.array(ReceiptLine),
  /** When a receipt with the same shop, date and total was added before (adding it again counts it twice). */
  addedBefore: z.string().nullable(),
  /** Send back with the lines to add, so Larder can say if this receipt comes round again. */
  receiptKey: z.string().nullable(),
  provider: ProviderName,
  model: z.string(),
  skipped: z.array(z.object({ provider: ProviderName, message: z.string() })),
});
export type Receipt = z.infer<typeof Receipt>;

const AddLine = z.object({
  productId: z.string().min(1),
  /** How much of the item's unit. */
  quantity: z.number().positive().max(99999),
  /** Paid for the line. */
  price: z.number().min(0).max(100000).nullable().default(null),
  /** The line as printed, to remember how this shop names the item. */
  text: z.string().trim().max(200).default(''),
  count: z.number().positive().max(999).default(1),
});
const AddReceipt = z.object({
  shopId: z.string().nullable().default(null),
  receiptKey: z.string().max(200).nullable().default(null),
  lines: z.array(AddLine).min(1).max(MAX_LINES),
  /** The photo of the receipt, uploaded to Larder's files, kept with the purchases as evidence. */
  receiptFileId: z.string().min(1).max(100).nullable().default(null),
  /** The date on the receipt (YYYY-MM-DD). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** Who read it, kept with the purchases: "Claude", or an assistant. */
  readBy: z.string().max(60).nullable().default(null),
});
type AddReceipt = z.output<typeof AddReceipt>;

export interface Asked<T> { answer: T; sources: Source[]; provider: 'claude' | 'gemini'; model: string; skipped: Array<{ provider: 'claude' | 'gemini'; message: string }> }

export interface ReceiptDeps {
  /** Asks the AIs in the household's order about a photo (base64). */
  ask<T>(image: string, task: () => Promise<Task<T>>): Promise<Asked<T>>;
  /** The household's shop with this name, or a known UK shop to add. */
  shopFor(name: string | null): Promise<Receipt['shop']>;
}

/**
 * What the household has and how its shops name things: the items the AI is shown, the
 * lines matched before (`ai:receipt-names`), and remembering a new one. Receipts and order emails share it.
 */
export function itemMemory(ctx: ModuleContext) {
  const names = ctx.collection<Learnt>('receipt-names');
  return {
    async learntNames(): Promise<Learnt[]> {
      return (await names.list()).map((x) => x.data).sort((a, b) => b.at.localeCompare(a.at));
    },
    /** The household's items (not the wish list), with brand names, and what was matched before for them. */
    async load(): Promise<{ known: Known[]; learnt: Learnt[] }> {
      const [items, brands] = await Promise.all([ctx.core.products.list(), ctx.core.products.brandNames()]);
      const known = items.slice(0, MAX_ITEMS).map(({ product: p }) => ({ id: p.id, name: p.name, unit: p.unit, aliases: p.aliases, brands: brands[p.id] ?? [] }));
      const ids = new Set(known.map((k) => k.id));
      const learnt = (await this.learntNames()).filter((l) => ids.has(l.productId)).slice(0, MAX_LEARNT);
      return { known, learnt };
    },
    /** The item is now counted in what's inside (a box became 80 tea bags): "1 box" on a receipt is 80 now. */
    async recounted(productId: string, factor: number): Promise<void> {
      for (const { id, data } of await names.list()) {
        if (data.productId === productId) await names.put(id, { ...data, each: tidyNum(data.each * factor) });
      }
    },
    async remember(shopId: string | null, text: string, productId: string, each: number): Promise<void> {
      const said = saidAs(text);
      if (!said) return;
      await names.put(nameKey(shopId, said), { shopId, text: cap(text, 120), said, productId, each: tidyNum(each), at: ctx.core.now() });
    },
  };
}

/** One line the AI read, before it's checked against what Larder knows. */
export interface ReadLine { text: string; count: number; item: number | null; quantity: number | null; sure: boolean }
export interface Matched { text: string; count: number; item: { id: string; name: string; unit: string } | null; quantity: number; match: 'learnt' | 'sure' | 'guess' | 'none' }

/**
 * Turns the AI's lines into items: what this shop called it before wins over the AI's guess;
 * failing that, the same words anywhere, if they always meant one item. Then the AI's numbered item.
 */
export function matcher(known: Known[], learnt: Learnt[], shopId: string | null) {
  const byId = new Map(known.map((k) => [k.id, k]));
  const recall = (said: string): Learnt | null => {
    if (!said) return null;
    const here = learnt.find((l) => l.said === said && l.shopId === shopId);
    if (here) return here;
    const anywhere = learnt.filter((l) => l.said === said);
    return anywhere.length && anywhere.every((l) => l.productId === anywhere[0]!.productId) ? anywhere[0]! : null;
  };
  const ref = (k: Known) => ({ id: k.id, name: k.name, unit: k.unit });
  return (l: ReadLine): Matched => {
    const text = cap(l.text, 120) || '(unreadable line)';
    const count = Number.isFinite(l.count) && l.count > 0 ? Math.min(999, tidyNum(l.count)) : 1;
    const before = recall(saidAs(text));
    if (before && byId.has(before.productId)) {
      return { text, count, item: ref(byId.get(before.productId)!), quantity: Math.min(99999, tidyNum(count * before.each)), match: 'learnt' };
    }
    const n = typeof l.item === 'number' && Number.isFinite(l.item) ? Math.round(l.item) : 0;
    const k = n >= 1 && n <= known.length ? known[n - 1]! : null;
    if (!k) return { text, count, item: null, quantity: count, match: 'none' };
    const quantity = typeof l.quantity === 'number' && Number.isFinite(l.quantity) && l.quantity > 0 ? Math.min(99999, tidyNum(l.quantity)) : count;
    return { text, count, item: ref(k), quantity, match: l.sure ? 'sure' : 'guess' };
  };
}

export function receipts(ctx: ModuleContext, deps: ReceiptDeps) {
  const memory = itemMemory(ctx);
  const seen = ctx.collection<{ at: string; lines: number }>('receipts');

  ctx.addRoute({
    method: 'POST',
    path: '/receipt',
    summary: 'Read a photo of a receipt and match its lines to the household\'s items (nothing is added)',
    description: 'Send a photo as base64, as for /identify. Each line comes back matched to an item Larder has, or with none: receipts are often vague, and nothing new is made from one. Lines matched the same way before at that shop are matched without the AI\'s guess. Send the lines to keep to /receipt/add.',
    body: z.object({ image: z.string().min(100).max(1_900_000) }),
    response: Receipt,
    async handler({ body }) {
      const shops = await ctx.core.shops.list();
      const shopName = (id: string | null) => (id ? shops.find((s) => s.id === id)?.name ?? null : null);
      let known: Known[] = [];
      let learnt: Learnt[] = [];
      const asked = await deps.ask(body.image, async () => {
        ({ known, learnt } = await memory.load());
        return receiptTask(receiptPrompt(known, learnt, shopName));
      });
      const r = asked.answer;
      const shop = await deps.shopFor(cap(r.shop, 60) || null);
      const match = matcher(known, learnt, shop?.id ?? null);
      const lines = r.lines.slice(0, MAX_LINES).map((l): z.infer<typeof ReceiptLine> => {
        const price = typeof l.price === 'number' && Number.isFinite(l.price) && l.price >= 0 ? pence(l.price) : null;
        return { ...match(l), price };
      });

      const date = r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date.trim()) && !Number.isNaN(Date.parse(r.date.trim())) ? r.date.trim() : null;
      const total = typeof r.total === 'number' && Number.isFinite(r.total) && r.total >= 0 ? pence(r.total) : null;
      // The same shop, date and total is almost certainly the same receipt.
      const receiptKey = shop && date && total !== null ? `${saidAs(shop.name).replace(/ /g, '-')}:${date}:${total.toFixed(2)}` : null;
      const addedBefore = receiptKey ? (await seen.get(receiptKey))?.at ?? null : null;
      return {
        readable: r.readable, shop, date, total, lines, addedBefore, receiptKey,
        provider: asked.provider, model: asked.model, skipped: asked.skipped,
      };
    },
  });

  /** Adds the lines to stock in one go with their prices, and remembers how this shop names each item. */
  async function add(input: AddReceipt): Promise<{ added: number; message: string }> {
    // One addition per item: two lines for the same thing are added together, with their prices when both have one.
    const byItem = new Map<string, { quantity: number; price: number | null }>();
    for (const l of input.lines) {
      const cur = byItem.get(l.productId);
      byItem.set(l.productId, cur
        ? { quantity: tidyNum(cur.quantity + l.quantity), price: cur.price !== null && l.price !== null ? pence(cur.price + l.price) : null }
        : { quantity: tidyNum(l.quantity), price: l.price });
    }
    const added = await ctx.core.shopping.purchase({
      shopId: input.shopId,
      items: [...byItem].map(([productId, x]) => ({ productId, quantity: x.quantity, ...(x.price !== null ? { price: x.price } : {}) })),
      evidence: { source: 'Receipt', receiptFileId: input.receiptFileId, boughtOn: input.date, note: input.readBy ? `Read by ${input.readBy}` : null },
    });
    for (const l of input.lines) await memory.remember(input.shopId, l.text, l.productId, l.quantity / l.count);
    if (input.receiptKey) await seen.put(input.receiptKey, { at: ctx.core.now(), lines: input.lines.length });
    const shop = input.shopId ? (await ctx.core.shops.list()).find((s) => s.id === input.shopId)?.name : null;
    const what = added.length === 1 ? added[0]!.product.name : `${added.length} things`;
    ctx.publish('ai.receipt_added', { shopId: input.shopId, items: added.length });
    return { added: added.length, message: `Added ${what}${shop ? ` from ${shop}` : ''} to stock.` };
  }

  ctx.addRoute({
    method: 'POST',
    path: '/receipt/add',
    summary: 'Add the lines kept from a receipt to stock, with the prices paid',
    description: 'All the lines are added or none are. The prices are recorded as prices paid at the shop (the pricing module keeps them), and each line\'s text is remembered for that shop, so the next receipt matches it straight away.',
    body: AddReceipt,
    response: z.object({ added: z.number(), message: z.string() }),
    handler: ({ body }) => add(body),
  });

  ctx.addTool({
    name: 'add_receipt',
    title: 'Add a receipt to stock',
    description: 'Add what was bought, from a till receipt or an online order, to stock in one go with the prices paid. Only for items Larder already has: match each line to one (search if unsure), leave out lines that aren\'t in Larder and say which, and don\'t add new items from a receipt unless the person asks. Give each line\'s text as printed, so Larder learns that shop\'s names for next time.',
    input: z.object({
      shop: z.string().max(60).optional().describe('The shop, e.g. "Tesco"'),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('The date on the receipt (YYYY-MM-DD), kept with the purchase history'),
      lines: z.array(z.object({
        item: z.string().min(1).max(200).describe('The item in Larder, e.g. "baked beans"'),
        quantity: z.number().positive().describe('How much of the item\'s own unit, e.g. 18 for two 9-roll packs of toilet roll counted in rolls'),
        price: z.number().min(0).optional().describe('What was paid for the line, e.g. 3.25'),
        text: z.string().max(200).optional().describe('The line as printed, e.g. "ANDREX CLASSIC 9PK"'),
        count: z.number().positive().optional().describe('How many were bought on the line, e.g. 2 for "2 @ £3.25". Default 1'),
      })).min(1).max(MAX_LINES),
    }),
    async run({ shop, date, lines }) {
      let shopId: string | null = null;
      let note = '';
      if (shop) {
        try {
          shopId = (await ctx.core.resolve.shop(shop)).id;
        } catch (err) {
          if (!(err instanceof LarderError)) throw err;
          note = ` Larder doesn't have a shop called ${shop}, so the prices were kept without one.`;
        }
      }
      const problems: string[] = [];
      const found: Array<{ product: Product; line: (typeof lines)[number] }> = [];
      for (const line of lines) {
        try {
          found.push({ product: await ctx.core.resolve.product(line.item), line });
        } catch (err) {
          if (!(err instanceof LarderError)) throw err;
          problems.push(err.message);
        }
      }
      if (problems.length) throw new LarderError(`Nothing was added. ${problems.join(' ')} Leave out lines that aren't in Larder, or use the item's exact name.`, 400, 'invalid');
      const r = await add(AddReceipt.parse({
        shopId, date: date ?? null, readBy: 'an assistant',
        lines: found.map(({ product, line }) => ({ productId: product.id, quantity: line.quantity, price: line.price ?? null, text: line.text ?? '', count: line.count ?? 1 })),
      }));
      return { text: r.message + note, data: r };
    },
  });
}
