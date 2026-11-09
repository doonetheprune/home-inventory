/**
 * Assistant tools for looking around the house the way the app does: lists
 * of items by status, type or place, what's in a place, what a code is, and
 * ticking off several things bought at once (with their prices).
 */
import { z } from 'zod';
import { IsoDate, type ProductSummary } from '../model';
import type { AssistantTool } from './assistant';
import type { createCategoryService, createPlaceService } from './catalogue';
import type { CoreContext } from './context';
import type { createLookupService } from './lookup';
import type { createProductService } from './products';
import type { Resolver } from './resolve';
import type { createShoppingService } from './shopping';
import { finders } from './assistant-manage';
import { andList, roundQty } from '../util';
import { amountText, exactText, toBoughtIn, type Units } from './units';

type AddTool = <I extends z.ZodObject>(tool: AssistantTool<I>) => void;

export interface BrowseDeps {
  ctx: CoreContext;
  products: ReturnType<typeof createProductService>;
  shopping: ReturnType<typeof createShoppingService>;
  places: ReturnType<typeof createPlaceService>;
  categories: ReturnType<typeof createCategoryService>;
  lookup: ReturnType<typeof createLookupService>;
  resolve: Resolver;
  /** One item in a line, as search and get_item say it. */
  line: (units: Units, s: ProductSummary) => string;
}

const STATUSES = ['all', 'low', 'expiring', 'out_of_place', 'expected', 'wish', 'in_stock', 'to_sort', 'to_tidy', 'open'] as const;

export function addBrowseTools(addTool: AddTool, deps: BrowseDeps): void {
  const { products, shopping, places, lookup, resolve, line } = deps;
  const find = finders(deps);

  addTool({
    name: 'list_items', title: 'List items', readOnly: true,
    description: 'List items the way the app\'s Stock pages do: by status (low, expiring, out_of_place, expected, wish list, in_stock, to_sort: stock with no place yet, to_tidy: no place or no type, or flagged for the owner to look at, with why; open: opened and not finished, or in use), by category, by place, or a mix.',
    input: z.object({
      status: z.enum(STATUSES).default('all').describe('Which items: all (owned), low, expiring, out_of_place, expected, wish, in_stock, to_sort, to_tidy or open'),
      category: z.string().max(60).optional().describe('Only this category, e.g. "Food"'),
      place: z.string().max(200).optional().describe('Only items with stock in this place (name or code)'),
      limit: z.number().int().min(1).max(200).default(50).describe('Most to list (default 50)'),
    }),
    async run({ status, category, place, limit }) {
      const categoryId = category ? (await find.category(category)).id : undefined;
      const placeId = place ? (await find.place(place)).id : undefined;
      let list: ProductSummary[];
      let quantities: Map<string, number> | null = null;
      if (status === 'to_sort') {
        const loose = (await places.toSort()).items;
        quantities = new Map(loose.map((x) => [x.summary.product.id, x.quantity]));
        list = loose.map((x) => x.summary).filter((s) => !categoryId || s.product.categoryId === categoryId);
      } else {
        list = await products.list({ status: status === 'open' ? 'all' : status, categoryId, placeId });
        if (status === 'open') list = list.filter((s) => s.inUse);
      }
      if (!list.length) return { text: 'No items like that.', data: { items: [] } };
      const units = await deps.ctx.units();
      const shown = list.slice(0, limit);
      const text = shown.map((s) => `- ${line(units, s)}${quantities ? ` (${amountText(units, quantities.get(s.product.id) ?? 0, s.product.unit)} with no place)` : ''}${s.product.needsCheck ? `. To tidy: ${s.product.needsCheck}` : ''}`).join('\n') + (list.length > shown.length ? `\n…and ${list.length - shown.length} more.` : '');
      return { text, data: { count: list.length, items: shown.map((s) => ({ id: s.product.id, item: s.product.name, in_stock: s.inStock, unit: s.product.unit, low: s.status.low, next_expiry: s.nextExpiry, runs_out_on: s.runsOutOn, open: s.inUse, needs_check: s.product.needsCheck ?? null })) } };
    },
  });

  addTool({
    name: 'get_place', title: 'What\'s in a place', readOnly: true,
    description: 'Everything in one place: the items kept there and how many (including ones that have run out there), what\'s out of place from there, what\'s there from elsewhere for now, and the places inside it.',
    input: z.object({ place: z.string().min(1).max(200).describe('The place, by name or code, e.g. "garage racking" or "G2-4"') }),
    async run({ place }) {
      const p = await find.place(place);
      const [c, units] = await Promise.all([places.contents(p.id), deps.ctx.units()]);
      const amount = (n: number, unit: string) => amountText(units, n, unit);
      const lines = [`${c.path}${c.place.code ? ` (${c.place.code})` : ''}`];
      if (c.place.notes) lines.push(`Notes: ${c.place.notes}`);
      if (c.items.length) {
        lines.push('Kept here:');
        for (const i of c.items) lines.push(`- ${i.summary.product.name}: ${i.quantity > 0 ? amount(i.quantity, i.summary.product.unit) : 'none here now'}${i.outOfPlace && i.nowIn ? `, some now in ${i.nowIn.path}` : ''}${i.summary.status.low ? ' (low)' : ''}`);
      } else lines.push('Nothing is kept here.');
      if (c.visitors.length) lines.push(`Here for now: ${andList(c.visitors.map((v) => `${v.summary.product.name} (${amount(v.quantity, v.summary.product.unit)}, usually in ${v.usualPlace?.path ?? 'no usual place'})`))}.`);
      if (c.children.length) lines.push(`Places inside: ${andList(c.children.map((x) => `${x.name}${x.code ? ` (${x.code})` : ''}: ${x.itemCount} item${x.itemCount === 1 ? '' : 's'}`))}.`);
      return {
        text: lines.join('\n'),
        data: {
          place: c.path, code: c.place.code,
          items: c.items.map((i) => ({ item: i.summary.product.name, quantity: i.quantity, unit: i.summary.product.unit, out_of_place: i.outOfPlace, now_in: i.nowIn?.path ?? null })),
          here_for_now: c.visitors.map((v) => ({ item: v.summary.product.name, quantity: v.quantity, usually: v.usualPlace?.path ?? null })),
          places_inside: c.children.map((x) => ({ place: x.name, code: x.code, items: x.itemCount })),
        },
      };
    },
  });

  addTool({
    name: 'identify_code', title: 'What is this code?', readOnly: true,
    description: 'Look up a barcode, a Larder label\'s code, a place code or a shop code: the item or place it belongs to, or, for a barcode Larder doesn\'t know, what the online product databases say it is (offer to add it with add_item and its barcode).',
    input: z.object({ code: z.string().min(1).max(200).describe('The code, e.g. "5029053038889" or "G2-4"') }),
    async run({ code }) {
      const [r, units] = await Promise.all([lookup.identify(code), deps.ctx.units()]);
      if (r.kind === 'product') return { text: `${code} is ${r.product.product.name}${r.variant ? ` (${r.variant.name})` : ''}. ${line(units, r.product)}.`, data: { kind: 'item', item: r.product.product.name, id: r.product.product.id, brand: r.variant?.name ?? null } };
      if (r.kind === 'place') return { text: `${code} is the place ${r.path}.`, data: { kind: 'place', place: r.path, id: r.place.id } };
      if (r.kind === 'external') {
        const what = [r.result.brand, r.result.name].filter(Boolean).join(' ') || 'something';
        const like = r.suggestions.length ? ` It may be one of these already in Larder: ${andList(r.suggestions.map((s) => s.product.name))} (add_brand with the barcode), or a new item (add_item with the barcode).` : ' It isn\'t in Larder: add_item with the barcode adds it.';
        return { text: `${code} isn't in Larder. The online product databases say it's ${what}${r.result.quantityText ? `, ${r.result.quantityText}` : ''}.${like}`, data: { kind: 'external', name: r.result.name, brand: r.result.brand, size: r.result.quantityText, suggestions: r.suggestions.map((s) => s.product.name) } };
      }
      return { text: `Nobody knows the code ${code}${r.providersTried.length ? ` (asked ${andList(r.providersTried)})` : ''}${r.providersFailed.length ? `; ${andList(r.providersFailed)} couldn't be reached, so try again later` : ''}. If it's something in the house, add it with add_item and the barcode.`, data: { kind: 'unknown' } };
    },
  });

  addTool({
    name: 'bought', title: 'Bought these',
    description: 'Several things bought at once (ticked off at a shop, or from a receipt the person reads out): adds them all to stock in one go and keeps each in the purchase history with its price and the shop. For one item add_stock does the same; for a photo of a receipt, add_receipt also learns the shop\'s names.',
    input: z.object({
      shop: z.string().max(80).optional().describe('Where they were bought, e.g. "Aldi"'),
      items: z.array(z.object({
        item: z.string().min(1).max(200).describe('The item in Larder'),
        quantity: z.number().positive().describe('How many, in what the item is bought in, or in unit'),
        unit: z.string().max(30).optional().describe('What the quantity is in, if not what the item is bought in: what\'s in its pack ("tea bag", for boxes of 20 tea bags), or g, kg, ml, L or pints once it has a Weight'),
        price: z.number().min(0).optional().describe('What the line cost, e.g. 3.20'),
      })).min(1).max(100),
      date: IsoDate.optional().describe('When they were bought, if not today (YYYY-MM-DD)'),
      note: z.string().max(200).optional(),
    }),
    async run({ shop, items, date, note }) {
      const s = shop ? await find.shop(shop) : null;
      const units = await deps.ctx.units();
      const resolved = await Promise.all(items.map(async (i) => {
        const product = await resolve.product(i.item);
        return { ...i, product, quantity: roundQty(toBoughtIn(units, product, i.quantity, i.unit)) };
      }));
      const done = await shopping.purchase({
        shopId: s?.id ?? null,
        items: resolved.map((i) => ({ productId: i.product.id, quantity: i.quantity, ...(i.price !== undefined ? { price: i.price } : {}) })),
        ...(date || note ? { evidence: { boughtOn: date ?? null, note: note ?? null } } : {}),
      });
      const what = resolved.map((i) => `${i.product.name} (${exactText(units, i.product, i.quantity)}${i.price !== undefined ? `, ${i.price.toFixed(2)}` : ''})`);
      return { text: `Added to stock${s ? ` from ${s.name}` : ''}: ${andList(what)}.`, data: { shop: s?.name ?? null, items: done.map((x) => ({ item: x.product.name, in_stock: x.inStock, unit: x.product.unit, low: x.status.low })) } };
    },
  });
}
