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
import { loadWorld, needsBuying, placesText, summarise } from './world';
import { amountText, canConvert, fromBoughtIn, startsOne, stockText, toBoughtIn, usageText, type Units } from './units';
import { daysBetween, roundQty } from '../util';

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
const Quantity = z.number().positive().default(1).describe('How many, in what the item is bought in (default 1), or in `unit`');
const Unit = z.string().max(30).optional().describe('What the quantity is in, if not what the item is bought in: what one contains, e.g. "tea bag" (a box contains 20), or g, kg, ml, L or pints for something with a Weight (100 g of a 400 g jar)');

/** The plural of what it's bought in, as sensors and actions say it: "boxes", "g", "each". */
const unitsOf = (units: Units, key: string) => units.find(key)?.many ?? key;
/** Stock at the start of a sentence: "About ¾ jar left". */
const leftText = (units: Units, p: { unit: string }, n: number) => {
  const t = stockText(units, p, n);
  return `${t[0]!.toUpperCase()}${t.slice(1)}`;
};

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

  const brief = (units: Units, s: ProductSummary) => `${s.product.name}: ${stockText(units, s.product, s.inStock)} in stock${s.expected ? `, ${amountText(units, s.expected, s.product.unit)} on the way` : ''}.`;
  const itemInfo = (units: Units, s: ProductSummary) => ({
    item: s.product.name, id: s.product.id, in_stock: s.inStock, expected: s.expected, unit: unitsOf(units, s.product.unit), low: s.status.low,
    next_expiry: s.nextExpiry, runs_out_on: s.runsOutOn, open: s.inUse, place: s.places[0]?.path ?? null,
  });
  /**
   * An amount as it was given, and in what it's bought in when that's different: "5 tea bags (0.25 box)".
   * Given in what it's bought in, something used a little at a time also says it the way its usage does: "1 jar (400 g)".
   */
  const said = (units: Units, p: ProductSummary['product'], quantity: number, given?: number, unit?: string) => {
    const other = unit && units.find(unit)?.key !== units.find(p.unit)?.key && unit.trim() !== p.unit;
    if (other) return `${amountText(units, given!, unit!)} (${amountText(units, quantity, p.unit)})`;
    const by = p.usage?.unit && canConvert(units, p, p.usage.unit) ? ` (${amountText(units, roundQty(fromBoughtIn(units, p, quantity, p.usage.unit)), p.usage.unit)})` : '';
    return `${amountText(units, quantity, p.unit)}${by}`;
  };

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
      const [list, units] = await Promise.all([products.list({ status: 'low' }), ctx.units()]);
      const items = list.sort((a, b) => a.product.name.localeCompare(b.product.name));
      return { state: items.length, attributes: { items: items.slice(0, LIST_LIMIT).map((s) => ({ item: s.product.name, in_stock: s.inStock, expected: s.expected, minimum: s.product.minQuantity, unit: unitsOf(units, s.product.unit), ...(s.runsOutOn ? { runs_out_on: s.runsOutOn } : {}) })) } };
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
    id: 'pending_orders', name: 'Pending orders', icon: 'mdi:cart-clock', unit: 'orders',
    description: 'Orders waiting to be confirmed or removed in Larder, e.g. a filled online basket not checked out yet.',
    async read() {
      const list = await stock.pendingOrders();
      return { state: list.length, attributes: { orders: list.slice(0, LIST_LIMIT).map((d) => ({ source: d.source, since: d.since, items: d.itemCount })) } };
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
    id: 'add_stock', name: 'Add stock', description: 'Add some of an item to stock, e.g. after shopping. With a price or shop, it\'s kept in the purchase history too.',
    input: z.object({
      item: Item, quantity: Quantity,
      place: z.string().max(200).optional().describe('Where it goes: a place name or code like "G2-4". Defaults to its usual place.'),
      expires_on: IsoDate.optional().describe('Expiry date (YYYY-MM-DD). Defaults to today plus its shelf life.'),
      brand: z.string().max(160).optional().describe('Which of the item\'s brands or packs it is'),
      price: z.number().min(0).optional().describe('What was paid for them all, e.g. 3.20 (kept in the purchase history)'),
      shop: z.string().max(80).optional().describe('The shop they were bought at (kept in the purchase history)'),
      note: z.string().max(200).optional(),
      unit: Unit,
    }),
    async run(i) {
      const [p, units] = await Promise.all([resolve.product(i.item), ctx.units()]);
      const quantity = roundQty(toBoughtIn(units, p, i.quantity, i.unit));
      const place = i.place ? await resolve.place(i.place) : null;
      const shop = i.shop ? await resolve.shop(i.shop) : null;
      const variant = i.brand ? resolve.among('brand', i.brand, (await products.get(p.id)).variants) : null;
      const bought = i.price !== undefined || !!shop;
      const s = bought
        ? (await shopping.purchase({ shopId: shop?.id ?? null, items: [{ productId: p.id, quantity, placeId: place?.id, price: i.price, expiresOn: i.expires_on, variantId: variant?.id ?? null }], ...(i.note ? { evidence: { note: i.note } } : {}) }))[0]!
        : await stock.add({ productId: p.id, quantity, placeId: place?.id, expiresOn: i.expires_on, variantId: variant?.id ?? null, note: i.note });
      const paid = bought ? `, bought${shop ? ` at ${shop.name}` : ''}${i.price !== undefined ? ` for ${i.price.toFixed(2)}` : ''}` : '';
      return { message: `${p.name}: added ${said(units, p, quantity, i.quantity, i.unit)}${variant ? ` (${variant.name})` : ''}${place ? ` to ${place.name}` : ''}${paid}. ${leftText(units, p, s.inStock)} in stock.`, ...itemInfo(units, s) };
    },
  });
  addAction({
    id: 'use_stock', name: 'Use stock', description: 'Take some of an item out of stock (soonest-expiring first). Rechargeables go flat instead. For things Larder takes out by itself (a tea bag a day), this is an extra one; to start a new one now (a sensor that came off early) set opened.',
    input: z.object({
      item: Item,
      quantity: z.number().positive().optional().describe('How many, in what the item is bought in, or in `unit`. Default 1 (a whole one), or, when this starts a new one of something with a usage, its usual amount (2 lenses)'),
      place: z.string().max(200).optional().describe('Only use stock from this place'),
      opened: z.boolean().optional().describe('True if it was opened and is still being used (a new jar of coffee: it shows as open until finish_item), or, for something Larder takes out by itself, a new one started now'),
      note: z.string().max(200).optional().describe('Why, kept in its history, e.g. "Thrown away: out of date"'),
      unit: Unit,
    }),
    async run(i) {
      const [p, units] = await Promise.all([resolve.product(i.item), ctx.units()]);
      const placeId = i.place ? (await resolve.place(i.place)).id : undefined;
      // Starting one takes its usual amount unless told otherwise (or what's left, if less); one used a little
      // at a time (1 tea bag a day of a box, 4 g a day of a jar) starts a whole one.
      const starts = !!p.usage && !p.usage.unit && (!!i.opened || startsOne(p));
      const quantity = i.quantity !== undefined ? roundQty(toBoughtIn(units, p, i.quantity, i.unit))
        : starts ? await (async () => { const left = (await products.summary(p.id)).inStock; return left > 0 ? Math.min(p.usage!.amount, left) : p.usage!.amount; })() : 1;
      const s = await stock.use({ productId: p.id, quantity, placeId, open: i.opened, ...(i.note ? { note: i.note } : {}) });
      const n = said(units, p, quantity, i.quantity, i.unit);
      const uses = usageText(units, p);
      // Used a little at a time without Larder taking it out, a use is just a use.
      const what = !p.usage || (p.usage.unit && !p.usage.auto) ? `${i.opened ? 'opened' : 'used'} ${n}`
        : startsOne(p) ? `started ${n}${p.usage.auto ? `, and Larder takes them out from here (${uses})` : ''}`
          : i.opened ? `started a new one now (${n})` : `used ${n} extra (Larder also takes out ${uses})`;
      const until = s.runsOutOn ? `, enough until ${s.runsOutOn}` : '';
      return { message: `${p.name}: ${what}. ${leftText(units, p, s.inStock)} left${until}${s.status.low ? ', running low' : ''}.`, ...itemInfo(units, s) };
    },
  });
  addAction({
    id: 'finish_item', name: 'Finished the open one', description: 'The open one of an item is finished (the butter\'s gone), or the one in use is stopped: none is open, and Larder stops taking them out until one is started again.',
    input: z.object({ item: Item }),
    async run(i) {
      const [p, units] = await Promise.all([resolve.product(i.item), ctx.units()]);
      const s = await stock.finish(p.id);
      return { message: `${p.name}: the open one is finished. ${leftText(units, p, s.inStock)} left${s.status.low ? ', running low' : ''}.`, ...itemInfo(units, s) };
    },
  });
  addAction({
    id: 'move_item', name: 'Move item', description: 'Move an item to another place: for now (out of place) or for good (its usual place changes).',
    input: z.object({
      item: Item, to: z.string().min(1).max(200).describe('The place it\'s going to: a name or code'),
      quantity: z.number().positive().optional().describe('How many (default all of it), in what the item is bought in or in `unit`'),
      unit: Unit,
      permanent: z.boolean().default(false).describe('True if this is its new usual place'),
      from: z.string().max(200).optional().describe('Only move stock from this place, or "to sort" for stock with no place yet (put away for good)'),
    }),
    async run(i) {
      const [p, units] = await Promise.all([resolve.product(i.item), ctx.units()]);
      const place = await resolve.place(i.to);
      const toSort = !!i.from && /^(to sort|no place|unsorted|nowhere)$/i.test(i.from.trim());
      const fromPlaceId = !i.from ? undefined : toSort ? null : (await resolve.place(i.from)).id;
      const s = await stock.move({ productId: p.id, toPlaceId: place.id, quantity: i.quantity === undefined ? undefined : roundQty(toBoughtIn(units, p, i.quantity, i.unit)), mode: i.permanent || toSort ? 'permanent' : 'temporary', ...(fromPlaceId !== undefined ? { fromPlaceId } : {}) });
      return { message: `${p.name} moved to ${place.name}${i.permanent || toSort ? ' for good' : ''}.`, ...itemInfo(units, s) };
    },
  });
  addAction({
    id: 'put_back', name: 'Put back', description: 'Put an out-of-place item back in its usual place.',
    input: z.object({ item: Item, from: z.string().max(200).optional().describe('Only what\'s out of place in this place (default all of it)') }),
    async run(i) {
      const [p, units] = await Promise.all([resolve.product(i.item), ctx.units()]);
      let s: ProductSummary | null = null;
      if (i.from) {
        const where = await resolve.place(i.from);
        const away = (await products.get(p.id)).entries.filter((e) => e.currentPlaceId === where.id && e.currentPlaceId !== e.placeId);
        if (!away.length) throw new LarderError(`None of the ${p.name.toLowerCase()} is out of place in ${where.name}.`, 400, 'invalid');
        for (const e of away) s = await stock.returnHome({ productId: p.id, entryId: e.id });
      } else s = await stock.returnHome({ productId: p.id });
      if (!s) throw new LarderError(`${p.name} is already in its usual place.`, 400, 'invalid');
      return { message: `${p.name} is back in ${s.places[0]?.path ?? 'its usual place'}.`, ...itemInfo(units, s) };
    },
  });
  addAction({
    id: 'add_expected', name: 'Add expected delivery', description: 'Record something ordered but not arrived yet. It counts towards stock, so it isn\'t bought twice. If it\'s in a pending order from the same shop (a filled online basket), that is confirmed instead of adding it again.',
    input: z.object({
      item: Item, quantity: Quantity,
      source: z.string().min(1).max(80).describe('Where it\'s coming from, e.g. "Tesco delivery" or "Amazon"'),
      reference: z.string().max(80).optional().describe('Order number'),
      eta: IsoDate.optional().describe('Expected date (YYYY-MM-DD)'),
      unit: Unit,
      price: z.number().min(0).optional().describe('What the order says the line costs, e.g. 4.50: kept in the purchase history when it arrives'),
      place: z.string().max(200).optional().describe('Where it goes when it arrives: a place name or code. Defaults to its usual place'),
      pending: z.boolean().optional().describe('True if the order isn\'t confirmed yet (a filled online basket before checkout)'),
    }),
    async run(i) {
      const [p, units] = await Promise.all([resolve.product(i.item), ctx.units()]);
      const was = (await products.summary(p.id)).pending;
      const place = i.place ? await resolve.place(i.place) : null;
      const quantity = roundQty(toBoughtIn(units, p, i.quantity, i.unit));
      const amount = (n: number) => amountText(units, n, p.unit);
      const s = await stock.expect({ productId: p.id, quantity, source: i.source, reference: i.reference, eta: i.eta, price: i.price ?? null, ...(place ? { placeId: place.id } : {}), ...(i.pending ? { pending: true } : {}) });
      const confirmed = Math.max(0, roundQty(was - s.pending));
      const more = roundQty(quantity - confirmed);
      const message = i.pending
        ? `${p.name}: ${said(units, p, quantity, i.quantity, i.unit)} in a pending order from ${i.source}, not confirmed yet.`
        : confirmed
          ? `${p.name}: ${amount(confirmed)} in the pending order confirmed, now on the way${more > 0 ? `, and ${amount(more)} more expected from ${i.source}` : ''}.`
          : `${p.name}: ${said(units, p, quantity, i.quantity, i.unit)} expected from ${i.source}.`;
      return { message, confirmed, ...itemInfo(units, s) };
    },
  });
  addAction({
    id: 'confirm_order', name: 'Confirm order', description: 'A pending order went ahead (e.g. the online basket was checked out): it\'s on its way. A whole order by its source, or one item\'s.',
    input: z.object({
      source: z.string().max(80).optional().describe('The order, e.g. "Tesco delivery"'),
      item: Item.optional().describe('Or one item in it'),
    }),
    async run(i) {
      if (!i.source && !i.item) throw new LarderError('Say which order (source) or which item to confirm.', 400, 'invalid');
      const productId = i.item ? (await resolve.product(i.item)).id : undefined;
      const [r, units] = await Promise.all([stock.confirmOrders({ source: i.source, productId }), ctx.units()]);
      return { message: `Confirmed, on the way: ${r.products.map((s) => s.product.name).join(', ')}.`, confirmed: r.confirmed, items: r.products.map((s) => itemInfo(units, s)) };
    },
  });
  addAction({
    id: 'cancel_order', name: 'Remove pending order', description: 'A pending order didn\'t go ahead (the basket wasn\'t checked out): it stops counting towards stock, so what\'s still low is bought next time.',
    input: z.object({
      source: z.string().max(80).optional().describe('The order, e.g. "Tesco delivery"'),
      item: Item.optional().describe('Or one item in it'),
    }),
    async run(i) {
      if (!i.source && !i.item) throw new LarderError('Say which order (source) or which item to remove.', 400, 'invalid');
      const productId = i.item ? (await resolve.product(i.item)).id : undefined;
      const [r, units] = await Promise.all([stock.cancelOrders({ source: i.source, productId }), ctx.units()]);
      return { message: `Removed from the pending order: ${r.products.map((s) => s.product.name).join(', ')}.`, removed: r.removed, items: r.products.map((s) => itemInfo(units, s)) };
    },
  });
  addAction({
    id: 'mark_arrived', name: 'Mark arrived', description: 'A delivery arrived: everything from a source, or some of one item.',
    input: z.object({
      source: z.string().max(80).optional().describe('The delivery, e.g. "Tesco delivery"'),
      item: Item.optional().describe('Or one item that arrived'),
      quantity: z.number().positive().optional().describe('How many of the item arrived (default all expected), in what it\'s bought in or in `unit`'),
      unit: Unit,
      due_by: IsoDate.optional().describe('With a source: only what was due by this day (YYYY-MM-DD), so a later order from the same shop stays on its way'),
    }),
    async run(i) {
      if (!i.source && !i.item) throw new LarderError('Say which delivery (source) or which item arrived.', 400, 'invalid');
      const [product, units] = await Promise.all([i.item ? resolve.product(i.item) : null, ctx.units()]);
      const productId = product?.id;
      const quantity = i.quantity === undefined ? undefined : product ? roundQty(toBoughtIn(units, product, i.quantity, i.unit)) : i.quantity;
      const r = await stock.arrive({ source: i.source, productId, quantity, ...(i.due_by ? { dueBy: i.due_by } : {}) });
      const names = r.products.map((s) => s.product.name);
      const left = r.pendingLeft ? ` ${r.pendingLeft} more from that order ${r.pendingLeft === 1 ? 'was' : 'were'} never confirmed and ${r.pendingLeft === 1 ? 'is' : 'are'} still pending: confirm or remove ${r.pendingLeft === 1 ? 'it' : 'them'}.` : '';
      return { message: `Arrived: ${names.join(', ')}.${left}`, arrived: r.arrived, pending_left: r.pendingLeft, items: r.products.map((s) => itemInfo(units, s)) };
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
      const [p, units] = await Promise.all([resolve.product(i.item), ctx.units()]);
      const s = await stock.charge({ productId: p.id, quantity: i.quantity });
      return { message: `${p.name}: ${amountText(units, s.charged ?? 0, p.unit)} charged, ${amountText(units, s.flat ?? 0, p.unit)} flat.`, ...itemInfo(units, s), charged: s.charged, flat: s.flat };
    },
  });
  addAction({
    id: 'renew', name: 'Renew', description: 'A renewal (insurance, MOT, boiler service) has been renewed: restart its clock from today.',
    input: z.object({ item: Item }),
    async run(i) {
      const [p, units] = await Promise.all([resolve.product(i.item), ctx.units()]);
      const s = await stock.renew(p.id);
      return { message: `${p.name} renewed. Next due ${s.nextExpiry}.`, ...itemInfo(units, s) };
    },
  });
  addAction({
    id: 'find_item', name: 'Find item', description: 'Look up an item: how many, where, and when it expires.',
    input: z.object({ item: Item }),
    async run(i) {
      const [p, units] = await Promise.all([resolve.product(i.item), ctx.units()]);
      const s = await products.summary(p.id);
      const where = placesText(units, s);
      return { message: `${brief(units, s)}${where ? ` ${where[0]!.toUpperCase()}${where.slice(1)}.` : ''}${s.nowIn.length ? ` Now in ${s.nowIn.map((x) => x.path).join(' and ')}.` : ''}`, ...itemInfo(units, s) };
    },
  });
  addAction({
    id: 'shopping_list_for', name: 'Shopping list for a shop', description: 'Everything to buy at a shop: its favourites plus "any shop" items in categories it sells.',
    input: z.object({ shop: z.string().min(1).max(80).describe('The shop, e.g. "Aldi"') }),
    async run(i) {
      const shop = await resolve.shop(i.shop);
      const [list, units] = await Promise.all([shopping.forShop(shop.id), ctx.units()]);
      const items = list.groups.flatMap((g) => g.items.map((it) => ({ item: it.summary.product.name, quantity: it.quantity, unit: unitsOf(units, it.summary.product.unit), category: g.category?.name ?? null })));
      return { message: items.length ? `${items.length} thing${items.length === 1 ? '' : 's'} to get at ${shop.name}: ${items.map((x) => x.item).join(', ')}.` : `Nothing to get at ${shop.name}.`, shop: shop.name, items };
    },
  });

  /* ----------------------------- expiry check ---------------------------- */

  type Notified = Record<string, { expiresOn: string; warned: boolean; expired: boolean }>;
  // One check at a time, so a manual check during the hourly one can't announce things twice.
  let checking: Promise<unknown> = Promise.resolve();

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
     * Takes out of stock what Larder takes out by itself (see stock.takeDue), then
     * publishes `stock.expiring` once when an item enters its warning window and
     * `stock.expired` once on the day it expires. Safe to call as often as you
     * like; the server calls it hourly.
     */
    checkExpiry(): Promise<{ expiring: number; expired: number; taken: number }> {
      const run = checking.then(() => this.checkExpiryNow(), () => this.checkExpiryNow());
      checking = run.catch(() => undefined);
      return run;
    },

    async checkExpiryNow(): Promise<{ expiring: number; expired: number; taken: number }> {
      const { taken } = await stock.takeDue();
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
      return { expiring, expired, taken };
    },
  };
}

export type Automation = ReturnType<typeof createAutomation>;
