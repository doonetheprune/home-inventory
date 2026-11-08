/** Products (generic items like "milk") and their variants (brands, packs, barcodes). */
import { z } from 'zod';
import { Product, StockEntry, Variant, type Movement, type ProductDetail, type ProductSummary, type StockEntryView } from '../model';
import { ProductCreate, VariantCreate, VariantPatch, type ProductFilter } from '../inputs';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { addDays, newId, roundQty, unique } from '../util';
import { sameUnit, singular } from './packs';
import { amountText, asWeight, canConvert, isCount, isLoose, pluralOf, toBoughtIn, unitKeyOf, unitOf, weightText, type UnitAmount, type Units } from './units';
import type { CoreContext } from './context';
import { eligibleShops, loadWorld, placeRef, summarise } from './world';

/** A change to a product: any of its fields, as given (defaults inside a usage are filled in). */
type ProductUpdate = Partial<z.input<typeof ProductCreate>>;

/** Fields this version of Larder knows about; a stored record may have others (from an older version, not upgraded yet). */
const KNOWN = new Set(Object.keys(Product.shape));

/** A record as an older version saved it. */
type Stored = Partial<Product> & Pick<Product, 'id' | 'name'> & { lastsDays?: number | null; autoUse?: boolean };

/**
 * 0.10.0's upgrade of one item (docs/plans/units.md): what it's bought in and what one contains,
 * from what it was counted in and the pack it came in. Sets `next`'s unit, contents, weight and
 * needsCheck, and turns its usage round; says what everything counted in the old unit is
 * multiplied by (1/20 for a box of 20 tea bags, 1000 for kg to g) and the note for its history.
 */
function boughtIn(units: Units, raw: Stored, next: Product): { factor: number; note: string } {
  const pack = raw.pack ?? null;
  const counted = units.find(raw.unit || 'each');
  const was = (raw.unit || 'each').trim();
  // #36 (never released) kept what one weighs as `size`, by what it was counted in.
  let weight = raw.size ? (asWeight(units, raw.size) as Product['weight']) : (next.weight ?? null);
  next.contents = null;
  next.needsCheck = null;
  delete (next as Partial<Product>).pack;
  delete (next as Partial<Product>).size;
  if (pack) {
    // A box of 20 tea bags: bought in boxes, each containing 20 tea bags. Things counted one by one are pieces.
    const box = units.find(pack.name);
    const inside = counted?.key === 'each' ? 'piece' : (counted?.key ?? unitKeyOf(units, was));
    next.unit = box?.key ?? unitKeyOf(units, pack.name);
    next.contents = { amount: pack.holds, unit: inside };
    const measured = counted && counted.kind !== 'count' ? asWeight(units, next.contents) : null;
    weight = measured ? (measured as Product['weight']) : weight ? { ...weight, amount: roundQty(weight.amount * pack.holds) } : null;
    next.weight = weight;
    // A usage in what it was counted in is now in what one contains: still 1 tea bag a day.
    if (next.usage && !next.usage.unit) next.usage = { ...next.usage, unit: inside };
    const unlisted = [box ? null : pack.name.trim(), counted ? null : was].find(Boolean);
    next.needsCheck = unlisted
      ? `"${unlisted}" isn't on the unit list. Pick what it's bought in, and what one contains.`
      : `Now counted in ${box!.many} of ${amountText(units, pack.holds, inside)}. If you count them one by one instead, change Bought in and correct the count.`;
    return { factor: 1 / pack.holds, note: `Now bought in ${box?.many ?? pack.name}, each containing ${amountText(units, pack.holds, inside)}` };
  }
  if (!counted) {
    next.unit = was;
    next.weight = weight;
    next.needsCheck = `"${was}" isn't on the unit list. Pick what it's bought in, and what one contains.`;
    return { factor: 1, note: '' };
  }
  next.unit = counted.key;
  if (counted.kind === 'count') {
    next.weight = weight;
    return { factor: 1, note: '' };
  }
  // Bought loose: kept in g or ml, so 1.6 kg is 1600 g. A usage in what it was counted in follows.
  next.unit = counted.kind === 'weight' ? 'g' : 'ml';
  next.weight = null;
  const f = counted.factor!;
  if (next.usage && !next.usage.unit) next.usage = { ...next.usage, amount: roundQty(next.usage.amount * f) };
  return { factor: f, note: f === 1 ? '' : `Now counted in ${next.unit}` };
}

export function createProductService(ctx: CoreContext, validateFields: (fields: Record<string, unknown>) => Record<string, unknown>) {
  async function assertRefs(p: Pick<Product, 'categoryId' | 'preferredShopIds' | 'defaultPlaceId' | 'keptInPlaceIds'>) {
    if (p.categoryId && !(await ctx.storage.categories.get(p.categoryId))) throw new NotFoundError('Category', p.categoryId);
    for (const s of p.preferredShopIds) if (!(await ctx.storage.shops.get(s))) throw new NotFoundError('Shop', s);
    if (p.defaultPlaceId && !(await ctx.storage.places.get(p.defaultPlaceId))) throw new NotFoundError('Place', p.defaultPlaceId);
    for (const id of p.keptInPlaceIds) if (!(await ctx.storage.places.get(id))) throw new NotFoundError('Place', id);
  }

  /** Until the assistant tools, modules and app give Weight, a size they give is the Weight too (the field goes with the last of them). */
  const bridged = <T extends ProductUpdate>(p: T): T => (p.size !== undefined && p.weight == null ? { ...p, weight: p.size } : p);

  /** A Weight as given (g, kg, ml, L or pints), as it's kept: in g or ml. */
  function weightIn(units: Units, w: UnitAmount | null | undefined): Product['weight'] | undefined {
    if (!w) return w;
    const kept = asWeight(units, w);
    if (!kept) throw new ValidationError(`A Weight is in g, kg, ml, L or pints, not ${unitOf(units, w.unit).many}.`);
    return kept as Product['weight'];
  }

  /**
   * What it's bought in, what one contains, its Weight and what its usage is in, checked and
   * tidied (docs/plans/units.md). `given` is what this change says; the rest is carried over from
   * `before` (null for a new item). This is the only place `weight` is written.
   */
  function checkUnits(units: Units, p: Product, given: ProductUpdate, before: Product | null): Product {
    const next = { ...p };
    const name = p.name.trim();
    // Bought in: a key from the list. An old item's unit that isn't on the list keeps working until it's changed.
    if (!before || given.unit !== undefined) {
      const u = unitOf(units, p.unit);
      next.unit = u.key;
      // Things bought loose are kept in g or ml: kg is for typing, so "low below 2 kg" is 2000 g. Numbers not given now stay as they are.
      if (u.kind !== 'count' && u.factor !== 1) {
        next.unit = u.kind === 'weight' ? 'g' : 'ml';
        const times = (n: number | null | undefined) => (n === null || n === undefined ? null : roundQty(n * u.factor!));
        if (given.minQuantity !== undefined) next.minQuantity = times(given.minQuantity);
        if (given.stockUpTo !== undefined) next.stockUpTo = times(given.stockUpTo);
        // A usage in what it's bought in is kept as it was said: 0.1 kg a day.
        if (given.usage && !given.usage.unit && next.usage) next.usage = { ...next.usage, unit: u.key };
      }
    }
    // Now bought in what one contained (boxes of 20 tea bags, now counted in tea bags): Contains goes, and a usage in tea bags is in what it's bought in.
    const had = before?.contents ?? null;
    if (before && given.unit !== undefined && given.contents === undefined && had && unitKeyOf(units, had.unit) === next.unit) next.contents = null;

    if (isLoose(units, next)) {
      if (given.contents) throw new ValidationError(`${name} is bought loose, in ${next.unit}, so one doesn't contain anything: leave Contains empty.`);
      if (given.weight) throw new ValidationError(`${name} is bought loose, in ${next.unit}, so it has no Weight: its stock is already in ${next.unit}.`);
      next.contents = null;
      next.weight = null;
    }
    // Contains: a count from the list (not each, nor what it's bought in), or a weight or volume.
    if (next.contents) {
      const c = unitOf(units, next.contents.unit);
      const box = units.find(next.unit);
      const one = box?.key === 'each' || !box ? 'one' : `a ${box.one}`;
      if (c.key === 'each') throw new ValidationError(`Say what ${one} contains with a unit from the list, e.g. 20 tea bags or 6 eggs, or leave Contains empty.`);
      if (c.key === next.unit) throw new ValidationError(`A ${c.one} can't contain ${c.many}. Say what's inside one (20 tea bags, say), or leave Contains empty.`);
      next.contents = { amount: next.contents.amount, unit: c.key };
    }
    // Weight: from Contains when that's an amount, always, so the two can't disagree; cleared when Contains stops being one; otherwise as given.
    const fromContents = next.contents && !isCount(units, next.contents.unit) ? asWeight(units, next.contents) : null;
    if (fromContents) {
      const typed = given.weight ? weightIn(units, given.weight) : null;
      if (typed && (typed.unit !== fromContents.unit || Math.abs(typed.amount - fromContents.amount) > 0.001)) {
        throw new ValidationError(`${name} contains ${amountText(units, next.contents!.amount, next.contents!.unit)}, so its Weight is ${weightText(fromContents)}, worked out from that. Change Contains instead.`);
      }
      next.weight = fromContents as Product['weight'];
    } else if (given.weight !== undefined) next.weight = weightIn(units, given.weight) ?? null;
    else if (had && !isCount(units, had.unit)) next.weight = null;

    // We use: in what it's bought in (null), in what one contains, or in a weight or volume Larder can work out.
    if (next.usage?.unit) {
      const k = unitOf(units, next.usage.unit).key;
      next.usage = { ...next.usage, unit: k === next.unit ? null : k };
      if (next.usage.unit && !canConvert(units, next, k)) {
        try {
          toBoughtIn(units, next, 1, k);
        } catch (err) {
          throw new ValidationError(`How fast it's used can't be in ${units.find(k)!.many}. ${(err as Error).message}`);
        }
      }
    }
    // "Looks right" can't clear an old unit that isn't on the list: that needs a unit from it.
    if (given.needsCheck === null && before?.needsCheck && !units.find(next.unit)) {
      throw new ValidationError(`"${next.unit}" isn't on the unit list, so ${name} can't be marked as looking right yet. Pick what it's bought in first.`);
    }
    return next;
  }

  function tidy(p: Product): Product {
    // A pack is named in the singular ("boxes" is kept as "box"), as units are said "2 boxes".
    const pack = p.pack ? { ...p.pack, name: singular(p.pack.name) } : (p.pack ?? null);
    if (pack && sameUnit(pack.name, p.unit)) throw new ValidationError(`A ${pack.name} can't come in ${pluralOf(pack.name, 2)}. Count what's inside (tea bags, say) and say how many a ${pack.name} holds.`);
    const aliases = unique(p.aliases.map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== p.name.trim().toLowerCase()));
    return { ...p, pack, name: p.name.trim(), aliases, preferredShopIds: unique(p.preferredShopIds), keptInPlaceIds: unique(p.keptInPlaceIds), fields: validateFields(p.fields) };
  }

  async function assertBarcodesFree(barcodes: string[], exceptVariantId?: string) {
    for (const code of barcodes) {
      const v = await ctx.storage.variants.findByBarcode(code);
      if (v && v.id !== exceptVariantId) {
        const owner = await ctx.storage.products.get(v.productId);
        throw new ConflictError(`Barcode ${code} already belongs to ${owner?.name ?? 'another item'}.`);
      }
    }
  }

  // Reads the product and writes it back, so callers run it in the write queue (ctx.exclusive).
  async function updateNow(id: string, raw: ProductUpdate): Promise<Product> {
    const cur = await ctx.storage.products.get(id);
    if (!cur) throw new NotFoundError('Product', id);
    const units = await ctx.units();
    const given = bridged(raw);
    const patch = { ...given, ...(given.weight !== undefined ? { weight: weightIn(units, given.weight) } : {}) };
    const fields = patch.fields ? { ...cur.fields, ...patch.fields } : cur.fields;
    const next = tidy(checkUnits(units, Product.parse({ ...cur, ...patch, fields, id, createdAt: cur.createdAt, updatedAt: ctx.now() }), patch, Product.parse(cur)));
    if (patch.inUseSince === undefined) {
      // Switching on taking them out counts from today, unless the one in use still has days left: an older
      // start was already taken out by Use, so counting from it would take the days since twice.
      if (next.usage?.auto && !cur.usage?.auto) {
        const running = next.inUseSince && addDays(next.inUseSince, next.usage.everyDays) > ctx.today();
        if (!running) next.inUseSince = ctx.today();
      }
      // With no usage any more, nothing is in use (it isn't "open" either).
      if (!next.usage && cur.usage) next.inUseSince = null;
    }
    await assertRefs(next);
    // A record an older version saved keeps what this version doesn't know (a module's change at start-up can come before upgradeStored).
    const older = Object.fromEntries(Object.entries(cur).filter(([k]) => !KNOWN.has(k)));
    await ctx.storage.products.put({ ...older, ...next });
    ctx.publish('product.updated', { id, name: next.name });
    return next;
  }

  const service = {
    async list(filter: ProductFilter = {}): Promise<ProductSummary[]> {
      const world = await loadWorld(ctx);
      const status = filter.status ?? 'all';
      return world.products
        .map((p) => summarise(world, p))
        .filter((s) => {
          if (filter.categoryId && s.product.categoryId !== filter.categoryId) return false;
          if (filter.placeId) {
            const here = (world.entriesByProduct.get(s.product.id) ?? []).some((e) => e.placeId === filter.placeId || e.currentPlaceId === filter.placeId);
            if (!here) return false;
          }
          switch (status) {
            case 'low': return s.status.low;
            case 'expiring': return s.status.expiringSoon;
            case 'out_of_place': return s.status.outOfPlace;
            case 'expected': return s.status.hasExpected;
            case 'wish': return s.product.wish;
            case 'in_stock': return !s.product.wish && s.inStock > 0;
            // Added in a hurry (scanned and gone): stock with no place, or no type yet; or an upgrade wants it looked at.
            case 'to_tidy': return !!s.product.needsCheck || (!s.product.wish && (!s.product.categoryId || (world.entriesByProduct.get(s.product.id) ?? []).some((e) => e.status === 'in_stock' && !e.placeId)));
            default: return !s.product.wish;
          }
        })
        .sort((a, b) => a.product.name.localeCompare(b.product.name, 'en-GB'));
    },

    async summary(id: string): Promise<ProductSummary> {
      const world = await loadWorld(ctx);
      const p = world.productById.get(id);
      if (!p) throw new NotFoundError('Product', id);
      return summarise(world, p);
    },

    async get(id: string): Promise<ProductDetail> {
      const world = await loadWorld(ctx);
      const product = world.productById.get(id);
      if (!product) throw new NotFoundError('Product', id);
      const [variants, history] = await Promise.all([ctx.storage.variants.listByProduct(id), ctx.storage.movements.listByProduct(id, 30)]);
      const variantName = new Map(variants.map((v) => [v.id, v.name]));
      const entries: StockEntryView[] = (world.entriesByProduct.get(id) ?? [])
        .filter((e) => e.quantity > 0)
        .map((e) => ({
          ...e,
          place: placeRef(world, e.placeId),
          currentPlace: placeRef(world, e.currentPlaceId),
          variantName: e.variantId ? (variantName.get(e.variantId) ?? null) : null,
        }))
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'in_stock' ? -1 : 1) || (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999'));
      return {
        ...summarise(world, product),
        variants: variants.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        entries,
        shops: eligibleShops(product, world.shops),
        history,
      };
    },

    async create(input: z.input<typeof ProductCreate>): Promise<Product> {
      const units = await ctx.units();
      const parsed = bridged(ProductCreate.parse(input));
      const data = { ...parsed, weight: weightIn(units, parsed.weight) ?? null };
      await assertRefs(data);
      const now = ctx.now();
      const product = tidy(checkUnits(units, Product.parse({ ...data, id: newId(), createdAt: now, updatedAt: now }), data, null));
      if (product.usage?.auto && !product.inUseSince) product.inUseSince = ctx.today();
      if (product.rechargeable && product.unit === 'each') product.unit = 'battery';
      await ctx.storage.products.put(product);
      ctx.publish('product.created', { id: product.id, name: product.name });
      return product;
    },

    async update(id: string, patch: ProductUpdate): Promise<Product> {
      return ctx.exclusive(() => updateNow(id, patch));
    },

    /**
     * Changes one module's field (`product.fields[key]`) from its current
     * value, so two changes at the same moment (two taps) both count. Other
     * modules' fields are left alone. `change` mustn't call Larder.
     */
    async updateField<T>(id: string, key: string, change: (current: T | undefined) => T): Promise<Product> {
      return ctx.exclusive(async () => {
        const cur = await ctx.storage.products.get(id);
        if (!cur) throw new NotFoundError('Product', id);
        return updateNow(id, { fields: { [key]: change(cur.fields[key] as T | undefined) } });
      });
    },

    /** Removes the product, its variants and its stock. History is kept. */
    async remove(id: string): Promise<void> {
      return ctx.exclusive(async () => {
        const cur = await ctx.storage.products.get(id);
        if (!cur) throw new NotFoundError('Product', id);
        const entries = await ctx.storage.stock.listByProduct(id);
        await ctx.storage.applyStockChanges({ remove: entries.map((e) => e.id) });
        for (const v of await ctx.storage.variants.listByProduct(id)) await ctx.storage.variants.remove(v.id);
        await ctx.storage.products.remove(id);
        ctx.publish('product.deleted', { id, name: cur.name });
      });
    },

    /** Every item's brand and pack names, by item id, oldest first (for matching receipts and orders). */
    async brandNames(): Promise<Record<string, string[]>> {
      const out: Record<string, string[]> = {};
      const all = (await ctx.storage.variants.list()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const v of all) (out[v.productId] ??= []).push(v.name);
      return out;
    },

    /**
     * Brings items saved by older versions up to date, through the Storage port (so every storage
     * adapter is covered). Safe to run at every start: a record already up to date is left alone.
     * It runs after the modules have started, so they hear `product.recounted` and rescale their
     * own numbers, and each item is read and written in the write queue. A record the current
     * schema can't read is written back as it is, never lost.
     * - 0.9.0: "Each one lasts N days" (`lastsDays`, `autoUse`) became a usage of 1 every N days;
     *   as low no longer means "runs out within the warning days", those items get a minimum that
     *   warns no later than before.
     * - 0.10.0 (docs/plans/units.md): the unit word becomes a key from the list; kg and L become g
     *   and ml; a pack is turned round (80 tea bags in boxes of 20 are 4 boxes, each containing 20
     *   tea bags); #36's `size` becomes `weight`. Stock, orders, the minimum, the stock-up amount
     *   and history follow. A unit that isn't on the list is kept, and the item flagged
     *   (`needsCheck`) for the owner to fix, as is a pack turned round.
     */
    async upgradeStored(): Promise<number> {
      const [all, categories, household, units] = await Promise.all([ctx.storage.products.list(), ctx.storage.categories.list(), ctx.household(), ctx.units()]);
      let changed = 0;
      for (const { id } of all) {
        const recounted = await ctx.exclusive(async () => {
          const raw = (await ctx.storage.products.get(id)) as Stored | null;
          // Up to date: saved by this version (it knows needsCheck), with nothing older left.
          if (!raw || ('needsCheck' in raw && !('lastsDays' in raw) && !('autoUse' in raw) && !raw.pack && !raw.size)) return null;
          changed++;
          const { lastsDays, autoUse, ...rest } = raw;
          const next = { ...rest, usage: rest.usage ?? null, inUseSince: rest.inUseSince ?? null } as Product;
          if (lastsDays && !rest.usage) {
            next.usage = { amount: 1, everyDays: lastsDays, auto: !!autoUse, unit: null };
            const warn = categories.find((c) => c.id === rest.categoryId)?.warnDays ?? household.expiryWarningDays;
            next.minQuantity = Math.max(rest.minQuantity ?? 0, Math.floor(warn / lastsDays) + 1);
          }
          const change = 'needsCheck' in raw && !raw.pack && !raw.size ? { factor: 1, note: '' } : boughtIn(units, raw, next);
          const write = (p: Product) => {
            const parsed = Product.safeParse(p);
            return parsed.success ? parsed.data : p;
          };
          if (change.factor === 1) {
            await ctx.storage.products.put(write(next));
            return null;
          }
          // Everything counted in the old unit is now in what it's bought in: 80 tea bags are 4 boxes.
          const f = change.factor;
          const times = (n: number | null | undefined) => (n === null || n === undefined ? null : roundQty(n * f));
          next.minQuantity = times(next.minQuantity);
          next.stockUpTo = times(next.stockUpTo);
          const entries = (await ctx.storage.stock.listByProduct(id)).map((e) => StockEntry.parse({
            ...e, quantity: roundQty(e.quantity * f),
            // Prices are kept per one: per tea bag before, per box now.
            expected: e.expected ? { ...e.expected, unitPrice: e.expected.unitPrice == null ? null : Math.round((e.expected.unitPrice / f) * 1_000_000) / 1_000_000 } : null,
          }));
          const note: Movement = { id: newId(), productId: id, entryId: null, kind: 'adjust', quantity: 0, fromPlaceId: null, toPlaceId: null, note: change.note, userId: null, at: ctx.now() };
          await ctx.storage.applyStockChanges({ put: entries, products: [write(next)], rescale: [{ productId: id, factor: f }], movements: [note] });
          return { productId: id, name: next.name, from: raw.unit ?? 'each', to: next.unit, factor: f };
        });
        if (recounted) ctx.publish('product.recounted', recounted);
      }
      return changed;
    },

    async setOnList(id: string, onShoppingList: boolean): Promise<Product> {
      return service.update(id, { onShoppingList });
    },

    async addVariant(productId: string, input: z.input<typeof VariantCreate>): Promise<Variant> {
      if (!(await ctx.storage.products.get(productId))) throw new NotFoundError('Product', productId);
      const data = VariantCreate.parse(input);
      const barcodes = unique(data.barcodes.map((b) => b.trim()).filter(Boolean));
      await assertBarcodesFree(barcodes);
      const variant = Variant.parse({ ...data, barcodes, id: newId(), productId, createdAt: ctx.now() });
      await ctx.storage.variants.put(variant);
      ctx.publish('product.updated', { id: productId });
      return variant;
    },

    async updateVariant(variantId: string, patch: z.infer<typeof VariantPatch>): Promise<Variant> {
      const cur = await ctx.storage.variants.get(variantId);
      if (!cur) throw new NotFoundError('Variant', variantId);
      const barcodes = patch.barcodes ? unique(patch.barcodes.map((b) => b.trim()).filter(Boolean)) : cur.barcodes;
      await assertBarcodesFree(barcodes, variantId);
      const next = Variant.parse({ ...cur, ...patch, barcodes, id: cur.id, productId: cur.productId, createdAt: cur.createdAt });
      await ctx.storage.variants.put(next);
      ctx.publish('product.updated', { id: cur.productId });
      return next;
    },

    async removeVariant(variantId: string): Promise<void> {
      const cur = await ctx.storage.variants.get(variantId);
      if (!cur) throw new NotFoundError('Variant', variantId);
      const entries = (await ctx.storage.stock.listByProduct(cur.productId)).filter((e) => e.variantId === variantId);
      if (entries.length) await ctx.storage.applyStockChanges({ put: entries.map((e) => ({ ...e, variantId: null })) });
      await ctx.storage.variants.remove(variantId);
      ctx.publish('product.updated', { id: cur.productId });
    },

    async addNfcTag(productId: string, tag: string): Promise<Product> {
      const t = tag.trim();
      if (!t) throw new ValidationError('The NFC tag id is empty.');
      const other = (await ctx.storage.products.findByNfcTag(t)) ?? (await ctx.storage.places.findByNfcTag(t));
      if (other && other.id !== productId) throw new ConflictError(`That tag is already linked to ${other.name}.`);
      const cur = await ctx.storage.products.get(productId);
      if (!cur) throw new NotFoundError('Product', productId);
      return service.update(productId, { nfcTags: unique([...cur.nfcTags, t]) });
    },
  };
  return service;
}
