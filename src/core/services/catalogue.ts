/** Categories, shops and places: the things stock is organised by. */
import { z } from 'zod';
import { Category, Place, Shop, type PlaceContents, type PlaceNodeT, type PlaceRef } from '../model';
import { CategoryCreate, CategoryPatch, GridCreate, PlaceCreate, PlacePatch, ShopCreate, ShopPatch } from '../inputs';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { byName, newId, pluralWord } from '../util';
import type { CoreContext } from './context';
import { loadWorld, placePath, placeRef, summarise } from './world';

export const DEFAULT_CATEGORIES: Array<Omit<Category, 'id'>> = [
  { name: 'Food', icon: 'apple', warnDays: null, sortOrder: 10 },
  { name: 'Household', icon: 'sparkle', warnDays: null, sortOrder: 20 },
  { name: 'Toiletries', icon: 'drop', warnDays: null, sortOrder: 30 },
  { name: 'Medicine', icon: 'shield', warnDays: 30, sortOrder: 40 },
  { name: 'Pets', icon: 'paw', warnDays: null, sortOrder: 50 },
  { name: 'Tools & DIY', icon: 'wrench', warnDays: null, sortOrder: 60 },
  { name: 'Batteries', icon: 'battery', warnDays: null, sortOrder: 70 },
  { name: 'Fuel', icon: 'drop', warnDays: null, sortOrder: 80 },
  { name: 'Renewals', icon: 'shield', warnDays: 30, sortOrder: 90 },
  { name: 'Other', icon: 'box', warnDays: null, sortOrder: 100 },
];

/** Common UK shops offered as one-tap additions, with what they usually sell. */
export const SHOP_PRESETS: Array<{ name: string; sells: string[] }> = [
  { name: 'Aldi', sells: ['Food', 'Household', 'Toiletries', 'Batteries'] },
  { name: 'Lidl', sells: ['Food', 'Household', 'Toiletries', 'Batteries'] },
  { name: 'Tesco', sells: ['Food', 'Household', 'Toiletries', 'Medicine', 'Pets', 'Batteries'] },
  { name: "Sainsbury's", sells: ['Food', 'Household', 'Toiletries', 'Medicine', 'Pets', 'Batteries'] },
  { name: 'Asda', sells: ['Food', 'Household', 'Toiletries', 'Medicine', 'Pets', 'Batteries'] },
  { name: 'Morrisons', sells: ['Food', 'Household', 'Toiletries', 'Medicine', 'Pets', 'Batteries'] },
  { name: 'Co-op', sells: ['Food', 'Household', 'Toiletries'] },
  { name: 'Boots', sells: ['Toiletries', 'Medicine'] },
  { name: 'Toolstation', sells: ['Tools & DIY', 'Fuel', 'Batteries'] },
  { name: 'Screwfix', sells: ['Tools & DIY', 'Fuel', 'Batteries'] },
  { name: 'B&Q', sells: ['Tools & DIY', 'Fuel'] },
  { name: 'Pets at Home', sells: ['Pets'] },
  { name: 'Amazon', sells: ['Household', 'Tools & DIY', 'Batteries', 'Pets', 'Toiletries', 'Other'] },
];

export function createCategoryService(ctx: CoreContext) {
  const changed = (id: string) => ctx.publish('category.changed', { id });
  return {
    async list(): Promise<Category[]> {
      return (await ctx.storage.categories.list()).sort(byName);
    },
    async ensureDefaults(): Promise<void> {
      if ((await ctx.storage.categories.list()).length) return;
      for (const c of DEFAULT_CATEGORIES) await ctx.storage.categories.put({ id: newId(), ...c });
    },
    async create(input: z.input<typeof CategoryCreate>): Promise<Category> {
      const cat = Category.parse({ ...CategoryCreate.parse(input), id: newId() });
      await ctx.storage.categories.put(cat);
      changed(cat.id);
      return cat;
    },
    async update(id: string, patch: z.infer<typeof CategoryPatch>): Promise<Category> {
      const cur = await ctx.storage.categories.get(id);
      if (!cur) throw new NotFoundError('Category', id);
      const next = Category.parse({ ...cur, ...patch, id });
      await ctx.storage.categories.put(next);
      changed(id);
      return next;
    },
    async remove(id: string): Promise<void> {
      const products = await ctx.storage.products.list();
      const used = products.filter((p) => p.categoryId === id).length;
      if (used) throw new ConflictError(`${used} item${used === 1 ? ' uses' : 's use'} this category. Move them to another category first.`);
      await ctx.storage.categories.remove(id);
      for (const shop of await ctx.storage.shops.list()) {
        if (shop.sells.includes(id)) await ctx.storage.shops.put({ ...shop, sells: shop.sells.filter((s) => s !== id) });
      }
      changed(id);
    },
  };
}

export function createShopService(ctx: CoreContext) {
  const changed = (id: string) => ctx.publish('shop.changed', { id });
  return {
    async list(): Promise<Shop[]> {
      return (await ctx.storage.shops.list()).sort(byName);
    },
    async get(id: string): Promise<Shop> {
      const s = await ctx.storage.shops.get(id);
      if (!s) throw new NotFoundError('Shop', id);
      return s;
    },
    presets: () => SHOP_PRESETS,
    async create(input: z.input<typeof ShopCreate>): Promise<Shop> {
      const data = ShopCreate.parse(input);
      await assertCategories(ctx, data.sells);
      const existing = await ctx.storage.shops.list();
      if (existing.some((s) => s.name.toLowerCase() === data.name.toLowerCase())) throw new ConflictError(`There's already a shop called ${data.name}.`);
      const shop = Shop.parse({ ...data, id: newId(), sortOrder: data.sortOrder || existing.length * 10 });
      await ctx.storage.shops.put(shop);
      changed(shop.id);
      return shop;
    },
    /** Add a preset like "Tesco", mapping its category names to this household's categories. */
    async addPreset(name: string): Promise<Shop> {
      const preset = SHOP_PRESETS.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (!preset) throw new ValidationError(`${name} isn't one of the preset shops. Add it as a new shop instead.`);
      const cats = await ctx.storage.categories.list();
      const sells = preset.sells.map((n) => cats.find((c) => c.name === n)?.id).filter((id): id is string => !!id);
      return this.create({ name: preset.name, sells });
    },
    async update(id: string, patch: z.infer<typeof ShopPatch>): Promise<Shop> {
      const cur = await this.get(id);
      if (patch.sells) await assertCategories(ctx, patch.sells);
      const next = Shop.parse({ ...cur, ...patch, id });
      await ctx.storage.shops.put(next);
      changed(id);
      return next;
    },
    async remove(id: string): Promise<void> {
      await this.get(id);
      await ctx.storage.shops.remove(id);
      for (const p of await ctx.storage.products.list()) {
        if (p.preferredShopIds.includes(id)) {
          await ctx.storage.products.put({ ...p, preferredShopIds: p.preferredShopIds.filter((s) => s !== id), updatedAt: ctx.now() });
        }
      }
      changed(id);
    },
  };
}

async function assertCategories(ctx: CoreContext, ids: string[]) {
  const cats = new Set((await ctx.storage.categories.list()).map((c) => c.id));
  const missing = ids.filter((id) => !cats.has(id));
  if (missing.length) throw new ValidationError(`Unknown category: ${missing.join(', ')}`);
}

export function createPlaceService(ctx: CoreContext) {
  const changed = (id: string) => ctx.publish('place.changed', { id });

  async function assertCodeFree(code: string | null | undefined, exceptId?: string) {
    if (!code) return;
    const other = await ctx.storage.places.findByCode(code);
    if (other && other.id !== exceptId) throw new ConflictError(`The code ${code} is already used by ${other.name}. Codes must be unique so labels scan to one place.`);
  }

  async function assertParent(parentId: string | null | undefined, selfId?: string) {
    if (!parentId) return;
    const places = await ctx.storage.places.list();
    const byId = new Map(places.map((p) => [p.id, p]));
    if (!byId.has(parentId)) throw new NotFoundError('Place', parentId);
    let cur = byId.get(parentId);
    while (cur) {
      if (cur.id === selfId) throw new ValidationError("A place can't be inside itself.");
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }

  return {
    async list(): Promise<PlaceRef[]> {
      const places = await ctx.storage.places.list();
      const byId = new Map(places.map((p) => [p.id, p]));
      return places
        .map((p) => ({ id: p.id, name: p.name, code: p.code, path: placePath(byId, p.id) }))
        .sort((a, b) => a.path.localeCompare(b.path, 'en-GB', { numeric: true }));
    },

    async tree(): Promise<PlaceNodeT[]> {
      const world = await loadWorld(ctx);
      const direct = new Map<string, number>();
      for (const e of world.entries) {
        if (e.status !== 'in_stock' || e.quantity <= 0) continue;
        const where = e.currentPlaceId ?? e.placeId;
        if (where) direct.set(where, (direct.get(where) ?? 0) + 1);
      }
      const kids = new Map<string | null, typeof world.places>();
      for (const p of world.places) {
        const key = p.parentId && world.placeById.has(p.parentId) ? p.parentId : null;
        kids.set(key, [...(kids.get(key) ?? []), p]);
      }
      const build = (parent: string | null): PlaceNodeT[] =>
        (kids.get(parent) ?? [])
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'en-GB', { numeric: true }))
          .map((place) => {
            const children = build(place.id);
            const itemCount = (direct.get(place.id) ?? 0) + children.reduce((n, c) => n + c.itemCount, 0);
            return { place, path: placePath(world.placeById, place.id), itemCount, children };
          });
      return build(null);
    },

    async get(id: string): Promise<Place> {
      const p = await ctx.storage.places.get(id);
      if (!p) throw new NotFoundError('Place', id);
      return p;
    },

    async contents(id: string): Promise<PlaceContents> {
      const world = await loadWorld(ctx);
      const place = world.placeById.get(id);
      if (!place) throw new NotFoundError('Place', id);
      const items = new Map<string, { quantity: number; outOfPlace: boolean; nowIn: string | null }>();
      const visitors = new Map<string, { quantity: number; usualPlace: string | null }>();
      for (const e of world.entries) {
        if (e.status !== 'in_stock' || e.quantity <= 0) continue;
        const away = !!e.currentPlaceId && e.currentPlaceId !== e.placeId;
        if (e.placeId === id) {
          const cur = items.get(e.productId) ?? { quantity: 0, outOfPlace: false, nowIn: null };
          cur.quantity += e.quantity;
          if (away) {
            cur.outOfPlace = true;
            cur.nowIn = e.currentPlaceId;
          }
          items.set(e.productId, cur);
        } else if (away && e.currentPlaceId === id) {
          const cur = visitors.get(e.productId) ?? { quantity: 0, usualPlace: e.placeId };
          cur.quantity += e.quantity;
          visitors.set(e.productId, cur);
        }
      }
      const breadcrumbs: PlaceRef[] = [];
      let cur = place.parentId ? world.placeById.get(place.parentId) : undefined;
      while (cur) {
        breadcrumbs.unshift(placeRef(world, cur.id)!);
        cur = cur.parentId ? world.placeById.get(cur.parentId) : undefined;
      }
      const tree = await this.tree();
      const findNode = (nodes: PlaceNodeT[]): PlaceNodeT | undefined => {
        for (const n of nodes) {
          if (n.place.id === id) return n;
          const f = findNode(n.children);
          if (f) return f;
        }
        return undefined;
      };
      const node = findNode(tree);
      const sum = (pid: string) => summarise(world, world.productById.get(pid)!);
      return {
        place,
        path: placePath(world.placeById, id),
        breadcrumbs,
        children: (node?.children ?? []).map((c) => ({ ...placeRef(world, c.place.id)!, itemCount: c.itemCount })),
        items: [...items.entries()]
          .filter(([pid]) => world.productById.has(pid))
          .map(([pid, v]) => ({ summary: sum(pid), quantity: v.quantity, outOfPlace: v.outOfPlace, nowIn: placeRef(world, v.nowIn) }))
          .sort((a, b) => a.summary.product.name.localeCompare(b.summary.product.name, 'en-GB')),
        visitors: [...visitors.entries()]
          .filter(([pid]) => world.productById.has(pid))
          .map(([pid, v]) => ({ summary: sum(pid), quantity: v.quantity, usualPlace: placeRef(world, v.usualPlace) })),
      };
    },

    async create(input: z.input<typeof PlaceCreate>): Promise<Place> {
      const data = PlaceCreate.parse(input);
      await assertParent(data.parentId);
      await assertCodeFree(data.code);
      const now = ctx.now();
      const place = Place.parse({ ...data, code: data.code?.trim() || null, id: newId(), createdAt: now, updatedAt: now });
      await ctx.storage.places.put(place);
      changed(place.id);
      return place;
    },

    async update(id: string, patch: z.infer<typeof PlacePatch>): Promise<Place> {
      const cur = await this.get(id);
      if (patch.parentId !== undefined) await assertParent(patch.parentId, id);
      if (patch.code !== undefined) await assertCodeFree(patch.code, id);
      const next = Place.parse({ ...cur, ...patch, code: patch.code === undefined ? cur.code : patch.code?.trim() || null, id, updatedAt: ctx.now() });
      await ctx.storage.places.put(next);
      changed(id);
      return next;
    },

    /** Only empty places can be removed; children move up to this place's parent. */
    async remove(id: string): Promise<void> {
      const place = await this.get(id);
      const entries = await ctx.storage.stock.listByPlace(id);
      if (entries.some((e) => e.quantity > 0)) {
        throw new ConflictError(`${place.name} still has things in it. Move them somewhere else first.`);
      }
      for (const child of (await ctx.storage.places.list()).filter((p) => p.parentId === id)) {
        await ctx.storage.places.put({ ...child, parentId: place.parentId, updatedAt: ctx.now() });
      }
      for (const product of (await ctx.storage.products.list()).filter((p) => p.defaultPlaceId === id)) {
        await ctx.storage.products.put({ ...product, defaultPlaceId: null, updatedAt: ctx.now() });
      }
      await ctx.storage.places.remove(id);
      changed(id);
    },

    /** "4 shelves, 6 boxes each" → a container with places G1-1 … G4-6. */
    async createGrid(input: z.input<typeof GridCreate>): Promise<{ container: Place; places: Place[] }> {
      const g = GridCreate.parse(input);
      await assertParent(g.parentId);
      const prefix = g.prefix.toUpperCase();
      const codes: string[] = [];
      for (let r = 1; r <= g.rows; r++) for (let c = 1; c <= g.columns; c++) codes.push(`${prefix}${r}-${c}`);
      for (const code of codes) await assertCodeFree(code);
      const now = ctx.now();
      const container = Place.parse({
        id: newId(), name: g.name, parentId: g.parentId, code: null,
        notes: `${g.rows} ${pluralWord(g.rowLabel.toLowerCase(), g.rows)}, ${g.columns} ${pluralWord(g.columnLabel.toLowerCase(), g.columns)} each. Codes ${codes[0]} to ${codes[codes.length - 1]}.`,
        createdAt: now, updatedAt: now,
      });
      const places: Place[] = [];
      for (let r = 1; r <= g.rows; r++) {
        for (let c = 1; c <= g.columns; c++) {
          const order = g.firstRow === 'top' ? r : g.rows - r + 1;
          places.push(
            Place.parse({
              id: newId(), name: `${g.rowLabel} ${r}, ${g.columnLabel} ${c}`, parentId: container.id, code: `${prefix}${r}-${c}`,
              sortOrder: order * 100 + c, createdAt: now, updatedAt: now,
            }),
          );
        }
      }
      await ctx.storage.places.put(container);
      for (const p of places) await ctx.storage.places.put(p);
      changed(container.id);
      return { container, places };
    },
  };
}
