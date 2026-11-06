/**
 * Assistant tools for looking after Larder's own records, so an assistant can
 * do what the app does: shops, places and categories, changing or removing
 * an item, brands and barcodes, correcting a batch, and recent history.
 *
 * Kept out of the app's reach on purpose: accounts, access tokens, household
 * settings, backups, photos, NFC tags and printing.
 */
import { z } from 'zod';
import { ConflictError, LarderError, NotFoundError, ValidationError } from '../errors';
import { IsoDate, type Category, type Movement, type Place, type Shop } from '../model';
import type { AssistantTool } from './assistant';
import { SHOP_PRESETS, type createCategoryService, type createPlaceService, type createShopService } from './catalogue';
import type { CoreContext } from './context';
import type { createProductService } from './products';
import { AmbiguousError, type Resolver } from './resolve';
import type { createStockService } from './stock';
import { amount, andList, daysBetween } from '../util';

type AddTool = <I extends z.ZodObject>(tool: AssistantTool<I>) => void;

export interface ManageDeps {
  ctx: CoreContext;
  products: ReturnType<typeof createProductService>;
  stock: ReturnType<typeof createStockService>;
  categories: ReturnType<typeof createCategoryService>;
  shops: ReturnType<typeof createShopService>;
  places: ReturnType<typeof createPlaceService>;
  resolve: Resolver;
}

const isPreset = (name: string) => SHOP_PRESETS.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());

/**
 * The resolver's lookups, with what to do when the thing doesn't exist yet:
 * the assistant offers to add it, rather than leaving it out or guessing.
 */
export function finders(deps: Pick<ManageDeps, 'categories' | 'resolve'>) {
  const { categories, resolve } = deps;
  const hint = async <T>(find: () => Promise<T>, tip: string): Promise<T> => {
    try {
      return await find();
    } catch (err) {
      if (err instanceof LarderError && err.code === 'not_found') throw new LarderError(`${err.message} ${tip}`, 404, 'not_found');
      throw err;
    }
  };
  return {
    shop: (ref: string) => hint(() => resolve.shop(ref), isPreset(ref)
      ? `${isPreset(ref)!.name} is one of the common UK shops: ask if they want it added with add_shop (it comes with what it usually sells), then try again.`
      : 'Ask if they want it added with add_shop, then try again.'),
    place: (ref: string) => hint(() => resolve.place(ref), 'Ask if they want it added with add_place, then try again.'),
    async category(ref: string): Promise<Category> {
      const cats = await categories.list();
      const want = ref.trim().toLowerCase();
      const cat = cats.find((c) => c.id === ref || c.name.toLowerCase() === want);
      if (!cat) throw new ValidationError(`There's no category called "${ref}". The categories are: ${andList(cats.map((c) => c.name))}. Use one of those, or ask if they want it added with add_category.`);
      return cat;
    },
  };
}

const MOVEMENT_WORDS: Record<Movement['kind'], string> = {
  add: 'added', use: 'used', move: 'moved', return: 'put back', expect: 'ordered', arrive: 'arrived',
  adjust: 'corrected', remove: 'removed', flat: 'went flat', charged: 'charged', finish: 'finished the open one',
};

export function addManageTools(addTool: AddTool, deps: ManageDeps): void {
  const { ctx, products, stock, categories, shops, places, resolve } = deps;
  const find = finders(deps);
  const sellsText = async (shop: Shop) => {
    const cats = new Map((await categories.list()).map((c) => [c.id, c.name]));
    const names = shop.sells.map((id) => cats.get(id)).filter((n): n is string => !!n);
    return names.length ? `sells ${andList(names)}` : 'sells nothing in particular (only items set to buy there)';
  };
  const categoryIds = async (names: string[]) => Promise.all(names.map(async (n) => (await find.category(n)).id));
  const pathOf = async (place: Place) => (await places.list()).find((p) => p.id === place.id)?.path ?? place.name;

  /* -------------------------------- shops ------------------------------- */

  addTool({
    name: 'list_shops', title: 'List shops', readOnly: true,
    description: 'The shops set up in Larder and the categories each one sells (items with no preferred shop appear on the lists of shops that sell their category).',
    input: z.object({}),
    async run() {
      const list = await shops.list();
      if (!list.length) return { text: `There are no shops set up in Larder yet. Add one with add_shop; common UK shops (${andList(SHOP_PRESETS.map((p) => p.name))}) come with what they usually sell.`, data: { shops: [] } };
      const lines = await Promise.all(list.map(async (s) => `- ${s.name}: ${await sellsText(s)}${s.notes ? `. ${s.notes.slice(0, 120)}` : ''}`));
      return { text: lines.join('\n'), data: { shops: list.map((s) => ({ id: s.id, name: s.name, notes: s.notes })) } };
    },
  });

  addTool({
    name: 'add_shop', title: 'Add a shop',
    description: 'Add a shop to buy things from. Common UK shops (Tesco, Aldi, Screwfix…) come with the categories they usually sell; for others, say which categories it sells.',
    input: z.object({
      name: z.string().min(1).max(60).describe('e.g. "Tesco" or "Corner shop"'),
      sells: z.array(z.string().max(60)).max(20).optional().describe('Categories it sells, e.g. ["Food", "Household"]. Leave out for a common shop to use what it usually sells'),
      notes: z.string().max(2000).optional(),
    }),
    async run({ name, sells, notes }) {
      const preset = isPreset(name);
      let shop = preset && !sells ? await shops.addPreset(preset.name) : await shops.create({ name: name.trim(), sells: await categoryIds(sells ?? []) });
      if (notes) shop = await shops.update(shop.id, { notes });
      return { text: `Added ${shop.name}, which ${await sellsText(shop)}.`, data: { id: shop.id, name: shop.name } };
    },
  });

  addTool({
    name: 'change_shop', title: 'Change a shop', destructive: true,
    description: 'Rename a shop, change which categories it sells (the list given replaces the old one), or its notes.',
    input: z.object({
      shop: z.string().min(1).max(80).describe('The shop, e.g. "tesco"'),
      name: z.string().min(1).max(60).optional().describe('New name'),
      sells: z.array(z.string().max(60)).max(20).optional().describe('Every category it sells, e.g. ["Food", "Pets"]'),
      notes: z.string().max(2000).optional(),
    }),
    async run(i) {
      const shop = await find.shop(i.shop);
      if (i.name && i.name.trim().toLowerCase() !== shop.name.toLowerCase() && (await shops.list()).some((s) => s.name.toLowerCase() === i.name!.trim().toLowerCase())) {
        throw new ConflictError(`There's already a shop called ${i.name.trim()}.`);
      }
      const next = await shops.update(shop.id, {
        ...(i.name ? { name: i.name.trim() } : {}), ...(i.sells ? { sells: await categoryIds(i.sells) } : {}), ...(i.notes !== undefined ? { notes: i.notes } : {}),
      });
      return { text: `${next.name} ${await sellsText(next)}.`, data: { id: next.id, name: next.name } };
    },
  });

  addTool({
    name: 'remove_shop', title: 'Remove a shop', destructive: true,
    description: 'Remove a shop. Items that were bought there go back to "any shop that sells their category".',
    input: z.object({ shop: z.string().min(1).max(80) }),
    async run({ shop }) {
      const s = await find.shop(shop);
      await shops.remove(s.id);
      return { text: `Removed ${s.name}.`, data: { id: s.id, name: s.name } };
    },
  });

  /* ------------------------------- places ------------------------------- */

  addTool({
    name: 'list_places', title: 'List places', readOnly: true,
    description: 'Every place in the house, nested (Garage › Racking › G2-4), with label codes and how many items are in each.',
    input: z.object({}),
    async run() {
      const tree = await places.tree();
      if (!tree.length) return { text: 'There are no places set up in Larder yet. Add one with add_place.', data: { places: [] } };
      const lines: string[] = [];
      const flat: Array<{ id: string; name: string; path: string; code: string | null; items: number }> = [];
      const walk = (nodes: typeof tree, depth: number) => {
        for (const n of nodes) {
          lines.push(`${'  '.repeat(depth)}- ${n.place.name}${n.place.code ? ` (${n.place.code})` : ''}: ${n.itemCount} item${n.itemCount === 1 ? '' : 's'}`);
          flat.push({ id: n.place.id, name: n.place.name, path: n.path, code: n.place.code, items: n.itemCount });
          walk(n.children, depth + 1);
        }
      };
      walk(tree, 0);
      return { text: lines.join('\n'), data: { places: flat } };
    },
  });

  addTool({
    name: 'add_place', title: 'Add a place',
    description: 'Add somewhere things live: a room, cupboard, shelf or box, optionally inside another place (a shelf inside the pantry). A code like "G2-4" is printed on its label.',
    input: z.object({
      name: z.string().min(1).max(80).describe('e.g. "Pantry" or "Top shelf"'),
      inside: z.string().max(200).optional().describe('The place it is in, e.g. "Kitchen"'),
      code: z.string().max(20).optional().describe('Short label code, unique, e.g. "P1"'),
      notes: z.string().max(2000).optional(),
    }),
    async run(i) {
      const parent = i.inside ? await find.place(i.inside) : null;
      const place = await places.create({ name: i.name.trim(), parentId: parent?.id ?? null, code: i.code ?? null, notes: i.notes ?? '' });
      return { text: `Added ${await pathOf(place)}${place.code ? ` (code ${place.code})` : ''}.`, data: { id: place.id, name: place.name } };
    },
  });

  addTool({
    name: 'add_storage_grid', title: 'Add grid storage',
    description: 'Set up shelving or racking with numbered spots in one go: e.g. 4 shelves of 6 boxes with prefix "G" makes G1-1 to G4-6.',
    input: z.object({
      name: z.string().min(1).max(80).describe('e.g. "Garage racking"'),
      inside: z.string().max(200).optional().describe('The place it is in, e.g. "Garage"'),
      prefix: z.string().min(1).max(4).regex(/^[A-Za-z0-9]+$/, 'Use letters and numbers only').describe('Code prefix, e.g. "G"'),
      rows: z.number().int().min(1).max(20).describe('How many shelves'),
      columns: z.number().int().min(1).max(20).describe('How many spots on each shelf'),
      first_row: z.enum(['top', 'bottom']).optional().describe('Whether shelf 1 is the top or the bottom one (default top)'),
      row_label: z.string().min(1).max(20).optional().describe('What a row is called (default Shelf)'),
      column_label: z.string().min(1).max(20).optional().describe('What a spot is called (default box)'),
    }),
    async run(i) {
      const parent = i.inside ? await find.place(i.inside) : null;
      const { container, places: made } = await places.createGrid({
        name: i.name.trim(), parentId: parent?.id ?? null, prefix: i.prefix, rows: i.rows, columns: i.columns,
        ...(i.first_row ? { firstRow: i.first_row } : {}), ...(i.row_label ? { rowLabel: i.row_label } : {}), ...(i.column_label ? { columnLabel: i.column_label } : {}),
      });
      return { text: `Added ${await pathOf(container)} with ${made.length} spots, ${made[0]?.code} to ${made.at(-1)?.code}.`, data: { id: container.id, name: container.name, codes: made.map((p) => p.code) } };
    },
  });

  addTool({
    name: 'change_place', title: 'Change a place', destructive: true,
    description: 'Rename a place, move it inside another place (or to the top level), or change its label code or notes.',
    input: z.object({
      place: z.string().min(1).max(200).describe('The place, by name, code or path'),
      name: z.string().min(1).max(80).optional().describe('New name'),
      inside: z.string().max(200).nullable().optional().describe('The place it is now in; null for the top level'),
      code: z.string().max(20).nullable().optional().describe('New label code; null to remove it'),
      notes: z.string().max(2000).optional(),
    }),
    async run(i) {
      const place = await find.place(i.place);
      const parentId = i.inside === undefined ? undefined : i.inside === null ? null : (await find.place(i.inside)).id;
      const next = await places.update(place.id, {
        ...(i.name ? { name: i.name.trim() } : {}), ...(parentId !== undefined ? { parentId } : {}),
        ...(i.code !== undefined ? { code: i.code } : {}), ...(i.notes !== undefined ? { notes: i.notes } : {}),
      });
      return { text: `${await pathOf(next)}${next.code ? ` (code ${next.code})` : ''} is updated.`, data: { id: next.id, name: next.name } };
    },
  });

  addTool({
    name: 'remove_place', title: 'Remove a place', destructive: true,
    description: 'Remove an empty place. Places inside it move up a level; items that usually lived there no longer have a usual place.',
    input: z.object({ place: z.string().min(1).max(200) }),
    async run({ place }) {
      const p = await find.place(place);
      const path = await pathOf(p);
      await places.remove(p.id);
      return { text: `Removed ${path}.`, data: { id: p.id, name: p.name } };
    },
  });

  /* ----------------------------- categories ----------------------------- */

  addTool({
    name: 'list_categories', title: 'List categories', readOnly: true,
    description: 'The household\'s categories (Food, Household, Tools & DIY…), with how many items are in each.',
    input: z.object({}),
    async run() {
      const [cats, all, settings] = await Promise.all([categories.list(), ctx.storage.products.list(), ctx.household()]);
      const count = (id: string) => all.filter((p) => p.categoryId === id).length;
      const text = cats.map((c) => `- ${c.name}: ${count(c.id)} item${count(c.id) === 1 ? '' : 's'}, warns ${c.warnDays ?? settings.expiryWarningDays} days before expiry`).join('\n');
      return { text, data: { categories: cats.map((c) => ({ id: c.id, name: c.name, items: count(c.id), warn_days: c.warnDays })) } };
    },
  });

  addTool({
    name: 'add_category', title: 'Add a category',
    description: 'Add a category to group items by, e.g. "Garden". Shops then need it in what they sell (change_shop) to list its items.',
    input: z.object({
      name: z.string().min(1).max(60),
      warn_days: z.number().int().min(0).max(365).optional().describe('Days before expiry to warn (default the household\'s)'),
    }),
    async run({ name, warn_days }) {
      if ((await categories.list()).some((c) => c.name.toLowerCase() === name.trim().toLowerCase())) throw new ConflictError(`There's already a category called ${name.trim()}.`);
      const cat = await categories.create({ name: name.trim(), warnDays: warn_days ?? null });
      return { text: `Added the ${cat.name} category.`, data: { id: cat.id, name: cat.name } };
    },
  });

  addTool({
    name: 'change_category', title: 'Change a category', destructive: true,
    description: 'Rename a category, or change how many days before expiry (or running out, for things used one after another) its items are flagged.',
    input: z.object({
      category: z.string().min(1).max(60),
      name: z.string().min(1).max(60).optional().describe('New name'),
      warn_days: z.number().int().min(0).max(365).nullable().optional().describe('Days before expiry to warn; null for the household default'),
    }),
    async run(i) {
      const cat = await find.category(i.category);
      const next = await categories.update(cat.id, { ...(i.name ? { name: i.name.trim() } : {}), ...(i.warn_days !== undefined ? { warnDays: i.warn_days } : {}) });
      return { text: `${next.name} is updated.`, data: { id: next.id, name: next.name } };
    },
  });

  addTool({
    name: 'remove_category', title: 'Remove a category', destructive: true,
    description: 'Remove a category that no items use (move them to another category first with change_item).',
    input: z.object({ category: z.string().min(1).max(60) }),
    async run({ category }) {
      const cat = await find.category(category);
      await categories.remove(cat.id);
      return { text: `Removed the ${cat.name} category.`, data: { id: cat.id, name: cat.name } };
    },
  });

  /* -------------------------------- items ------------------------------- */

  const Item = z.string().min(1).max(200).describe('The item, by name or alias, barcode, shop code or id');

  addTool({
    name: 'change_item', title: 'Change an item', destructive: true,
    description: 'Change anything about an item: name, category, unit, other names, when it counts as low, how many to stock up to, shelf life, how long each one lasts once started (when the one in use was started, and whether the next starts automatically), usual place, places it\'s no longer kept in, which shops to buy it from, notes, links, wish list or rechargeable. Only the fields given change.',
    input: z.object({
      item: Item,
      name: z.string().min(1).max(120).optional().describe('New name'),
      category: z.string().max(60).nullable().optional().describe('One of the household\'s categories; null for none'),
      unit: z.string().min(1).max(20).optional().describe('What it\'s counted in, e.g. roll, tin, kg'),
      aliases: z.array(z.string().max(60)).max(10).optional().describe('Every other name people use (replaces the old list)'),
      minimum: z.number().min(0).nullable().optional().describe('Running low below this many; null to never count as low'),
      stock_up_to: z.number().min(0).nullable().optional().describe('When buying more, top up to this many (e.g. minimum 4, stock up to 12); null to buy just back to the minimum'),
      shelf_life_days: z.number().int().positive().nullable().optional().describe('How long it keeps, or how often a renewal renews; null for none'),
      lasts_days: z.number().int().positive().max(3650).nullable().optional().describe('For things used one at a time, one after another (a glucose sensor, contact lenses): how many days each one lasts once started; null for none'),
      in_use_since: IsoDate.nullable().optional().describe('When the one in use was started (YYYY-MM-DD); null if none is in use. use_stock sets it to today, so this is for a different day'),
      auto_use: z.boolean().optional().describe('True to start the next one automatically (taking it out of stock) when the one in use runs out'),
      usual_place: z.string().max(200).nullable().optional().describe('Where it usually lives; null for nowhere in particular. This doesn\'t move stock (use move_item)'),
      shops: z.array(z.string().max(80)).max(10).optional().describe('Every shop to buy it from (replaces the old list); [] for any shop that sells its category'),
      notes: z.string().max(5000).optional(),
      wish_list: z.boolean().optional().describe('True if it\'s wanted but the house has none'),
      rechargeable: z.boolean().optional().describe('True for rechargeable batteries and similar (stock is charged or flat)'),
      links: z.array(z.string().url().max(2000)).max(10).optional().describe('Every web page for it (replaces the old list); [] for none'),
      not_kept_in: z.array(z.string().max(200)).max(20).optional().describe('Places it\'s no longer kept in (it has none there now): they stop listing it at 0'),
    }),
    async run(i) {
      const p = await resolve.product(i.item);
      if (i.name && i.name.trim().toLowerCase() !== p.name.toLowerCase()) {
        const other = (await ctx.storage.products.list()).find((x) => x.id !== p.id && x.name.toLowerCase() === i.name!.trim().toLowerCase());
        if (other) throw new ConflictError(`There's already an item called ${other.name}.`);
      }
      const categoryId = i.category === undefined ? undefined : i.category === null ? null : (await find.category(i.category)).id;
      const defaultPlaceId = i.usual_place === undefined ? undefined : i.usual_place === null ? null : (await find.place(i.usual_place)).id;
      const preferredShopIds = i.shops ? await Promise.all(i.shops.map(async (s) => (await find.shop(s)).id)) : undefined;
      const leaving = i.not_kept_in ? await Promise.all(i.not_kept_in.map(async (x) => find.place(x))) : [];
      if (leaving.length) {
        const here = (await products.get(p.id)).stockByPlace.filter((x) => leaving.some((l) => l.id === x.id) && x.quantity > 0);
        if (here.length) throw new ValidationError(`${p.name} still has stock in ${andList(here.map((x) => x.path))}. Move it (move_item, permanent) or use it up first.`);
      }
      const next = await products.update(p.id, {
        ...(i.name ? { name: i.name.trim() } : {}), ...(categoryId !== undefined ? { categoryId } : {}), ...(i.unit ? { unit: i.unit } : {}),
        ...(i.aliases ? { aliases: i.aliases } : {}), ...(i.minimum !== undefined ? { minQuantity: i.minimum } : {}),
        ...(i.stock_up_to !== undefined ? { stockUpTo: i.stock_up_to } : {}),
        ...(i.shelf_life_days !== undefined ? { shelfLifeDays: i.shelf_life_days } : {}),
        ...(i.lasts_days !== undefined ? { lastsDays: i.lasts_days } : {}), ...(i.in_use_since !== undefined ? { inUseSince: i.in_use_since } : {}),
        ...(i.auto_use !== undefined ? { autoUse: i.auto_use } : {}),
        ...(defaultPlaceId !== undefined ? { defaultPlaceId } : {}),
        ...(preferredShopIds ? { preferredShopIds } : {}), ...(i.notes !== undefined ? { notes: i.notes } : {}),
        ...(i.wish_list !== undefined ? { wish: i.wish_list } : {}), ...(i.rechargeable !== undefined ? { rechargeable: i.rechargeable } : {}),
        ...(i.links ? { links: i.links.map((url) => ({ url, title: p.links.find((l) => l.url === url)?.title ?? '' })) } : {}),
        ...(leaving.length ? { keptInPlaceIds: (p.keptInPlaceIds ?? []).filter((id) => !leaving.some((l) => l.id === id)) } : {}),
      });
      const d = await products.get(next.id);
      const said: string[] = [];
      if (categoryId !== undefined) said.push(d.category ? `in ${d.category.name}` : 'no category');
      if (preferredShopIds) said.push(d.product.preferredShopIds.length ? `bought from ${andList(d.shops.map((s) => s.name))}` : 'from any shop that sells it');
      if (defaultPlaceId !== undefined) said.push(defaultPlaceId ? `usually lives in ${(await places.list()).find((x) => x.id === defaultPlaceId)?.path}` : 'no usual place');
      if (i.minimum !== undefined) said.push(i.minimum === null ? 'never counts as low' : `low below ${amount(i.minimum, next.unit)}`);
      if (i.stock_up_to !== undefined) said.push(i.stock_up_to === null ? 'buy back up to the minimum' : `stock up to ${amount(i.stock_up_to, next.unit)}`);
      if (i.lasts_days !== undefined) said.push(i.lasts_days === null ? 'no set time once started' : `each lasts ${i.lasts_days} day${i.lasts_days === 1 ? '' : 's'} once started`);
      if (i.in_use_since !== undefined) said.push(i.in_use_since ? `the one in use was started on ${i.in_use_since}` : 'none in use');
      if (leaving.length) said.push(`no longer kept in ${andList(leaving.map((l) => l.name))}`);
      if (i.links) said.push(i.links.length ? `${i.links.length} link${i.links.length === 1 ? '' : 's'}` : 'no links');
      if (i.auto_use !== undefined) said.push(i.auto_use ? 'the next one starts automatically when one runs out' : 'each one is started with use_stock');
      if (d.runsOutOn && (i.lasts_days || i.in_use_since !== undefined)) said.push(`enough until ${d.runsOutOn}${d.status.runningOut ? ', so it\'s low' : ''}`);
      return { text: `${next.name} is updated${said.length ? `: ${said.join(', ')}` : ''}.`, data: { id: next.id, name: next.name } };
    },
  });

  addTool({
    name: 'remove_item', title: 'Remove an item', destructive: true,
    description: 'Remove an item from Larder completely, with all its stock, brands and barcodes. To record using some up, use use_stock instead.',
    input: z.object({ item: Item }),
    async run({ item }) {
      const p = await resolve.product(item);
      const s = await products.summary(p.id);
      await products.remove(p.id);
      return { text: `Removed ${p.name}${s.inStock ? ` and its ${amount(s.inStock, p.unit)} in stock` : ''}.`, data: { id: p.id, name: p.name } };
    },
  });

  addTool({
    name: 'add_brand', title: 'Add a brand or barcode',
    description: 'Add a brand or pack of an item (e.g. "Andrex 9-pack"), with its barcode so scanning it finds the item, and/or a shop\'s product code for matching order emails.',
    input: z.object({
      item: Item,
      name: z.string().min(1).max(160).optional().describe('The brand or pack, e.g. "Heinz 400 g". Defaults to the item\'s name'),
      barcode: z.string().min(1).max(64).optional(),
      shop: z.string().max(80).optional().describe('The shop a shop code belongs to'),
      shop_code: z.string().max(40).optional().describe('That shop\'s product code'),
    }),
    async run(i) {
      if (!i.barcode && !i.name && !i.shop_code) throw new ValidationError('Give a brand name, a barcode or a shop code.');
      const p = await resolve.product(i.item);
      const shop = i.shop ? await find.shop(i.shop) : null;
      if (i.shop_code && !shop) throw new ValidationError('A shop code needs the shop it belongs to.');
      const v = await products.addVariant(p.id, { name: i.name?.trim() || p.name, barcodes: i.barcode ? [i.barcode] : [], shopCodes: i.shop_code && shop ? [{ shopId: shop.id, code: i.shop_code }] : [] });
      const extras = [i.barcode ? `barcode ${i.barcode}` : '', shop && i.shop_code ? `${shop.name} code ${i.shop_code}` : ''].filter(Boolean);
      return { text: `Added ${v.name} to ${p.name}${extras.length ? ` with ${andList(extras)}` : ''}.`, data: { id: v.id, name: v.name, item: p.name } };
    },
  });

  addTool({
    name: 'remove_brand', title: 'Remove a brand or barcode', destructive: true,
    description: 'Remove one brand or pack (and its barcodes) from an item. Its stock stays.',
    input: z.object({ item: Item, brand: z.string().min(1).max(160).describe('The brand or pack name, or one of its barcodes') }),
    async run({ item, brand }) {
      const p = await resolve.product(item);
      const variants = await ctx.storage.variants.listByProduct(p.id);
      if (!variants.length) throw new NotFoundError('Brand', `${p.name} has no brands or barcodes`);
      const v = variants.find((x) => x.barcodes.includes(brand.trim())) ?? resolve.among('brand', brand, variants);
      await products.removeVariant(v.id);
      return { text: `Removed ${v.name} from ${p.name}.`, data: { id: v.id, name: v.name, item: p.name } };
    },
  });

  addTool({
    name: 'correct_stock', title: 'Correct stock', destructive: true,
    description: 'Fix what Larder has for an item when it\'s wrong: how many there really are, or an expiry date, or remove a batch that isn\'t there. If it has more than one batch, say which by its place or expiry date (get_item lists them).',
    input: z.object({
      item: Item,
      place: z.string().max(200).optional().describe('Which batch: the place it\'s in'),
      expires_on: z.string().max(10).optional().describe('Which batch: its current expiry date (YYYY-MM-DD)'),
      quantity: z.number().min(0).optional().describe('How many there really are in that batch'),
      new_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional().describe('Its real expiry date (YYYY-MM-DD); null for none'),
      remove: z.boolean().optional().describe('True to remove the batch altogether'),
    }),
    async run(i) {
      if (i.quantity === undefined && i.new_expiry === undefined && !i.remove) throw new ValidationError('Say what to correct: quantity, new_expiry or remove.');
      const p = await resolve.product(i.item);
      const d = await products.get(p.id);
      const describe = (e: (typeof d.entries)[number]) => `${amount(e.quantity, p.unit)} in ${(e.currentPlace ?? e.place)?.path ?? 'no place'}${e.expiresOn ? `, expires ${e.expiresOn}` : ''}`;
      const batches = d.entries.filter((e) => e.status === 'in_stock');
      if (!batches.length) throw new LarderError(`${p.name} has no stock to correct. Use add_stock to add some.`, 404, 'not_found');
      const placeId = i.place ? (await find.place(i.place)).id : null;
      const chosen = batches.filter((e) => (!placeId || e.placeId === placeId || e.currentPlaceId === placeId) && (!i.expires_on || e.expiresOn === i.expires_on));
      if (!chosen.length) throw new LarderError(`None of ${p.name}'s batches match. It has: ${batches.map(describe).join('; ')}.`, 404, 'not_found');
      if (chosen.length > 1) throw new AmbiguousError(`${p.name} has ${chosen.length} batches. Say which by place or expiry date.`, chosen.map(describe));
      const entry = chosen[0]!;
      const s = i.remove || i.quantity === 0
        ? await stock.removeEntry(entry.id)
        : await stock.updateEntry(entry.id, { ...(i.quantity !== undefined ? { quantity: i.quantity } : {}), ...(i.new_expiry !== undefined ? { expiresOn: i.new_expiry } : {}) });
      return { text: `${p.name}: ${i.remove || i.quantity === 0 ? `removed the batch of ${describe(entry)}` : 'corrected'}. ${amount(s.inStock, p.unit)} in stock.`, data: { id: p.id, name: p.name, in_stock: s.inStock } };
    },
  });

  /* ------------------------------ history ------------------------------- */

  addTool({
    name: 'deliveries', title: 'Deliveries on the way', readOnly: true,
    description: 'Orders that haven\'t arrived yet, by where they\'re coming from, with when they\'re due; and pending orders waiting to be confirmed (confirm_order) or removed (cancel_order).',
    input: z.object({}),
    async run() {
      const [list, pending] = await Promise.all([stock.deliveries(), stock.pendingOrders()]);
      if (!list.length && !pending.length) return { text: 'Nothing is on the way.', data: { deliveries: [], pending: [] } };
      const lines = list.map((d) => `- ${d.source}: ${d.itemCount} item${d.itemCount === 1 ? '' : 's'}${d.eta ? `, due ${d.eta} (${daysBetween(ctx.today(), d.eta) < 0 ? 'late' : `in ${daysBetween(ctx.today(), d.eta)} days`})` : ''}`);
      if (pending.length) lines.push('Pending orders (not confirmed yet):', ...pending.map((d) => `- ${d.source}: ${d.itemCount} item${d.itemCount === 1 ? '' : 's'}${d.since ? `, since ${d.since.slice(0, 10)}` : ''}`));
      return { text: lines.join('\n') || 'Nothing is on the way.', data: { deliveries: list.map((d) => ({ source: d.source, eta: d.eta, items: d.itemCount, quantity: d.quantity })), pending: pending.map((d) => ({ source: d.source, since: d.since, items: d.itemCount, quantity: d.quantity })) } };
    },
  });

  addTool({
    name: 'recent_changes', title: 'Recent changes', readOnly: true,
    description: 'What changed in stock lately, newest first: added, used, moved, arrived, corrected. Useful for "who used the last of the milk?" or "when did we last buy batteries?".',
    input: z.object({
      item: Item.optional().describe('Only this item'),
      limit: z.number().int().min(1).max(100).optional().describe('How many changes (default 20)'),
    }),
    async run({ item, limit }) {
      const p = item ? await resolve.product(item) : null;
      const moves = p ? (await products.get(p.id)).history.slice(0, limit ?? 20) : await ctx.storage.movements.listRecent(limit ?? 20);
      if (!moves.length) return { text: p ? `No changes recorded for ${p.name}.` : 'No changes recorded yet.', data: { changes: [] } };
      const [all, placeList] = await Promise.all([ctx.storage.products.list(), places.list()]);
      const names = new Map(all.map((x) => [x.id, x]));
      const paths = new Map(placeList.map((x) => [x.id, x.path]));
      const rows = moves.map((m) => {
        const prod = names.get(m.productId);
        const to = m.toPlaceId ? paths.get(m.toPlaceId) : null;
        return { at: m.at, item: prod?.name ?? 'a removed item', change: MOVEMENT_WORDS[m.kind], quantity: m.quantity, unit: prod?.unit ?? 'each', place: to ?? null, note: m.note };
      });
      const text = rows.map((r) => `- ${r.at.slice(0, 16).replace('T', ' ')}: ${r.item} ${r.change}${r.quantity ? `${r.change === 'corrected' ? ` by ${r.quantity > 0 ? '+' : '−'}` : ' '}${amount(Math.abs(r.quantity), r.unit)}` : ''}${r.place ? ` to ${r.place}` : ''}${r.note ? ` (${r.note})` : ''}`).join('\n');
      return { text, data: { changes: rows } };
    },
  });
}
