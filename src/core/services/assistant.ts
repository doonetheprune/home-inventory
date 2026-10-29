/**
 * Tools for AI assistants (Claude, ChatGPT, Gemini, local models), served
 * over MCP by the server (src/server/mcp.ts).
 *
 * Kept deliberately few and plain so small local models use them reliably:
 * every tool takes names the way people say them ("loo roll", "G2-4",
 * "aldi"), answers in short readable text (plus the same facts as data), and
 * says what to do next when something is unclear. Modules add their own with
 * `ctx.addTool` (pricing adds check_price; scenarios and recipes add theirs).
 */
import { z } from 'zod';
import { LarderError, ValidationError } from '../errors';
import type { ProductDetail, ProductSummary } from '../model';
import type { Automation } from './automation';
import type { createCategoryService } from './catalogue';
import type { CoreContext } from './context';
import type { createProductService } from './products';
import type { Resolver } from './resolve';
import type { createSearchService } from './search';
import type { createShoppingService } from './shopping';
import type { createStockService } from './stock';
import { amount, andList, daysBetween } from '../util';

export interface ToolResult {
  /** What the assistant reads. Short, plain sentences or lines. */
  text: string;
  /** The same facts as data, for clients that use structured results. */
  data?: Record<string, unknown>;
}

export interface AssistantTool<I extends z.ZodObject = z.ZodObject> {
  /** snake_case, unique across core and modules, e.g. "check_price". */
  name: string;
  title: string;
  /** When to use it and what it needs, in a sentence or two. Small models rely on this. */
  description: string;
  input: I;
  /** True for tools that only read. */
  readOnly?: boolean;
  run(input: z.output<I>, caller: { userId: string | null }): Promise<ToolResult>;
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  module: string | null;
  input: z.ZodObject;
}

/** What the assistant is told about Larder when it connects. */
export const ASSISTANT_INSTRUCTIONS = [
  'Larder is this household\'s inventory of everything in the house: food, household stuff, pet supplies, tools, fuel, batteries, emergency supplies, and renewals like insurance (an item whose expiry is its renewal date).',
  'Refer to items, places and shops by name as people say them ("loo roll", "garage racking", "aldi"); ids, barcodes and place codes like "G2-4" work too.',
  'If a name could mean more than one item, the tool says which ones: ask the person, or use the exact name. Never guess.',
  'Quantities are in each item\'s own unit (tins, rolls, kg). Items have a usual place; "out of place" means it is somewhere else for now.',
  'Before adding something new with add_item, search for it: it may already exist under another name.',
  'Low stock counts deliveries on the way. Wish list items are things to buy that the house has none of yet.',
].join(' ');

const Item = z.string().min(1).max(200).describe('The item, by name or alias (e.g. "loo roll"), barcode, shop code or id');
const today = (ctx: CoreContext) => ctx.today();

function when(ctx: CoreContext, date: string | null): string {
  if (!date) return '';
  const d = daysBetween(today(ctx), date);
  const rel = d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d < 0 ? `${-d} days ago` : `in ${d} days`;
  return `${date} (${rel})`;
}

function summaryLine(ctx: CoreContext, s: ProductSummary): string {
  const p = s.product;
  if (p.wish) return `${p.name}: on the wish list (none yet)${p.notes ? `. ${p.notes.slice(0, 120)}` : ''}`;
  const parts = [`${p.name}: ${amount(s.inStock, p.unit)}`];
  if (s.charged !== null) parts.push(`${s.charged} charged, ${s.flat ?? 0} flat`);
  if (s.expected) parts.push(`${amount(s.expected, p.unit)} on the way`);
  if (s.places.length) parts.push(`in ${s.places.map((x) => x.path).join(' and ')}`);
  if (s.nowIn.length) parts.push(`now in ${s.nowIn.map((x) => x.path).join(' and ')}`);
  if (s.status.low) parts.push('running low');
  if (s.nextExpiry && s.status.expiringSoon) parts.push(`expires ${when(ctx, s.nextExpiry)}`);
  return parts.join(', ');
}

function detailText(ctx: CoreContext, d: ProductDetail): string {
  const p = d.product;
  const lines = [`${p.name}${d.category ? ` (${d.category.name})` : ''}`];
  if (p.wish) lines.push('On the wish list: the house has none yet.');
  else lines.push(`In stock: ${amount(d.inStock, p.unit)}${d.charged !== null ? ` (${d.charged} charged, ${d.flat ?? 0} flat)` : ''}${d.expected ? `, ${amount(d.expected, p.unit)} on the way` : ''}.`);
  const here = d.entries.filter((e) => e.status === 'in_stock');
  if (here.length) {
    lines.push('Batches:');
    for (const e of here) {
      const at = e.currentPlace ? `${e.currentPlace.path} for now (usually ${e.place?.path ?? 'no usual place'})` : (e.place?.path ?? 'no place set');
      lines.push(`- ${amount(e.quantity, p.unit)} in ${at}${e.expiresOn ? `, expires ${when(ctx, e.expiresOn)}` : ''}${e.charge === 'flat' ? ', flat' : ''}`);
    }
  }
  for (const e of d.entries.filter((x) => x.status === 'expected')) lines.push(`- ${amount(e.quantity, p.unit)} expected from ${e.expected?.source ?? 'an order'}${e.expected?.eta ? ` on ${e.expected.eta}` : ''}${e.expected?.reference ? ` (order ${e.expected.reference})` : ''}`);
  if (p.minQuantity) lines.push(`Running low below ${amount(p.minQuantity, p.unit)}${d.status.low ? ': it is low now' : ''}.`);
  if (p.shelfLifeDays) lines.push(`${d.category?.name === 'Renewals' ? 'Renews every' : 'Keeps for'} ${p.shelfLifeDays} days.`);
  if (d.shops.length) lines.push(`${p.preferredShopIds.length ? 'Buy from' : 'Any shop; these sell it'}: ${andList(d.shops.map((s) => s.name))}.`);
  if (p.aliases.length) lines.push(`Also called: ${p.aliases.join(', ')}.`);
  if (d.variants.length) lines.push(`Brands: ${d.variants.map((v) => v.name).join('; ')}.`);
  if (p.notes) lines.push(`Notes: ${p.notes}`);
  lines.push(`id: ${p.id}`);
  return lines.join('\n');
}

export function createAssistant(deps: {
  ctx: CoreContext;
  products: ReturnType<typeof createProductService>;
  stock: ReturnType<typeof createStockService>;
  shopping: ReturnType<typeof createShoppingService>;
  search: ReturnType<typeof createSearchService>;
  categories: ReturnType<typeof createCategoryService>;
  automation: Automation;
  resolve: Resolver;
}) {
  const { ctx, products, shopping, search, categories, automation, resolve } = deps;
  const tools: Array<{ tool: AssistantTool; module: string | null; enabled: () => boolean }> = [];

  function addTool<I extends z.ZodObject>(tool: AssistantTool<I>, module: string | null = null, enabled: () => boolean = () => true) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`Tool name "${tool.name}" must be snake_case.`);
    if (tools.some((t) => t.tool.name === tool.name)) throw new Error(`Two tools are called "${tool.name}".`);
    tools.push({ tool: tool as unknown as AssistantTool, module, enabled });
  }

  /** A tool that runs one of the Home Assistant actions, so both say the same thing. */
  function fromAction(name: string, actionId: string, title: string, description: string) {
    const def = automation.definition(actionId);
    if (!def) throw new Error(`No action ${actionId}`);
    addTool({
      name, title, description, input: def.input,
      async run(input, caller) {
        const { message, ...data } = await automation.run(actionId, input, caller);
        return { text: message, data };
      },
    });
  }

  addTool({
    name: 'search', title: 'Search the house', readOnly: true,
    description: 'Find items, places and shops by any words: names, nicknames, brands, notes or place names. Typos are fine. Use this first when you are not sure what something is called in Larder.',
    input: z.object({ query: z.string().min(1).max(200).describe('What to look for, e.g. "batteries" or "garage"') }),
    async run({ query }) {
      const sections = await search.query(query);
      if (!sections.length) return { text: `Nothing in Larder matches "${query}".`, data: { sections: [] } };
      const world = sections.map((s) => `${s.title}:\n${s.results.map((r) => `- ${r.product ? summaryLine(ctx, r.product) : `${r.title}${r.subtitle ? ` (${r.subtitle})` : ''}`}`).join('\n')}`);
      return {
        text: world.join('\n'),
        data: { sections: sections.map((s) => ({ section: s.title, results: s.results.map((r) => ({ type: r.type, id: r.id, name: r.title, detail: r.product ? summaryLine(ctx, r.product) : r.subtitle })) })) },
      };
    },
  });

  addTool({
    name: 'get_item', title: 'Look up an item', readOnly: true,
    description: 'Everything about one item: how many, where each batch is, expiry dates, deliveries on the way, when it counts as low, which shops sell it, and notes (e.g. policy details for a renewal).',
    input: z.object({ item: Item }),
    async run({ item }) {
      const p = await resolve.product(item);
      const d = await products.get(p.id);
      return {
        text: detailText(ctx, d),
        data: {
          id: p.id, name: p.name, category: d.category?.name ?? null, unit: p.unit, in_stock: d.inStock, expected: d.expected, low: d.status.low, minimum: p.minQuantity,
          batches: d.entries.map((e) => ({ quantity: e.quantity, status: e.status, place: e.place?.path ?? null, now_in: e.currentPlace?.path ?? null, expires_on: e.expiresOn, from: e.expected?.source ?? null })),
          shops: d.shops.map((s) => s.name), notes: p.notes,
        },
      };
    },
  });

  addTool({
    name: 'add_item', title: 'Add a new item',
    description: 'Add something Larder doesn\'t know yet (search first). Give a plain generic name ("Chopped tomatoes", not a brand). Then use add_stock to say how many there are, or add_expected if it\'s on order.',
    input: z.object({
      name: z.string().min(1).max(120).describe('Generic name, e.g. "Chopped tomatoes" or "Cordless drill"'),
      category: z.string().max(60).optional().describe('One of the household\'s categories, e.g. Food, Household, Pets, Tools & DIY, Batteries, Renewals'),
      unit: z.string().max(20).optional().describe('What it\'s counted in, e.g. tin, roll, kg, L (default: each)'),
      aliases: z.array(z.string().max(60)).max(10).optional().describe('Other names people use'),
      minimum: z.number().min(0).optional().describe('Running low below this many'),
      shelf_life_days: z.number().int().positive().optional().describe('How long it keeps, or for a renewal how often it renews'),
      usual_place: z.string().max(200).optional().describe('Where it usually lives: a place name or code'),
      shop: z.string().max(80).optional().describe('Preferred shop'),
      shop_code: z.string().max(40).optional().describe('That shop\'s product code (e.g. a Toolstation item number), used to match order emails'),
      barcode: z.string().max(64).optional(),
      wish_list: z.boolean().optional().describe('True to put it on the wish list instead (wanted, none yet)'),
    }),
    async run(i) {
      const existing = await resolve.product(i.name).catch(() => null);
      if (existing && existing.name.toLowerCase() === i.name.trim().toLowerCase()) throw new LarderError(`${existing.name} is already in Larder. Use add_stock to add some.`, 409, 'conflict');
      let categoryId: string | null = null;
      if (i.category) {
        const cats = await categories.list();
        const cat = cats.find((c) => c.name.toLowerCase() === i.category!.trim().toLowerCase());
        if (!cat) throw new ValidationError(`There's no category called "${i.category}". The categories are: ${andList(cats.map((c) => c.name))}.`);
        categoryId = cat.id;
      }
      const place = i.usual_place ? await resolve.place(i.usual_place) : null;
      const shop = i.shop ? await resolve.shop(i.shop) : null;
      if (i.shop_code && !shop) throw new ValidationError('A shop code needs the shop it belongs to.');
      const p = await products.create({
        name: i.name.trim(), categoryId, ...(i.unit ? { unit: i.unit } : {}), aliases: i.aliases ?? [], minQuantity: i.minimum ?? null,
        shelfLifeDays: i.shelf_life_days ?? null, defaultPlaceId: place?.id ?? null, preferredShopIds: shop ? [shop.id] : [], wish: i.wish_list ?? false,
      });
      if (i.barcode || i.shop_code) {
        await products.addVariant(p.id, { name: p.name, barcodes: i.barcode ? [i.barcode] : [], shopCodes: i.shop_code && shop ? [{ shopId: shop.id, code: i.shop_code }] : [] });
      }
      return { text: `Added ${p.name}${i.wish_list ? ' to the wish list' : ''}. It has no stock yet${i.wish_list ? '' : ': use add_stock to say how many'}.`, data: { id: p.id, name: p.name } };
    },
  });

  fromAction('add_stock', 'add_stock', 'Add stock', 'Add some of an item to stock (after shopping, or when found). Expiry is worked out from its shelf life unless given.');
  fromAction('use_stock', 'use_stock', 'Use stock', 'Take some of an item out of stock because it was used up, eaten or thrown away. Uses the soonest-expiring first.');
  fromAction('move_item', 'move_item', 'Move an item', 'Something moved to another place: for now (out of place, e.g. the drill taken to the kitchen) or for good (permanent: its usual place changes). To put it back, move it to its usual place.');
  fromAction('add_expected', 'add_expected', 'Add an expected delivery', 'Something has been ordered but not arrived (e.g. from an order email). It counts towards stock so it isn\'t bought twice. The item can be a shop code from the order.');
  fromAction('mark_arrived', 'mark_arrived', 'Mark a delivery arrived', 'A delivery arrived: give the source (e.g. "Tesco delivery") for all of it, or an item and quantity for part of it.');
  fromAction('add_to_shopping_list', 'add_to_shopping_list', 'Put on the shopping list', 'Put an item on the shopping list even though it isn\'t low.');

  addTool({
    name: 'shopping_list', title: 'Shopping list', readOnly: true,
    description: 'What to buy. With a shop: everything that shop can supply (its favourites plus items from any shop in categories it sells). Without: how many things each shop can supply and which shop to go to.',
    input: z.object({ shop: z.string().max(80).optional().describe('e.g. "Aldi". Leave out for an overview of every shop') }),
    async run({ shop }) {
      if (!shop) {
        const s = await shopping.summary();
        const best = s.shops.find((x) => x.shop.id === s.suggestedShopId)?.shop.name;
        const text = s.shops.length
          ? `${s.shops.map((x) => `${x.shop.name}: ${x.count}`).join('\n')}${s.unassigned ? `\nNo shop sells: ${s.unassigned}` : ''}${best ? `\nBest shop to go to: ${best}.` : ''}`
          : 'There are no shops set up in Larder.';
        return { text, data: { shops: s.shops.map((x) => ({ shop: x.shop.name, items: x.count })), suggested_shop: best ?? null, no_shop: s.unassigned } };
      }
      const found = await resolve.shop(shop);
      const list = await shopping.forShop(found.id);
      const items = list.groups.flatMap((g) => g.items.map((it) => ({ item: it.summary.product.name, quantity: it.quantity, unit: it.summary.product.unit, in_stock: it.summary.inStock, category: g.category?.name ?? 'Other' })));
      if (!items.length) return { text: `Nothing to get at ${found.name}.`, data: { shop: found.name, items } };
      const text = [`At ${found.name} (${items.length}):`, ...list.groups.map((g) => `${g.category?.name ?? 'Other'}: ${g.items.map((it) => `${it.summary.product.name} ×${amount(it.quantity, it.summary.product.unit)}`).join(', ')}`)].join('\n');
      return { text, data: { shop: found.name, items } };
    },
  });

  addTool({
    name: 'expiring', title: 'What to use soon', readOnly: true,
    description: 'Items that expire soon or already have, and renewals coming up (insurance, MOT). Good for planning meals around what needs using.',
    input: z.object({ days: z.number().int().min(0).max(365).optional().describe('Look this many days ahead. Leave out to use each item\'s own warning time') }),
    async run({ days }) {
      const all = await products.list({ status: days === undefined ? 'expiring' : 'in_stock' });
      const due = all
        .filter((s) => !s.product.wish && s.nextExpiry && (days === undefined || (s.daysToExpiry ?? Infinity) <= days))
        .sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0));
      if (!due.length) return { text: days === undefined ? 'Nothing needs using soon.' : `Nothing expires in the next ${days} days.`, data: { items: [] } };
      const text = due.map((s) => `- ${s.product.name}: ${s.category?.name === 'Renewals' ? 'renews' : 'expires'} ${when(ctx, s.nextExpiry)}, ${amount(s.inStock, s.product.unit)}${s.places[0] ? ` in ${s.places[0].path}` : ''}`).join('\n');
      return { text, data: { items: due.map((s) => ({ item: s.product.name, expires_on: s.nextExpiry, days: s.daysToExpiry, in_stock: s.inStock, unit: s.product.unit, place: s.places[0]?.path ?? null, category: s.category?.name ?? null })) } };
    },
  });

  return {
    addTool,

    list(): ToolInfo[] {
      return tools.filter((t) => t.enabled()).map(({ tool, module }) => ({ name: tool.name, title: tool.title, description: tool.description, readOnly: !!tool.readOnly, module, input: tool.input }));
    },

    async call(name: string, input: unknown, caller: { userId: string | null } = { userId: null }): Promise<ToolResult> {
      const t = tools.find((x) => x.tool.name === name && x.enabled());
      if (!t) throw new LarderError(`There's no tool called ${name}.`, 404, 'not_found');
      const parsed = t.tool.input.safeParse(input ?? {});
      if (!parsed.success) throw new ValidationError(`${t.tool.title}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
      return t.tool.run(parsed.data, caller);
    },
  };
}

export type Assistant = ReturnType<typeof createAssistant>;
