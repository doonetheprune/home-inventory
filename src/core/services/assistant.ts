/**
 * Tools for AI assistants (Claude, ChatGPT, Gemini, local models), served
 * over MCP by the server (src/server/mcp.ts).
 *
 * Plain, so small local models use them reliably: every tool takes names
 * the way people say them ("loo roll", "G2-4", "aldi"), answers in short
 * readable text (plus the same facts as data), and
 * says what to do next when something is unclear. Modules add their own with
 * `ctx.addTool` (pricing adds check_price; scenarios and recipes add theirs).
 * Tools for shops, places, categories and changing items are in assistant-manage.ts.
 */
import { z } from 'zod';
import { ConflictError, LarderError, ValidationError } from '../errors';
import type { ProductDetail, ProductSummary } from '../model';
import { addBrowseTools } from './assistant-browse';
import { addManageTools, assertPackFits, ComesInInput, finders, TakesOutInput, UsesInput, usageFields } from './assistant-manage';
import { daysFor, packsText, usageText, worthText } from './packs';
import { placesText } from './world';
import type { Automation } from './automation';
import { SHOP_PRESETS, type createCategoryService, type createPlaceService, type createShopService } from './catalogue';
import type { CoreContext } from './context';
import type { createLookupService } from './lookup';
import type { createProductService } from './products';
import type { Resolver } from './resolve';
import type { createSearchService } from './search';
import type { createShoppingService } from './shopping';
import type { createStockService } from './stock';
import { amount, andList, daysBetween, pluralWord } from '../util';

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
  /**
   * True when it removes something or overwrites what was set (a removed item,
   * a changed price, a corrected count), so doing the opposite doesn't undo it.
   * MCP clients such as the Claude app ask the person before each call. Not for
   * everyday stock changes that the opposite tool undoes and stock history
   * records (using, finishing, moving, arriving, taking off the shopping list):
   * asking before every one makes talking to an assistant hard work.
   */
  destructive?: boolean;
  run(input: z.output<I>, caller: { userId: string | null }): Promise<ToolResult>;
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  module: string | null;
  input: z.ZodObject;
}

/** What the assistant is told about Larder when it connects. */
export const ASSISTANT_INSTRUCTIONS = [
  'Larder is this household\'s inventory of everything in the house: food, household stuff, pet supplies, tools, fuel, batteries, emergency supplies, and renewals like insurance (an item whose expiry is its renewal date).',
  'Refer to items, places and shops by name as people say them ("loo roll", "garage racking", "aldi"); ids, barcodes and place codes like "G2-4" work too.',
  'If a name could mean more than one item, the tool says which ones: ask the person, or use the exact name. Never guess.',
  'Quantities are in each item\'s own unit (tins, rolls, kg). Items have a usual place; "out of place" means it is somewhere else for now.',
  'An item is counted in the single thing that gets used (a tea bag, a roll, a sensor) and can come in a pack (comes_in: a box of 20). Larder still shows the boxes ("80 tea bags (4 boxes)"), stock tools take amounts in boxes (unit: "box") and the shopping list buys whole boxes, so someone who wants to keep counting boxes and say how many are in one wants a pack, not a note. For something counted in boxes so far, that is change_item with unit (what\'s inside), comes_in and recount: true.',
  'How fast something is used (uses: 1 tea bag a day) tells Larder when it runs out; with takes_out_automatically, Larder takes them out of stock by itself.',
  'Before adding something new with add_item, search for it: it may already exist under another name.',
  'Anything about an item can be changed later with change_item (its name, category, shop, usual place, minimum, what it comes in and how fast it is used).',
  'If a shop, place or category doesn\'t exist yet, the tool says so: offer to add it (add_shop, add_place, add_category), then carry on.',
  'Low stock counts deliveries on the way and pending orders (ordered, not confirmed). Wish list items are things to buy that the house has none of yet.',
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
  const packs = packsText(p, s.inStock);
  const parts = [`${p.name}: ${amount(s.inStock, p.unit)}${packs ? ` (${packs})` : ''}`];
  if (s.charged !== null) parts.push(`${s.charged} charged, ${s.flat ?? 0} flat`);
  if (s.expected) parts.push(`${amount(s.expected, p.unit)} on the way`);
  if (s.pending) parts.push(`${amount(s.pending, p.unit)} in a pending order`);
  const where = placesText(s);
  if (where) parts.push(where);
  if (s.nowIn.length) parts.push(`now in ${s.nowIn.map((x) => x.path).join(' and ')}`);
  if (s.inUse && !p.usage && p.inUseSince) parts.push(`one open since ${p.inUseSince}`);
  if (p.usage) parts.push(`uses ${usageText(p)}${p.usage.auto ? ' (taken out by Larder)' : ''}`);
  if (s.status.low) parts.push('running low');
  if (s.runsOutOn) parts.push(`enough until ${when(ctx, s.runsOutOn)}`);
  if (s.nextExpiry && s.status.expiringSoon) parts.push(`expires ${when(ctx, s.nextExpiry)}`);
  return parts.join(', ');
}

/** "Uses 1 tea bag a day, taken out of stock by Larder. One in use since …, until …. Enough until …" */
function usageLine(ctx: CoreContext, s: ProductSummary): string {
  const p = s.product;
  const u = p.usage!;
  const parts = [`Uses ${usageText(p)}${u.auto ? ', taken out of stock by Larder' : ''}.`];
  if (s.inUseUntil && u.everyDays >= 2) parts.push(`One in use since ${p.inUseSince}, until ${when(ctx, s.inUseUntil)}, not counted in stock.`);
  else if (u.auto && !p.inUseSince) parts.push('None started yet, so nothing is taken out until one is (use_stock with opened, or change_item in_use_since).');
  if (s.runsOutOn) parts.push(s.inStock <= 0 && !s.inUseUntil ? 'None left.' : `Enough until ${when(ctx, s.runsOutOn)}.`);
  return parts.join(' ');
}

function detailText(ctx: CoreContext, d: ProductDetail): string {
  const p = d.product;
  const lines = [`${p.name}${d.category ? ` (${d.category.name})` : ''}`];
  if (p.wish) lines.push('On the wish list: the house has none yet.');
  else lines.push(`In stock: ${amount(d.inStock, p.unit)}${packsText(p, d.inStock) ? ` (${packsText(p, d.inStock)})` : ''}${d.charged !== null ? ` (${d.charged} charged, ${d.flat ?? 0} flat)` : ''}${d.expected ? `, ${amount(d.expected, p.unit)} on the way` : ''}.`);
  if (p.pack) lines.push(`Comes in ${pluralWord(p.pack.name, 2)} of ${p.pack.holds}.`);
  const where = placesText(d);
  if (where) lines.push(`${where[0]!.toUpperCase()}${where.slice(1)}.`);
  const here = d.entries.filter((e) => e.status === 'in_stock');
  if (here.length) {
    lines.push('Batches:');
    for (const e of here) {
      const at = e.currentPlace ? `${e.currentPlace.path} for now (usually ${e.place?.path ?? 'no usual place'})` : (e.place?.path ?? 'no place set');
      lines.push(`- ${amount(e.quantity, p.unit)} in ${at}${e.expiresOn ? `, expires ${when(ctx, e.expiresOn)}` : ''}${e.charge === 'flat' ? ', flat' : ''}`);
    }
  }
  for (const e of d.entries.filter((x) => x.status === 'expected')) lines.push(`- ${amount(e.quantity, p.unit)} expected from ${e.expected?.source ?? 'an order'}${e.expected?.eta ? ` on ${e.expected.eta}` : ''}${e.expected?.reference ? ` (order ${e.expected.reference})` : ''}`);
  for (const e of d.entries.filter((x) => x.status === 'pending')) lines.push(`- ${amount(e.quantity, p.unit)} in a pending order (${e.expected?.source ?? 'an order'}, not confirmed yet)`);
  const worth = p.minQuantity ? daysFor(p, p.minQuantity) : null;
  if (p.minQuantity) lines.push(`Running low below ${amount(p.minQuantity, p.unit)}${worth !== null ? ` (${worthText(worth)})` : ''}${d.status.low ? ': it is low now' : ''}.`);
  if (p.stockUpTo) lines.push(`Stock up to ${amount(p.stockUpTo, p.unit)} when buying more.`);
  if (p.shelfLifeDays) lines.push(`${d.category?.name === 'Renewals' ? 'Renews every' : 'Keeps for'} ${p.shelfLifeDays} days.`);
  if (p.usage) lines.push(usageLine(ctx, d));
  else if (d.inUse && p.inUseSince) lines.push(`One open since ${when(ctx, p.inUseSince)}, not counted in stock${d.inStock + d.expected + d.pending <= 0 ? ': it is the last one' : ''}.`);
  if (d.shops.length) lines.push(`${p.preferredShopIds.length ? 'Buy from' : 'Any shop; these sell it'}: ${andList(d.shops.map((s) => s.name))}.`);
  if (p.aliases.length) lines.push(`Also called: ${p.aliases.join(', ')}.`);
  if (d.variants.length) lines.push(`Brands: ${d.variants.map((v) => `${v.name}${v.barcodes.length ? ` (barcode ${v.barcodes.join(', ')})` : ''}${v.shopCodes.length ? ` (shop code ${v.shopCodes.map((c) => `${c.code}${d.shops.find((s) => s.id === c.shopId) ? ` at ${d.shops.find((s) => s.id === c.shopId)!.name}` : ''}`).join(', ')})` : ''}`).join('; ')}.`);
  if (p.links.length) lines.push(`Links: ${p.links.map((l) => (l.title ? `${l.title} ${l.url}` : l.url)).join(', ')}`);
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
  shops: ReturnType<typeof createShopService>;
  places: ReturnType<typeof createPlaceService>;
  lookup: ReturnType<typeof createLookupService>;
  automation: Automation;
  resolve: Resolver;
}) {
  const { ctx, products, shopping, search, shops, lookup, automation, resolve } = deps;
  const find = finders(deps);
  const tools: Array<{ tool: AssistantTool; module: string | null; enabled: () => boolean }> = [];

  function addTool<I extends z.ZodObject>(tool: AssistantTool<I>, module: string | null = null, enabled: () => boolean = () => true) {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`Tool name "${tool.name}" must be snake_case.`);
    if (tools.some((t) => t.tool.name === tool.name)) throw new Error(`Two tools are called "${tool.name}".`);
    tools.push({ tool: tool as unknown as AssistantTool, module, enabled });
  }

  /** A tool that runs one of the Home Assistant actions, so both say the same thing. */
  function fromAction(name: string, actionId: string, title: string, description: string, destructive = false) {
    const def = automation.definition(actionId);
    if (!def) throw new Error(`No action ${actionId}`);
    addTool({
      name, title, description, input: def.input, destructive,
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
    description: 'Everything about one item: how many, how many in each place it\'s kept in (including places that have run out), where each batch is, expiry dates, deliveries on the way, when it counts as low, which shops sell it, and notes (e.g. policy details for a renewal).',
    input: z.object({ item: Item }),
    async run({ item }) {
      const p = await resolve.product(item);
      const d = await products.get(p.id);
      return {
        text: detailText(ctx, d),
        data: {
          id: p.id, name: p.name, category: d.category?.name ?? null, unit: p.unit, in_stock: d.inStock, expected: d.expected, low: d.status.low, minimum: p.minQuantity, stock_up_to: p.stockUpTo ?? null,
          places: (d.stockByPlace ?? []).map((x) => ({ place: x.path, quantity: x.quantity })),
          batches: d.entries.map((e) => ({ quantity: e.quantity, status: e.status, place: e.place?.path ?? null, now_in: e.currentPlace?.path ?? null, expires_on: e.expiresOn, from: e.expected?.source ?? null })),
          shops: d.shops.map((s) => s.name), notes: p.notes,
          comes_in: p.pack ? { name: p.pack.name, holds: p.pack.holds } : null,
          uses: p.usage ? { amount: p.usage.amount, every_days: p.usage.everyDays, taken_out_by_larder: p.usage.auto } : null,
          in_use_since: p.inUseSince ?? null, in_use_until: d.inUseUntil, runs_out_on: d.runsOutOn,
        },
      };
    },
  });

  /**
   * A shop for a new item. One Larder doesn't have is only added when the
   * person has agreed (`create`); otherwise the assistant is told to ask.
   */
  async function findShop(name: string, create: boolean, categoryId: string | null): Promise<{ id: string; name: string; made: boolean }> {
    try {
      const s = await resolve.shop(name);
      return { id: s.id, name: s.name, made: false };
    } catch (err) {
      if (!(err instanceof LarderError) || err.code !== 'not_found') throw err;
      if (!create) throw new LarderError(`${err.message} Ask whether to add "${name.trim()}" as a shop, then call add_item again with new_shop: true, or leave the shop out.`, 404, 'not_found');
      const preset = SHOP_PRESETS.find((p) => p.name.toLowerCase().replace(/['’]/g, '') === name.trim().toLowerCase().replace(/['’]/g, ''));
      const s = preset ? await shops.addPreset(preset.name) : await shops.create({ name: name.trim(), sells: categoryId ? [categoryId] : [] });
      return { id: s.id, name: s.name, made: true };
    }
  }

  addTool({
    name: 'add_item', title: 'Add a new item',
    description: 'Add something Larder doesn\'t know yet (search first). Give a plain generic name ("Chopped tomatoes", not a brand), and the brand separately if the person said one. From a photo of the pack, read the name, brand and size, and the shop if it\'s a shop\'s own brand. For something used one at a time out of a pack (tea bags, dishwasher tablets), count what\'s inside (unit: "tea bag") and give comes_in (a box of 20): Larder still shows how many boxes. Then use add_stock to say how many there are, or add_expected if it\'s on order. Anything can be changed later with change_item.',
    input: z.object({
      name: z.string().min(1).max(120).describe('Generic name, e.g. "Chopped tomatoes" or "Cordless drill"'),
      category: z.string().max(60).optional().describe('One of the household\'s categories, e.g. Food, Household, Pets, Tools & DIY, Batteries, Renewals'),
      unit: z.string().max(20).optional().describe('What it\'s counted in, e.g. tin, roll, kg, L (default: each)'),
      aliases: z.array(z.string().max(60)).max(10).optional().describe('Other names people use'),
      minimum: z.number().min(0).optional().describe('Running low below this many'),
      stock_up_to: z.number().min(0).optional().describe('When buying more, top up to this many'),
      shelf_life_days: z.number().int().positive().optional().describe('How long it keeps, or for a renewal how often it renews'),
      comes_in: ComesInInput.optional(),
      uses: UsesInput.optional(),
      takes_out_automatically: TakesOutInput.optional(),
      usual_place: z.string().max(200).optional().describe('Where it usually lives: a place name or code'),
      shop: z.string().max(80).optional().describe('Preferred shop'),
      new_shop: z.boolean().optional().describe('True to add the shop to Larder if it isn\'t there yet. Only after the person has said yes'),
      shop_code: z.string().max(40).optional().describe('That shop\'s product code (e.g. a Toolstation item number), used to match order emails'),
      barcode: z.string().max(64).optional(),
      brand: z.string().max(160).optional().describe('The brand as the person said it or as on the label, e.g. "Flahavan\'s" or "Heinz Baked Beanz 415 g". Saved as the item\'s brand, with the barcode, and used to find a photo of it'),
      wish_list: z.boolean().optional().describe('True to put it on the wish list instead (wanted, none yet)'),
      rechargeable: z.boolean().optional().describe('True for rechargeable batteries and similar (stock is charged or flat)'),
      notes: z.string().max(5000).optional(),
      links: z.array(z.string().url().max(2000)).max(10).optional().describe('Web pages for it, e.g. where to buy it or its manual'),
    }),
    async run(i) {
      const existing = await resolve.product(i.name).catch(() => null);
      if (existing && existing.name.toLowerCase() === i.name.trim().toLowerCase()) throw new LarderError(`${existing.name} is already in Larder. Use add_stock to add some.`, 409, 'conflict');
      // Everything named must exist first, so nothing is quietly left out (a new shop only once the person agrees).
      const categoryId = i.category ? (await find.category(i.category)).id : null;
      const place = i.usual_place ? await find.place(i.usual_place) : null;
      if (i.shop_code && !i.shop) throw new ValidationError('A shop code needs the shop it belongs to.');
      assertPackFits(i.name.trim(), i.unit || 'each', i.comes_in ?? null);
      // Check the barcode before creating anything (a shop included), so a clash doesn't leave a half-made item.
      const owner = i.barcode ? await ctx.storage.variants.findByBarcode(i.barcode) : null;
      if (owner) throw new ConflictError(`Barcode ${i.barcode} already belongs to ${(await ctx.storage.products.get(owner.productId))?.name ?? 'another item'}.`);
      const shop = i.shop ? await findShop(i.shop, !!i.new_shop, categoryId) : null;
      const p = await products.create({
        name: i.name.trim(), categoryId, ...(i.unit ? { unit: i.unit } : {}), aliases: i.aliases ?? [], minQuantity: i.minimum ?? null, stockUpTo: i.stock_up_to ?? null,
        shelfLifeDays: i.shelf_life_days ?? null, pack: i.comes_in ?? null, ...usageFields(null, i.uses, i.uses ? i.takes_out_automatically : undefined), defaultPlaceId: place?.id ?? null, preferredShopIds: shop ? [shop.id] : [], wish: i.wish_list ?? false,
        rechargeable: i.rechargeable ?? false, notes: i.notes ?? '', links: (i.links ?? []).map((url) => ({ url, title: '' })),
      });
      // A photo from its barcode, or from its brand (food only); never the reason it can't be added.
      const brand = i.brand?.trim();
      const { match, photoFileId } = i.barcode || brand ? await lookup.findPhoto({ barcode: i.barcode, name: p.name, brand }) : { match: null, photoFileId: null };
      if (i.barcode || i.shop_code || brand) {
        // The brand as given; with only a barcode, what the lookup calls it.
        const fromBarcode = match && i.barcode && !brand;
        await products.addVariant(p.id, {
          name: fromBarcode ? [match.brand, match.name].filter(Boolean).join(' ') : brand || p.name,
          barcodes: i.barcode ? [i.barcode] : [],
          shopCodes: i.shop_code && shop ? [{ shopId: shop.id, code: i.shop_code }] : [],
          imageUrl: match?.imageUrl ?? null, photoFileId, source: match?.provider ?? 'local',
        });
      }
      if (photoFileId) await products.update(p.id, { photoFileIds: [photoFileId] });
      const photoOf = match && (!match.brand || match.name.toLowerCase().includes(match.brand.toLowerCase()) ? match.name : `${match.brand} ${match.name}`);
      const photo = photoFileId ? ` with a photo of ${photoOf}` : '';
      const shopNote = shop?.made ? ` Added ${shop.name} to the shops.` : '';
      const inPacks = p.pack ? `, in ${p.unit === 'each' ? 'ones' : pluralWord(p.unit, 2)} or in ${pluralWord(p.pack.name, 2)} (unit: "${p.pack.name}")` : '';
      return { text: `Added ${p.name}${i.wish_list ? ' to the wish list' : ''}${photo}.${shopNote} It has no stock yet${i.wish_list ? '' : `: use add_stock to say how many${inPacks}`}.`, data: { id: p.id, name: p.name, photo: !!photoFileId } };
    },
  });

  fromAction('add_stock', 'add_stock', 'Add stock', 'Add some of an item to stock (after shopping, or when found). Expiry is worked out from its shelf life unless given.');
  fromAction('use_stock', 'use_stock', 'Use stock', 'Take some of an item out of stock because it was used up, eaten or thrown away. Uses the soonest-expiring first. When one was opened and is still being used (the butter in the fridge), set opened: true; it shows as open until finish_item. For something Larder takes out of stock by itself (a tea bag a day, a sensor every 14 days), a use is an extra one (unless none has been started: then it starts one); set opened: true to say a new one was started now (a sensor that came off early). For something with a usage Larder doesn\'t take out, each use starts one today. quantity is in the item\'s own unit, or set unit to its pack ("box").');
  fromAction('finish_item', 'finish_item', 'Finished the open one', 'The open one of an item is finished (the butter\'s gone, the jar of coffee is empty), or the one in use is stopped (Larder stops taking them out until one is started). Use use_stock with opened: true when one is opened or started.');
  fromAction('move_item', 'move_item', 'Move an item', 'Something moved to another place: for now (out of place, e.g. the drill taken to the kitchen) or for good (permanent: its usual place changes). To put it back, move it to its usual place.');
  fromAction('add_expected', 'add_expected', 'Add an expected delivery', 'Something has been ordered but not arrived (e.g. from an order email). It counts towards stock so it isn\'t bought twice. The item can be a shop code from the order.');
  fromAction('mark_arrived', 'mark_arrived', 'Mark a delivery arrived', 'A delivery arrived: give the source (e.g. "Tesco delivery") for all of it, or an item and quantity for part of it.');
  fromAction('confirm_order', 'confirm_order', 'Confirm a pending order', 'A pending order (e.g. a filled online basket) was checked out, so it\'s on its way: give the source for all of it, or one item.');
  fromAction('cancel_order', 'cancel_order', 'Remove a pending order', 'A pending order didn\'t go ahead (the basket wasn\'t checked out): give the source for all of it, or one item. What\'s still low is bought next time.', true);
  fromAction('add_to_shopping_list', 'add_to_shopping_list', 'Put on the shopping list', 'Put an item on the shopping list even though it isn\'t low.');
  fromAction('remove_from_shopping_list', 'remove_from_shopping_list', 'Take off the shopping list', 'Take an item that was put on the shopping list by hand off it again. Items that are low stay on until restocked.');
  fromAction('put_back', 'put_back', 'Put an item back', 'Something that was out of place is back in its usual place.');
  fromAction('mark_charged', 'mark_charged', 'Mark batteries charged', 'Rechargeable batteries (or similar): some flat ones have been charged.');
  fromAction('renew', 'renew', 'Renew', 'A renewal (insurance, MOT, boiler service) has been renewed: restart its clock from today.');

  addTool({
    name: 'shopping_list', title: 'Shopping list', readOnly: true,
    description: 'What to buy. With a shop: everything that shop can supply (its favourites plus items from any shop in categories it sells). Without: how many things each shop can supply and which shop to go to.',
    input: z.object({ shop: z.string().max(80).optional().describe('e.g. "Aldi". Leave out for an overview of every shop; "none" for the things no shop sells') }),
    async run({ shop }) {
      if (shop && /^(none|no shop|nowhere|unassigned|no shops)$/i.test(shop.trim())) {
        const groups = await shopping.unassigned();
        const items = groups.flatMap((g) => g.items.map((it) => ({ item: it.summary.product.name, quantity: it.quantity, unit: it.summary.product.unit, category: g.category?.name ?? 'Other' })));
        if (!items.length) return { text: 'Everything to buy can come from one of the shops.', data: { items } };
        return { text: [`No shop sells these (${items.length}): give them a shop with change_item, or say which categories a shop sells with change_shop.`, ...groups.map((g) => `${g.category?.name ?? 'Other'}: ${g.items.map((it) => `${it.summary.product.name} ×${amount(it.quantity, it.summary.product.unit)}`).join(', ')}`)].join('\n'), data: { items } };
      }
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
      // Things bought in packs are bought in whole packs: "Tea bags ×1 box (80 tea bags)".
      const howMany = (it: (typeof list.groups)[number]['items'][number]) => {
        const p = it.summary.product;
        return p.pack && it.packs ? `${amount(it.packs, p.pack.name)} (${amount(it.quantity, p.unit)})` : amount(it.quantity, p.unit);
      };
      const items = list.groups.flatMap((g) => g.items.map((it) => ({ item: it.summary.product.name, quantity: it.quantity, unit: it.summary.product.unit, packs: it.packs ?? null, pack: it.summary.product.pack?.name ?? null, in_stock: it.summary.inStock, category: g.category?.name ?? 'Other' })));
      if (!items.length) return { text: `Nothing to get at ${found.name}.`, data: { shop: found.name, items } };
      const text = [`At ${found.name} (${items.length}):`, ...list.groups.map((g) => `${g.category?.name ?? 'Other'}: ${g.items.map((it) => `${it.summary.product.name} ×${howMany(it)}`).join(', ')}`)].join('\n');
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

  addManageTools(addTool, deps);
  addBrowseTools(addTool, { ...deps, line: (s) => summaryLine(ctx, s) });

  return {
    addTool,

    list(): ToolInfo[] {
      return tools.filter((t) => t.enabled()).map(({ tool, module }) => ({ name: tool.name, title: tool.title, description: tool.description, readOnly: !!tool.readOnly, destructive: !tool.readOnly && !!tool.destructive, module, input: tool.input }));
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
