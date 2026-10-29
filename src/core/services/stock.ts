/**
 * Stock changes: add, use, move, return, expected deliveries, rechargeables.
 *
 * Every operation works on a copy of one product's entries, tidies them
 * (merging identical batches, dropping empty ones), then writes the
 * difference in a single atomic `applyStockChanges` call.
 */
import type { Movement, Product, ProductSummary, StockEntry } from '../model';
import { StockEntry as StockEntrySchema } from '../model';
import * as In from '../inputs';
import type { StockAdd, StockArrive, StockCharge, StockEntryPatch, StockExpect, StockMove, StockReturn, StockUse } from '../inputs';
import { NotFoundError, ValidationError } from '../errors';
import { addDays, newId, roundQty } from '../util';
import type { CoreContext } from './context';
import { loadWorld, summarise, type World } from './world';

const EPS = 1e-9;

function entryKey(e: StockEntry): string {
  return [e.status, e.placeId, e.currentPlaceId, e.expiresOn, e.variantId, e.charge, e.expected?.source, e.expected?.reference, e.expected?.eta].join('|');
}

/** Merge identical batches and drop empty ones. */
function tidy(entries: StockEntry[]): StockEntry[] {
  const out = new Map<string, StockEntry>();
  for (const e of entries) {
    if (e.quantity <= EPS) continue;
    const key = entryKey(e);
    const cur = out.get(key);
    if (cur) {
      cur.quantity = roundQty(cur.quantity + e.quantity);
      if (e.addedAt < cur.addedAt) cur.addedAt = e.addedAt;
    } else out.set(key, { ...e, quantity: roundQty(e.quantity) });
  }
  return [...out.values()];
}

function diff(before: StockEntry[], after: StockEntry[]) {
  const was = new Map(before.map((e) => [e.id, e]));
  const put = after.filter((e) => JSON.stringify(e) !== JSON.stringify(was.get(e.id)));
  const keep = new Set(after.map((e) => e.id));
  const remove = before.filter((e) => !keep.has(e.id)).map((e) => e.id);
  return { put, remove };
}

/** Oldest-expiring first, then oldest added. */
function useOrder(a: StockEntry, b: StockEntry): number {
  return (a.expiresOn ?? '9999-12-31').localeCompare(b.expiresOn ?? '9999-12-31') || a.addedAt.localeCompare(b.addedAt);
}

function where(e: StockEntry): string | null {
  return e.currentPlaceId ?? e.placeId;
}

function plural(n: number, unit: string): string {
  if (n === 1 || ['L', 'ml', 'kg', 'g', 'm'].includes(unit)) return `${n} ${unit}`;
  return `${n} ${unit.endsWith('s') ? unit : `${unit}s`}`;
}

export function createStockService(ctx: CoreContext) {
  type Txn = { world: World; product: Product; original: StockEntry[]; before: ProductSummary };
  type Change = { t: Txn; next: StockEntry[]; movements: Movement[]; kind: string; productUpdate?: Partial<Product> };

  function txn(world: World, productId: string): Txn {
    const product = world.productById.get(productId);
    if (!product) throw new NotFoundError('Product', productId);
    const original = (world.entriesByProduct.get(productId) ?? []).map((e) => ({ ...e }));
    return { world, product, original, before: summarise(world, product) };
  }

  async function begin(productId: string) {
    return txn(await loadWorld(ctx), productId);
  }

  async function assertPlace(id: string | null | undefined) {
    if (id && !(await ctx.storage.places.get(id))) throw new NotFoundError('Place', id);
  }

  function movement(product: Product, kind: Movement['kind'], quantity: number, extra: Partial<Movement> = {}): Movement {
    return { id: newId(), productId: product.id, entryId: null, kind, quantity: roundQty(quantity), fromPlaceId: null, toPlaceId: null, note: '', userId: null, at: ctx.now(), ...extra };
  }

  async function commit(t: Txn, next: StockEntry[], movements: Movement[], kind: string, productUpdate?: Partial<Product>): Promise<ProductSummary> {
    return (await commitAll([{ t, next, movements, kind, productUpdate }]))[0]!;
  }

  /** Write changes to any number of products in one atomic call, then announce them. */
  async function commitAll(changes: Change[]): Promise<ProductSummary[]> {
    const put: StockEntry[] = [];
    const remove: string[] = [];
    const movements: Movement[] = [];
    const products: Product[] = [];
    for (const c of changes) {
      const d = diff(c.t.original, tidy(c.next));
      put.push(...d.put);
      remove.push(...d.remove);
      movements.push(...c.movements);
      if (c.productUpdate) products.push({ ...c.t.product, ...c.productUpdate, updatedAt: ctx.now() });
    }
    await ctx.storage.applyStockChanges({ put, remove, movements, products: products.length ? products : undefined });
    const world = await loadWorld(ctx);
    return changes.map((c) => {
      const after = summarise(world, world.productById.get(c.t.product.id)!);
      const data = { productId: c.t.product.id, name: c.t.product.name, kind: c.kind, inStock: after.inStock, expected: after.expected, unit: c.t.product.unit, low: after.status.low };
      ctx.publish('stock.changed', data);
      if (!c.t.before.status.low && after.status.low) ctx.publish('stock.low', data);
      if (c.t.before.status.low && !after.status.low) ctx.publish('stock.restocked', data);
      if (c.productUpdate) ctx.publish('product.updated', { id: c.t.product.id, name: c.t.product.name });
      return after;
    });
  }

  function defaultPlace(world: World, product: Product): string | null {
    if (product.defaultPlaceId) return product.defaultPlaceId;
    const counts = new Map<string, number>();
    for (const e of world.entriesByProduct.get(product.id) ?? []) if (e.placeId) counts.set(e.placeId, (counts.get(e.placeId) ?? 0) + e.quantity);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  /** Adding stock clears the wish flag and a manual shopping list flag. */
  function clearFlags(product: Product): Partial<Product> | undefined {
    if (!product.wish && !product.onShoppingList) return undefined;
    return { wish: false, onShoppingList: false };
  }

  async function newEntry(t: Txn, input: ReturnType<typeof In.StockAdd.parse>): Promise<{ entry: StockEntry; move: Movement }> {
    const placeId = input.placeId !== undefined ? input.placeId : defaultPlace(t.world, t.product);
    await assertPlace(placeId);
    if (input.variantId && !(await ctx.storage.variants.get(input.variantId))) throw new NotFoundError('Variant', input.variantId);
    const expiresOn = input.expiresOn !== undefined ? input.expiresOn : t.product.shelfLifeDays ? addDays(ctx.today(), t.product.shelfLifeDays) : null;
    const entry: StockEntry = StockEntrySchema.parse({
      id: newId(), productId: t.product.id, variantId: input.variantId ?? null, quantity: input.quantity, placeId,
      expiresOn, addedAt: ctx.now(), status: 'in_stock', charge: t.product.rechargeable ? (input.charge ?? 'charged') : null,
    });
    return { entry, move: movement(t.product, 'add', input.quantity, { entryId: entry.id, toPlaceId: placeId, note: input.note ?? '' }) };
  }

  /** Takes stock out of `work` (soonest-expiring first), returning the history. Throws if there isn't enough. */
  function takeFrom(t: Txn, work: StockEntry[], input: ReturnType<typeof In.StockUse.parse>): Movement[] {
    const usable = work
      .filter((e) => e.status === 'in_stock' && e.quantity > 0 && (e.charge !== 'flat' || !t.product.rechargeable))
      .filter((e) => !input.placeId || e.placeId === input.placeId || e.currentPlaceId === input.placeId)
      .sort(useOrder);
    const available = roundQty(usable.reduce((n, e) => n + e.quantity, 0));
    if (input.quantity > available + EPS) {
      const what = t.product.rechargeable ? 'charged ' : '';
      throw new ValidationError(available ? `There ${available === 1 ? 'is' : 'are'} only ${plural(available, `${what}${t.product.unit}`)} of ${t.product.name} to use.` : what ? `None of the ${t.product.name} are charged.` : `There's no ${t.product.name} left to use.`);
    }
    let left = input.quantity;
    const movements: Movement[] = [];
    for (const e of usable) {
      if (left <= EPS) break;
      const take = Math.min(e.quantity, left);
      e.quantity = roundQty(e.quantity - take);
      left = roundQty(left - take);
      if (t.product.rechargeable) {
        work.push({ ...e, id: newId(), quantity: take, charge: 'flat', addedAt: ctx.now() });
        movements.push(movement(t.product, 'flat', take, { entryId: e.id, fromPlaceId: where(e), note: input.note ?? '' }));
      } else {
        movements.push(movement(t.product, 'use', -take, { entryId: e.id, fromPlaceId: where(e), note: input.note ?? '' }));
      }
    }
    return movements;
  }

  const service = {
    async add(raw: StockAdd): Promise<ProductSummary> {
      const input = In.StockAdd.parse(raw);
      const t = await begin(input.productId);
      const { entry, move } = await newEntry(t, input);
      return commit(t, [...t.original, entry], [move], 'add', clearFlags(t.product));
    },

    /** Several additions (a shopping trip) that all happen, or none do. */
    async addMany(raw: StockAdd[]): Promise<ProductSummary[]> {
      const inputs = raw.map((r) => In.StockAdd.parse(r));
      const world = await loadWorld(ctx);
      const changes = new Map<string, Change>();
      for (const input of inputs) {
        let c = changes.get(input.productId);
        if (!c) {
          const t = txn(world, input.productId);
          c = { t, next: [...t.original], movements: [], kind: 'add', productUpdate: clearFlags(t.product) };
          changes.set(input.productId, c);
        }
        const { entry, move } = await newEntry(c.t, input);
        c.next.push(entry);
        c.movements.push(move);
      }
      return commitAll([...changes.values()]);
    },

    async use(raw: StockUse): Promise<ProductSummary> {
      const input = In.StockUse.parse(raw);
      const t = await begin(input.productId);
      const work = t.original.map((e) => ({ ...e }));
      const movements = takeFrom(t, work, input);
      return commit(t, work, movements, t.product.rechargeable ? 'flat' : 'use');
    },

    /** Several uses (a recipe's ingredients) that all happen, or none do. */
    async useMany(raw: StockUse[]): Promise<ProductSummary[]> {
      const inputs = raw.map((r) => In.StockUse.parse(r));
      const world = await loadWorld(ctx);
      const changes = new Map<string, Change>();
      for (const input of inputs) {
        let c = changes.get(input.productId);
        if (!c) {
          const t = txn(world, input.productId);
          c = { t, next: t.original.map((e) => ({ ...e })), movements: [], kind: t.product.rechargeable ? 'flat' : 'use' };
          changes.set(input.productId, c);
        }
        c.movements.push(...takeFrom(c.t, c.next, input));
      }
      return commitAll([...changes.values()]);
    },

    /** Rechargeables: turn flat batteries back into charged ones. */
    async charge(raw: StockCharge): Promise<ProductSummary> {
      const input = In.StockCharge.parse(raw);
      const t = await begin(input.productId);
      if (!t.product.rechargeable) throw new ValidationError(`${t.product.name} isn't marked as rechargeable.`);
      const work = t.original.map((e) => ({ ...e }));
      const flat = work.filter((e) => e.status === 'in_stock' && e.charge === 'flat' && e.quantity > 0).sort(useOrder);
      const available = roundQty(flat.reduce((n, e) => n + e.quantity, 0));
      if (input.quantity > available + EPS) throw new ValidationError(available ? `Only ${available} are flat.` : 'None are flat.');
      let left = input.quantity;
      const movements: Movement[] = [];
      for (const e of flat) {
        if (left <= EPS) break;
        const take = Math.min(e.quantity, left);
        e.quantity = roundQty(e.quantity - take);
        left = roundQty(left - take);
        work.push({ ...e, id: newId(), quantity: take, charge: 'charged' });
        movements.push(movement(t.product, 'charged', take, { entryId: e.id }));
      }
      return commit(t, work, movements, 'charged');
    },

    async move(raw: StockMove): Promise<ProductSummary> {
      const input = In.StockMove.parse(raw);
      const t = await begin(input.productId);
      await assertPlace(input.toPlaceId);
      const work = t.original.map((e) => ({ ...e }));
      const movable = work
        .filter((e) => e.status === 'in_stock' && e.quantity > 0)
        .filter((e) => !input.fromPlaceId || where(e) === input.fromPlaceId)
        .filter((e) => (input.mode === 'permanent' ? e.placeId !== input.toPlaceId || !!e.currentPlaceId : where(e) !== input.toPlaceId))
        .sort(useOrder);
      const available = roundQty(movable.reduce((n, e) => n + e.quantity, 0));
      if (!available) throw new ValidationError(`There's no ${t.product.name.toLowerCase()} to move${input.fromPlaceId ? ' from there' : ''}.`);
      const quantity = input.quantity ?? available;
      if (quantity > available + EPS) throw new ValidationError(`Only ${plural(available, t.product.unit)} can be moved.`);
      let left = quantity;
      const movements: Movement[] = [];
      const now = ctx.now();
      for (const e of movable) {
        if (left <= EPS) break;
        const take = Math.min(e.quantity, left);
        left = roundQty(left - take);
        const from = where(e);
        const moved: StockEntry =
          input.mode === 'permanent'
            ? { ...e, id: take < e.quantity ? newId() : e.id, quantity: take, placeId: input.toPlaceId, currentPlaceId: null, movedAt: null }
            : { ...e, id: take < e.quantity ? newId() : e.id, quantity: take, currentPlaceId: e.placeId === input.toPlaceId ? null : input.toPlaceId, movedAt: e.placeId === input.toPlaceId ? null : now };
        if (take < e.quantity) {
          e.quantity = roundQty(e.quantity - take);
          work.push(moved);
        } else Object.assign(e, moved);
        movements.push(movement(t.product, 'move', take, { entryId: e.id, fromPlaceId: from, toPlaceId: input.toPlaceId, note: input.mode }));
      }
      return commit(t, work, movements, 'move');
    },

    /** Put out-of-place stock back in its usual place. */
    async returnHome(raw: StockReturn): Promise<ProductSummary> {
      const input = In.StockReturn.parse(raw);
      const t = await begin(input.productId);
      const work = t.original.map((e) => ({ ...e }));
      const away = work.filter((e) => e.currentPlaceId && (!input.entryId || e.id === input.entryId));
      if (!away.length) throw new ValidationError(`${t.product.name} is already in its usual place.`);
      const movements = away.map((e) => movement(t.product, 'return', e.quantity, { entryId: e.id, fromPlaceId: e.currentPlaceId, toPlaceId: e.placeId }));
      for (const e of away) {
        e.currentPlaceId = null;
        e.movedAt = null;
      }
      return commit(t, work, movements, 'return');
    },

    async updateEntry(entryId: string, raw: StockEntryPatch): Promise<ProductSummary> {
      const patch = In.StockEntryPatch.parse(raw);
      const entry = await ctx.storage.stock.get(entryId);
      if (!entry) throw new NotFoundError('Stock entry', entryId);
      const t = await begin(entry.productId);
      await assertPlace(patch.placeId);
      await assertPlace(patch.currentPlaceId);
      const work = t.original.map((e) => (e.id === entryId ? StockEntrySchema.parse({ ...e, ...patch, movedAt: patch.currentPlaceId ? ctx.now() : patch.currentPlaceId === null ? null : e.movedAt }) : { ...e }));
      const delta = patch.quantity !== undefined ? roundQty(patch.quantity - entry.quantity) : 0;
      return commit(t, work, [movement(t.product, 'adjust', delta, { entryId, note: 'Edited' })], 'adjust');
    },

    async removeEntry(entryId: string): Promise<ProductSummary> {
      const entry = await ctx.storage.stock.get(entryId);
      if (!entry) throw new NotFoundError('Stock entry', entryId);
      const t = await begin(entry.productId);
      return commit(t, t.original.filter((e) => e.id !== entryId), [movement(t.product, 'remove', -entry.quantity, { entryId, fromPlaceId: where(entry) })], 'remove');
    },

    /** Ordered but not here yet. Counts towards stock when deciding what's low. */
    async expect(raw: StockExpect): Promise<ProductSummary> {
      const input = In.StockExpect.parse(raw);
      const t = await begin(input.productId);
      const placeId = input.placeId !== undefined ? input.placeId : defaultPlace(t.world, t.product);
      await assertPlace(placeId);
      const entry = StockEntrySchema.parse({
        id: newId(), productId: t.product.id, quantity: input.quantity, placeId, addedAt: ctx.now(), status: 'expected',
        expected: { source: input.source.trim(), reference: input.reference ?? null, eta: input.eta ?? null },
        charge: t.product.rechargeable ? 'charged' : null,
      });
      return commit(t, [...t.original, entry], [movement(t.product, 'expect', input.quantity, { entryId: entry.id, note: input.source })], 'expect');
    },

    /** Expected stock arrived: it becomes real stock. */
    async arrive(raw: StockArrive): Promise<{ arrived: number; products: ProductSummary[] }> {
      const input = In.StockArrive.parse(raw);
      if (input.quantity !== undefined && !input.productId) throw new ValidationError('Say which product arrived when only part of a delivery is here.');
      const all = (await ctx.storage.stock.list()).filter((e) => e.status === 'expected');
      let chosen: Array<{ entry: StockEntry; quantity: number }>;
      if (input.entryIds?.length) chosen = all.filter((e) => input.entryIds!.includes(e.id)).map((entry) => ({ entry, quantity: entry.quantity }));
      else if (input.productId) {
        const mine = all.filter((e) => e.productId === input.productId && (!input.source || e.expected?.source === input.source)).sort((a, b) => (a.expected?.eta ?? '9999').localeCompare(b.expected?.eta ?? '9999'));
        let left = input.quantity ?? mine.reduce((n, e) => n + e.quantity, 0);
        chosen = [];
        for (const entry of mine) {
          if (left <= EPS) break;
          const q = Math.min(entry.quantity, left);
          left = roundQty(left - q);
          chosen.push({ entry, quantity: q });
        }
      } else chosen = all.filter((e) => e.expected?.source === input.source).map((entry) => ({ entry, quantity: entry.quantity }));
      if (!chosen.length) throw new ValidationError(input.source ? `Nothing is expected from ${input.source}.` : 'Nothing matching is expected.');

      const byProduct = new Map<string, typeof chosen>();
      for (const c of chosen) byProduct.set(c.entry.productId, [...(byProduct.get(c.entry.productId) ?? []), c]);
      const world = await loadWorld(ctx);
      const changes: Change[] = [];
      for (const [productId, items] of byProduct) {
        const t = txn(world, productId);
        const work = t.original.map((e) => ({ ...e }));
        const movements: Movement[] = [];
        for (const { entry, quantity } of items) {
          const e = work.find((w) => w.id === entry.id);
          if (!e) continue;
          const expiresOn = t.product.shelfLifeDays ? addDays(ctx.today(), t.product.shelfLifeDays) : null;
          const arrived: StockEntry = { ...e, id: quantity < e.quantity ? newId() : e.id, quantity, status: 'in_stock', expected: null, expiresOn, addedAt: ctx.now() };
          if (quantity < e.quantity) {
            e.quantity = roundQty(e.quantity - quantity);
            work.push(arrived);
          } else Object.assign(e, arrived);
          movements.push(movement(t.product, 'arrive', quantity, { entryId: e.id, toPlaceId: e.placeId, note: entry.expected?.source ?? '' }));
        }
        changes.push({ t, next: work, movements, kind: 'arrive', productUpdate: clearFlags(t.product) });
      }
      const products = await commitAll(changes);
      return { arrived: chosen.length, products };
    },

    /** Renewals (insurance, MOT): restart the clock from today. */
    async renew(productId: string): Promise<ProductSummary> {
      const t = await begin(productId);
      if (!t.product.shelfLifeDays) throw new ValidationError(`Set how often ${t.product.name} renews (its shelf life in days) first.`);
      const replaced = t.original.filter((e) => e.status === 'in_stock');
      const kept = t.original.filter((e) => e.status !== 'in_stock');
      const quantity = Math.max(1, roundQty(replaced.reduce((n, e) => n + e.quantity, 0)));
      const placeId = replaced[0]?.placeId ?? defaultPlace(t.world, t.product);
      const entry = StockEntrySchema.parse({
        id: newId(), productId, quantity, placeId, addedAt: ctx.now(), status: 'in_stock',
        expiresOn: addDays(ctx.today(), t.product.shelfLifeDays),
      });
      const movements = [
        ...replaced.map((e) => movement(t.product, 'remove', -e.quantity, { entryId: e.id, fromPlaceId: where(e), note: 'Replaced by renewal' })),
        movement(t.product, 'add', quantity, { entryId: entry.id, toPlaceId: placeId, note: 'Renewed' }),
      ];
      return commit(t, [...kept, entry], movements, 'renew', clearFlags(t.product));
    },

    async deliveries() {
      const expected = (await ctx.storage.stock.list()).filter((e) => e.status === 'expected' && e.expected);
      const groups = new Map<string, { source: string; eta: string | null; products: Set<string>; quantity: number }>();
      for (const e of expected) {
        const g = groups.get(e.expected!.source) ?? { source: e.expected!.source, eta: null, products: new Set(), quantity: 0 };
        if (e.expected!.eta && (!g.eta || e.expected!.eta < g.eta)) g.eta = e.expected!.eta;
        g.products.add(e.productId);
        g.quantity = roundQty(g.quantity + e.quantity);
        groups.set(g.source, g);
      }
      return [...groups.values()]
        .map((g) => ({ source: g.source, eta: g.eta, itemCount: g.products.size, quantity: g.quantity }))
        .sort((a, b) => (a.eta ?? '9999').localeCompare(b.eta ?? '9999') || a.source.localeCompare(b.source));
    },
  };
  return service;
}
