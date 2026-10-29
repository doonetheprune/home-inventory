/**
 * Sensors and actions for home automation: Home Assistant, Node-RED, MQTT.
 *
 * The core defines a stable set below. Modules add their own with
 * `ctx.addSensor` and `ctx.addAction`. The Home Assistant integration builds
 * its entities and actions from this list at runtime, so adding a sensor or
 * action needs no change to the integration.
 *
 * Actions take names, not ids ("loo roll", "G2-4", "Aldi"), resolved by
 * resolve.ts, and answer with a short `message` a person can read.
 */
import { z } from 'zod';
import { LarderError } from '../errors';
import { IsoDate, type ProductSummary } from '../model';
import type { CoreContext } from './context';
import type { createProductService } from './products';
import type { Resolver } from './resolve';
import type { createShoppingService } from './shopping';
import type { createStockService } from './stock';
import { loadWorld, needsBuying, summarise } from './world';
import { amount, daysBetween } from '../util';

export type SensorState = number | string | boolean | null;

export interface SensorReading {
  state: SensorState;
  /** Keep these small: Home Assistant warns when attributes pass 16 KB. */
  attributes?: Record<string, unknown>;
}

export interface SensorDefinition {
  /** snake_case. A module's sensor ids start with its id, e.g. "batteries_low". */
  id: string;
  name: string;
  description: string;
  /** Material Design Icon name for Home Assistant, e.g. "mdi:cart-arrow-down". */
  icon?: string;
  /** Shown after the number, e.g. "items". */
  unit?: string;
  read(): Promise<SensorReading>;
}

export interface ActionResult {
  /** One or two sentences for a person (or a notification, or a voice reply). */
  message: string;
  [key: string]: unknown;
}

export interface ActionDefinition<I extends z.ZodObject = z.ZodObject> {
  /** snake_case. A module's action ids start with its id, e.g. "batteries_replaced". */
  id: string;
  name: string;
  description: string;
  /** Field names are snake_case, the way Home Assistant and Node-RED expect. */
  input: I;
  run(input: z.output<I>, caller: { userId: string | null }): Promise<ActionResult>;
}

/** What the integration needs to build an action: its fields as JSON Schema. */
export interface ActionInfo {
  id: string;
  name: string;
  description: string;
  module: string | null;
  schema: Record<string, unknown>;
}

export interface SensorInfo {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  unit: string | null;
  module: string | null;
}

/** Most items a sensor lists in its attributes. */
const LIST_LIMIT = 25;

const Item = z.string().min(1).max(200).describe('The item: its name or alias ("loo roll"), barcode, or id');
const Quantity = z.number().positive().default(1).describe('How many, in the item\'s own unit (default 1)');

export function createAutomation(deps: {
  ctx: CoreContext;
  products: ReturnType<typeof createProductService>;
  stock: ReturnType<typeof createStockService>;
  shopping: ReturnType<typeof createShoppingService>;
  resolve: Resolver;
}) {
  const { ctx, products, stock, shopping, resolve } = deps;
  const sensors: Array<{ def: SensorDefinition; module: string | null; enabled: () => boolean }> = [];
  const actions: Array<{ def: ActionDefinition; module: string | null; enabled: () => boolean }> = [];

  const brief = (s: ProductSummary) => `${s.product.name}: ${amount(s.inStock, s.product.unit)} in stock${s.expected ? `, ${amount(s.expected, s.product.unit)} on the way` : ''}.`;
  const itemInfo = (s: ProductSummary) => ({
    item: s.product.name, id: s.product.id, in_stock: s.inStock, expected: s.expected, unit: s.product.unit, low: s.status.low,
    next_expiry: s.nextExpiry, place: s.places[0]?.path ?? null,
  });

  function addSensor(def: SensorDefinition, module: string | null = null, enabled: () => boolean = () => true) {
    if (!/^[a-z][a-z0-9_]*$/.test(def.id)) throw new Error(`Sensor id "${def.id}" must be snake_case.`);
    if (sensors.some((s) => s.def.id === def.id)) throw new Error(`Two sensors use the id "${def.id}".`);
    sensors.push({ def, module, enabled });
  }
  function addAction<I extends z.ZodObject>(def: ActionDefinition<I>, module: string | null = null, enabled: () => boolean = () => true) {
    if (!/^[a-z][a-z0-9_]*$/.test(def.id)) throw new Error(`Action id "${def.id}" must be snake_case.`);
    if (actions.some((a) => a.def.id === def.id)) throw new Error(`Two actions use the id "${def.id}".`);
    actions.push({ def: def as unknown as ActionDefinition, module, enabled });
  }

  /* ---------------------------- core sensors ---------------------------- */

  addSensor({
    id: 'low_stock', name: 'Running low', icon: 'mdi:cart-arrow-down', unit: 'items',
    description: 'Items below their minimum, counting deliveries on the way.',
    async read() {
      const items = (await products.list({ status: 'low' })).sort((a, b) => a.product.name.localeCompare(b.product.name));
      return { state: items.length, attributes: { items: items.slice(0, LIST_LIMIT).map((s) => ({ item: s.product.name, in_stock: s.inStock, expected: s.expected, minimum: s.product.minQuantity, unit: s.product.unit })) } };
    },
  });
  addSensor({
    id: 'expiring_soon', name: 'Use soon', icon: 'mdi:calendar-alert', unit: 'items',
    description: 'Items expiring within their warning window, already expired, or due for renewal.',
    async read() {
      const items = (await products.list({ status: 'expiring' })).sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0));
      return {
        state: items.length,
        attributes: { items: items.slice(0, LIST_LIMIT).map((s) => ({ item: s.product.name, expires_on: s.nextExpiry, days: s.daysToExpiry, category: s.category?.name ?? null, place: s.places[0]?.path ?? null })) },
      };
    },
  });
  addSensor({
    id: 'out_of_place', name: 'Out of place', icon: 'mdi:map-marker-question', unit: 'items',
    description: 'Things that are somewhere other than their usual place (usually in the shed, now in the kitchen).',
    async read() {
      const items = await products.list({ status: 'out_of_place' });
      return { state: items.length, attributes: { items: items.slice(0, LIST_LIMIT).map((s) => ({ item: s.product.name, usually: s.places[0]?.path ?? null, now: s.nowIn.map((p) => p.path) })) } };
    },
  });
  addSensor({
    id: 'shopping_list', name: 'Shopping list', icon: 'mdi:cart', unit: 'items',
    description: 'Everything that needs buying, with how many each shop can supply and the suggested shop.',
    async read() {
      const summary = await shopping.summary();
      const world = await loadWorld(ctx);
      const count = world.products.map((p) => summarise(world, p)).filter((s) => !s.product.wish && needsBuying(s)).length;
      const suggested = summary.shops.find((s) => s.shop.id === summary.suggestedShopId)?.shop.name ?? null;
      return { state: count, attributes: { suggested_shop: suggested, shops: Object.fromEntries(summary.shops.map((s) => [s.shop.name, s.count])), no_shop: summary.unassigned } };
    },
  });
  addSensor({
    id: 'deliveries', name: 'Deliveries on the way', icon: 'mdi:truck-delivery', unit: 'deliveries',
    description: 'Orders that have been placed but not arrived yet.',
    async read() {
      const list = await stock.deliveries();
      return { state: list.length, attributes: { deliveries: list.slice(0, LIST_LIMIT).map((d) => ({ source: d.source, eta: d.eta, items: d.itemCount })) } };
    },
  });

  /* ---------------------------- core actions ---------------------------- */

  addAction({
    id: 'add_stock', name: 'Add stock', description: 'Add some of an item to stock, e.g. after shopping.',
    input: z.object({
      item: Item, quantity: Quantity,
      place: z.string().max(200).optional().describe('Where it goes: a place name or code like "G2-4". Defaults to its usual place.'),
      expires_on: IsoDate.optional().describe('Expiry date (YYYY-MM-DD). Defaults to today plus its shelf life.'),
      note: z.string().max(200).optional(),
    }),
    async run(i) {
      const p = await resolve.product(i.item);
      const placeId = i.place ? (await resolve.place(i.place)).id : undefined;
      const s = await stock.add({ productId: p.id, quantity: i.quantity, placeId, expiresOn: i.expires_on, note: i.note });
      return { message: `${p.name}: added ${amount(i.quantity, p.unit)}. ${amount(s.inStock, p.unit)} in stock.`, ...itemInfo(s) };
    },
  });
  addAction({
    id: 'use_stock', name: 'Use stock', description: 'Take some of an item out of stock (soonest-expiring first). Rechargeables go flat instead.',
    input: z.object({ item: Item, quantity: Quantity, place: z.string().max(200).optional().describe('Only use stock from this place') }),
    async run(i) {
      const p = await resolve.product(i.item);
      const placeId = i.place ? (await resolve.place(i.place)).id : undefined;
      const s = await stock.use({ productId: p.id, quantity: i.quantity, placeId });
      return { message: `${p.name}: used ${amount(i.quantity, p.unit)}. ${amount(s.inStock, p.unit)} left${s.status.low ? ', running low' : ''}.`, ...itemInfo(s) };
    },
  });
  addAction({
    id: 'move_item', name: 'Move item', description: 'Move an item to another place: for now (out of place) or for good (its usual place changes).',
    input: z.object({
      item: Item, to: z.string().min(1).max(200).describe('The place it\'s going to: a name or code'),
      quantity: z.number().positive().optional().describe('How many (default all of it)'),
      permanent: z.boolean().default(false).describe('True if this is its new usual place'),
    }),
    async run(i) {
      const p = await resolve.product(i.item);
      const place = await resolve.place(i.to);
      const s = await stock.move({ productId: p.id, toPlaceId: place.id, quantity: i.quantity, mode: i.permanent ? 'permanent' : 'temporary' });
      return { message: `${p.name} moved to ${place.name}${i.permanent ? ' for good' : ''}.`, ...itemInfo(s) };
    },
  });
  addAction({
    id: 'put_back', name: 'Put back', description: 'Put an out-of-place item back in its usual place.',
    input: z.object({ item: Item }),
    async run(i) {
      const p = await resolve.product(i.item);
      const s = await stock.returnHome({ productId: p.id });
      return { message: `${p.name} is back in ${s.places[0]?.path ?? 'its usual place'}.`, ...itemInfo(s) };
    },
  });
  addAction({
    id: 'add_expected', name: 'Add expected delivery', description: 'Record something ordered but not arrived yet. It counts towards stock, so it isn\'t bought twice.',
    input: z.object({
      item: Item, quantity: Quantity,
      source: z.string().min(1).max(80).describe('Where it\'s coming from, e.g. "Tesco delivery" or "Amazon"'),
      reference: z.string().max(80).optional().describe('Order number'),
      eta: IsoDate.optional().describe('Expected date (YYYY-MM-DD)'),
    }),
    async run(i) {
      const p = await resolve.product(i.item);
      const s = await stock.expect({ productId: p.id, quantity: i.quantity, source: i.source, reference: i.reference, eta: i.eta });
      return { message: `${p.name}: ${amount(i.quantity, p.unit)} expected from ${i.source}.`, ...itemInfo(s) };
    },
  });
  addAction({
    id: 'mark_arrived', name: 'Mark arrived', description: 'A delivery arrived: everything from a source, or some of one item.',
    input: z.object({
      source: z.string().max(80).optional().describe('The delivery, e.g. "Tesco delivery"'),
      item: Item.optional().describe('Or one item that arrived'),
      quantity: z.number().positive().optional().describe('How many of the item arrived (default all expected)'),
    }),
    async run(i) {
      if (!i.source && !i.item) throw new LarderError('Say which delivery (source) or which item arrived.', 400, 'invalid');
      const productId = i.item ? (await resolve.product(i.item)).id : undefined;
      const r = await stock.arrive({ source: i.source, productId, quantity: i.quantity });
      const names = r.products.map((s) => s.product.name);
      return { message: `Arrived: ${names.join(', ')}.`, arrived: r.arrived, items: r.products.map(itemInfo) };
    },
  });
  addAction({
    id: 'add_to_shopping_list', name: 'Add to shopping list', description: 'Put an item on the shopping list even though it isn\'t low.',
    input: z.object({ item: Item }),
    async run(i) {
      const p = await resolve.product(i.item);
      await products.setOnList(p.id, true);
      return { message: `${p.name} is on the shopping list.`, item: p.name, id: p.id };
    },
  });
  addAction({
    id: 'remove_from_shopping_list', name: 'Remove from shopping list', description: 'Take an item that was added by hand off the shopping list.',
    input: z.object({ item: Item }),
    async run(i) {
      const p = await resolve.product(i.item);
      await products.setOnList(p.id, false);
      return { message: `${p.name} is off the shopping list${(await products.summary(p.id)).status.low ? ', but it\'s still low so it will stay on until restocked' : ''}.`, item: p.name, id: p.id };
    },
  });
  addAction({
    id: 'mark_charged', name: 'Mark charged', description: 'Rechargeable batteries: some flat ones have been charged.',
    input: z.object({ item: Item, quantity: Quantity }),
    async run(i) {
      const p = await resolve.product(i.item);
      const s = await stock.charge({ productId: p.id, quantity: i.quantity });
      return { message: `${p.name}: ${amount(s.charged ?? 0, p.unit)} charged, ${amount(s.flat ?? 0, p.unit)} flat.`, ...itemInfo(s), charged: s.charged, flat: s.flat };
    },
  });
  addAction({
    id: 'renew', name: 'Renew', description: 'A renewal (insurance, MOT, boiler service) has been renewed: restart its clock from today.',
    input: z.object({ item: Item }),
    async run(i) {
      const p = await resolve.product(i.item);
      const s = await stock.renew(p.id);
      return { message: `${p.name} renewed. Next due ${s.nextExpiry}.`, ...itemInfo(s) };
    },
  });
  addAction({
    id: 'find_item', name: 'Find item', description: 'Look up an item: how many, where, and when it expires.',
    input: z.object({ item: Item }),
    async run(i) {
      const p = await resolve.product(i.item);
      const s = await products.summary(p.id);
      const where = s.places.map((x) => x.path);
      return { message: `${brief(s)}${where.length ? ` In ${where.join(' and ')}.` : ''}${s.nowIn.length ? ` Now in ${s.nowIn.map((x) => x.path).join(' and ')}.` : ''}`, ...itemInfo(s) };
    },
  });
  addAction({
    id: 'shopping_list_for', name: 'Shopping list for a shop', description: 'Everything to buy at a shop: its favourites plus "any shop" items in categories it sells.',
    input: z.object({ shop: z.string().min(1).max(80).describe('The shop, e.g. "Aldi"') }),
    async run(i) {
      const shop = await resolve.shop(i.shop);
      const list = await shopping.forShop(shop.id);
      const items = list.groups.flatMap((g) => g.items.map((it) => ({ item: it.summary.product.name, quantity: it.quantity, unit: it.summary.product.unit, category: g.category?.name ?? null })));
      return { message: items.length ? `${items.length} thing${items.length === 1 ? '' : 's'} to get at ${shop.name}: ${items.map((x) => x.item).join(', ')}.` : `Nothing to get at ${shop.name}.`, shop: shop.name, items };
    },
  });

  /* ----------------------------- expiry check ---------------------------- */

  type Notified = Record<string, { expiresOn: string; warned: boolean; expired: boolean }>;

  return {
    addSensor,
    addAction,

    sensors(): SensorInfo[] {
      return sensors.filter((s) => s.enabled()).map(({ def, module }) => ({ id: def.id, name: def.name, description: def.description, icon: def.icon ?? null, unit: def.unit ?? null, module }));
    },

    actions(): ActionInfo[] {
      return actions.filter((a) => a.enabled()).map(({ def, module }) => ({
        id: def.id, name: def.name, description: def.description, module,
        schema: z.toJSONSchema(def.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>,
      }));
    },

    /** Every enabled sensor's current reading. One failing sensor doesn't stop the rest. */
    async read(): Promise<Record<string, SensorReading>> {
      const out: Record<string, SensorReading> = {};
      for (const { def } of sensors.filter((s) => s.enabled())) {
        try {
          out[def.id] = await def.read();
        } catch (err) {
          out[def.id] = { state: null, attributes: { error: err instanceof Error ? err.message : String(err) } };
        }
      }
      return out;
    },

    /** An action's definition (with its zod input), for reuse by AI assistant tools. */
    definition(id: string): ActionDefinition | undefined {
      return actions.find((a) => a.def.id === id && a.enabled())?.def;
    },

    async run(id: string, input: unknown, caller: { userId: string | null } = { userId: null }): Promise<ActionResult> {
      const a = actions.find((x) => x.def.id === id && x.enabled());
      if (!a) throw new LarderError(`There's no action called ${id}. It may belong to a module that's switched off.`, 404, 'not_found');
      const parsed = a.def.input.safeParse(input ?? {});
      if (!parsed.success) throw new LarderError(`${a.def.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`, 400, 'invalid');
      return a.def.run(parsed.data, caller);
    },

    /**
     * Publishes `stock.expiring` once when an item enters its warning window
     * and `stock.expired` once on the day it expires. Safe to call as often
     * as you like; the server calls it hourly.
     */
    async checkExpiry(): Promise<{ expiring: number; expired: number }> {
      const notified = (await ctx.storage.settings.get<Notified>('expiryNotified')) ?? {};
      const next: Notified = {};
      let expiring = 0;
      let expired = 0;
      const world = await loadWorld(ctx);
      for (const p of world.products) {
        const s = summarise(world, p);
        if (s.product.wish || !s.nextExpiry || !s.status.expiringSoon) continue;
        const prev = notified[p.id]?.expiresOn === s.nextExpiry ? notified[p.id]! : { expiresOn: s.nextExpiry, warned: false, expired: false };
        const days = s.daysToExpiry ?? daysBetween(world.today, s.nextExpiry);
        const data = { productId: p.id, name: p.name, expiresOn: s.nextExpiry, daysToExpiry: days, category: s.category?.name ?? null, place: s.places[0]?.path ?? null };
        if (!prev.warned) {
          ctx.publish('stock.expiring', data);
          prev.warned = true;
          expiring++;
        }
        if (days <= 0 && !prev.expired) {
          ctx.publish('stock.expired', data);
          prev.expired = true;
          expired++;
        }
        next[p.id] = prev;
      }
      await ctx.storage.settings.set('expiryNotified', next);
      return { expiring, expired };
    },
  };
}

export type Automation = ReturnType<typeof createAutomation>;
