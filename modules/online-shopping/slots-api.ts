/**
 * Delivery and click and collect slots, and the start of a shop: list_slots
 * (in everyday words, at a branch for collection), book_slot, and start_shop,
 * which checks the shop is ready and walks an assistant through "do me a shop".
 */
import { z } from 'zod';
import { Id, LarderError, ValidationError, type ModuleContext, type Shop as ShopRecord } from '@larder/core';
import { Store, type SlotList, type SlotMethod } from './contract';
import { money } from './format';
import type { Provider } from './providers';
import { Shop } from './providers-api';
import type { Services } from './services';
import { BookingInfo, bookedSlotText, slotText, type Shops } from './shop';

const ListedSlot = z.object({
  id: z.string(), start: z.string(), end: z.string(), price: z.number(), available: z.boolean(),
  method: z.enum(['delivery', 'collection']).default('delivery'),
  /** For collection: the branch's name. */
  store: z.string().nullable().default(null),
});
type ListedSlot = z.infer<typeof ListedSlot>;
const ListedSlots = z.object({ listedAt: z.string(), date: z.string(), described: z.string(), slots: z.array(ListedSlot) });
type ListedSlots = z.infer<typeof ListedSlots>;

const SlotJson = z.object({ id: z.string(), start: z.string(), end: z.string(), price: z.number(), available: z.boolean() });

export function slotFeatures(ctx: ModuleContext, s: Services, shops: Shops) {
  const { providers } = s;
  // The slots listed at each provider in the last hour, so a booking knows when (and where) its slot is
  // (the app looks at a few days, and maybe a few branches, before picking one).
  const listed = ctx.collection<ListedSlots>('slots');
  const HOUR = 3_600_000;
  /** Only when the provider has said so: offering collection to one that can't would only fail. */
  const canCollect = (p: Provider) => !!p.status?.capabilities.includes('click_and_collect');
  const noSlotsText = (shopName: string) => `${shopName} has no delivery or collection slots to book. Fill the basket with fill_basket; offers are checked for today.`;
  const kind = (method: SlotMethod) => (method === 'collection' ? 'click and collect' : 'delivery');
  const capability = (method: SlotMethod) => (method === 'collection' ? 'click_and_collect' : 'slot_booking');

  async function list(provider: Provider, when: string, method: SlotMethod = 'delivery', branch?: string): Promise<SlotList> {
    if (s.noSlots(provider)) throw new ValidationError(noSlotsText(await providers.shopName(provider.shopId)));
    if (!s.can(provider, capability(method))) throw new ValidationError(`The ${await providers.shopName(provider.shopId)} provider can't book ${kind(method)} slots. Book one on the shop's website.`);
    const w = when.trim();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(w) ? { date: w } : { when: w };
    const answer = await (await s.ready(provider)).slots({ ...day, method, ...(method === 'collection' && branch?.trim() ? { store: branch.trim() } : {}) });
    const store = answer.store?.name ?? null;
    const before = await listed.get(provider.id);
    const recent = before && Date.parse(ctx.core.now()) - Date.parse(before.listedAt) < HOUR ? ListedSlots.parse(before).slots : [];
    const ids = new Set(answer.slots.map((x) => x.id));
    // This list replaces the last one for the same day, method and branch; the others are kept for the hour.
    const sameList = (x: ListedSlot) => x.start.slice(0, 10) === answer.date && x.method === answer.method && x.store === store;
    await listed.put(provider.id, ListedSlots.parse({
      listedAt: ctx.core.now(), date: answer.date, described: answer.described,
      slots: [...answer.slots.map((x) => ({ ...x, method: answer.method, store })), ...recent.filter((x) => !ids.has(x.id) && !sameList(x))],
    }));
    return answer;
  }

  async function book(provider: Provider, slotId: string): Promise<BookingInfo> {
    const known = (await listed.get(provider.id))?.slots.find((x) => x.id === slotId);
    if (!known) throw new ValidationError('Larder doesn\'t know that slot. List the slots again (list_slots), then book one from that list.');
    const slot = ListedSlot.parse(known);
    const shopName = await providers.shopName(provider.shopId);
    if (s.noSlots(provider)) throw new ValidationError(noSlotsText(shopName));
    if (!s.can(provider, capability(slot.method))) throw new ValidationError(`The ${shopName} provider can't book ${kind(slot.method)} slots.`);
    const b = await (await s.ready(provider)).book(slotId);
    const info = BookingInfo.parse({
      slotId, start: slot.start, end: slot.end, price: slot.price, reference: b.booking_reference, reservedUntil: b.reserved_until, bookedAt: ctx.core.now(),
      method: slot.method, store: b.store?.name ?? slot.store,
    });
    await shops.setBooking(provider.id, info);
    ctx.publish('online-shopping.slot_booked', {
      shop: shopName, slot: bookedSlotText(info), start: info.start, end: info.end, reference: info.reference, reserved_until: info.reservedUntil,
      method: info.method, store: info.store,
    });
    return info;
  }

  async function slotsText(shopName: string, l: SlotList, currency: string, offerCollection: boolean): Promise<string> {
    const free = l.slots.filter((x) => x.available);
    const head = l.store
      ? `Click and collect at ${shopName} ${l.store.name}${l.store.address ? ` (${l.store.address})` : ''}, ${l.described || l.date}:`
      : `${l.described || l.date} at ${shopName}:`;
    const others = l.stores.length ? `Other branches to collect from (pass one as branch): ${l.stores.map((x) => x.name).join('; ')}.` : null;
    if (!free.length) {
      if (l.method === 'collection') return [`${head} no collection slots free. Try another day or time${l.stores.length ? ', or another branch' : ''}.`, others].filter(Boolean).join('\n');
      if (offerCollection) return `${head} no delivery slots free. Offer click and collect instead; if they want it, list_slots with method "collection" (${shopName}'s usual branch, or another by name).`;
      return `${head} no slots free. Try another day or time.`;
    }
    const time = (x: { start: string; end: string }) => `${x.start.slice(11, 16)}–${x.end.slice(11, 16)}`;
    return [
      head,
      ...free.map((x) => `- ${time(x)}, ${x.price ? money(x.price, currency) : 'free'} (id ${x.id})`),
      others,
      l.store
        ? 'Say the day and the branch back to the person so a misread shows, suggest one, and book it with book_slot once they agree.'
        : 'Say the day back to the person so a misread shows, suggest one, and book it with book_slot once they agree.',
    ].filter(Boolean).join('\n');
  }

  const bookingText = (b: BookingInfo, shopName: string) => {
    const what = b.method === 'collection' ? `click and collect at ${shopName}${b.store ? ` ${b.store}` : ''}, ${slotText(b)}` : `${slotText(b)} at ${shopName}`;
    return `Booked ${what}${b.reference ? ` (ref ${b.reference})` : ''}${b.reservedUntil ? `. It's held until ${b.reservedUntil.slice(11, 16)} on ${b.reservedUntil.slice(0, 10)} unless the order is checked out` : ''}.`;
  };

  async function forShopId(shopId: string): Promise<{ provider: Provider; shop: ShopRecord }> {
    const provider = await providers.forShop(shopId);
    const shop = (await ctx.core.shops.list()).find((x) => x.id === shopId);
    if (!provider || !shop) throw new LarderError('That shop has no shopping provider. Link one to it in Settings → Larder Automations.', 409, 'no_provider');
    return { provider, shop };
  }

  /* ---------------------------------- Routes --------------------------------- */

  const Method = z.enum(['delivery', 'collection']);

  ctx.addRoute({
    method: 'GET', path: '/shops/:shopId/slots', summary: 'Delivery or click and collect slots for a day, in everyday words ("tomorrow evening") or YYYY-MM-DD',
    params: z.object({ shopId: Id }),
    query: z.object({ when: z.string().min(1).max(100), method: Method.default('delivery'), branch: z.string().min(1).max(100).optional() }),
    response: z.object({
      date: z.string(), described: z.string(), method: Method, store: Store.nullable(), stores: z.array(Store), slots: z.array(SlotJson),
      /** No delivery slots free that day, and the shop does click and collect. */
      offerCollection: z.boolean(),
    }),
    async handler({ params, query }) {
      const { provider } = await forShopId(params.shopId);
      const l = await list(provider, query.when, query.method, query.branch);
      const offerCollection = l.method === 'delivery' && !l.slots.some((x) => x.available) && canCollect(provider);
      return { date: l.date, described: l.described, method: l.method, store: l.store, stores: l.stores, slots: l.slots, offerCollection };
    },
  });

  ctx.addRoute({
    method: 'POST', path: '/shops/:shopId/book', summary: 'Book a delivery or click and collect slot from the last list',
    params: z.object({ shopId: Id }), body: z.object({ slotId: z.string().min(1) }),
    response: z.object({ booking: BookingInfo, message: z.string() }),
    async handler({ params, body }) {
      const { provider, shop } = await forShopId(params.shopId);
      const b = await book(provider, body.slotId);
      return { booking: b, message: bookingText(b, shop.name) };
    },
  });

  ctx.addRoute({
    method: 'GET', path: '/shops/:shopId/booking', summary: 'The slot booked at a shop, while it\'s still to come',
    params: z.object({ shopId: Id }), response: z.object({ booking: BookingInfo.nullable() }),
    async handler({ params }) {
      const p = await providers.forShop(params.shopId);
      return { booking: p ? await shops.booking(p.id) : null };
    },
  });

  /* ---------------------------------- Tools ---------------------------------- */

  const When = z.string().min(1).max(100).describe('The day, in words ("tomorrow", "friday evening", "next monday after 6pm") or YYYY-MM-DD');
  const MethodInput = Method.optional().describe('"collection" for click and collect. Leave out for delivery');
  const Branch = z.string().min(1).max(100).optional().describe('For collection: which branch, by name (e.g. "southport"), from the branches the last list named. Leave out for the usual one');

  ctx.addTool({
    name: 'start_shop', title: 'Start an online shop',
    description: 'Begin "do me a shop": checks the shop is ready (waking its computer if needed), then lists delivery slots (or click and collect ones, with method "collection") for when the person wants it; a shop without slots goes straight to fill_basket. Ask when first if they haven\'t said. Next: book_slot once they pick one, then fill_basket.',
    input: z.object({ shop: Shop, when: When.optional(), method: MethodInput, branch: Branch }),
    async run({ shop, when, method, branch }) {
      const { provider, shop: sh } = await providers.resolve(shop);
      await s.ready(provider);
      const booked = await shops.booking(provider.id);
      const how = method ?? 'delivery';
      const lines = [`${sh.name} is ready.`];
      if (s.noSlots(provider)) {
        lines.push(`${sh.name} has no delivery or collection slots, so there's no slot to pick: fill the basket with fill_basket (offers are checked for today).`);
        return { text: lines.join('\n'), data: { shop: sh.name, booked: null } };
      }
      if (booked) lines.push(`A slot is already booked: ${bookedSlotText(booked)}${booked.reference ? ` (ref ${booked.reference})` : ''}. Fill the basket with fill_basket, or book another.`);
      if (!s.can(provider, capability(how))) {
        lines.push(`The ${sh.name} provider can't book ${how === 'collection' ? 'click and collect slots' : 'slots'}, so book one on ${sh.name}'s website. Then fill the basket with fill_basket.`);
      } else if (!when) {
        lines.push(how === 'collection'
          ? 'Ask when they\'d like to collect it (e.g. "tomorrow evening"), then call start_shop again with when.'
          : `Ask when they'd like it delivered (e.g. "tomorrow evening")${canCollect(provider) ? ' or whether they\'d rather click and collect' : ''}, then call start_shop again with when.`);
      } else {
        lines.push(await slotsText(sh.name, await list(provider, when, how, branch), await s.currency(), canCollect(provider)));
        lines.push('After booking, fill the basket with fill_basket.');
      }
      return { text: lines.join('\n'), data: { shop: sh.name, booked } };
    },
  });

  ctx.addTool({
    name: 'list_slots', title: 'List delivery or click and collect slots', readOnly: true,
    description: 'Free delivery slots at an online shop for a day, in everyday words. With method "collection", click and collect slots instead, at the shop\'s usual branch or the one named in branch; the answer names the branch and the others nearby. Say the day (and branch) back so a misread shows. When no delivery slots are free and the shop does click and collect, the answer says to offer it.',
    input: z.object({ when: When, shop: Shop, method: MethodInput, branch: Branch }),
    async run({ when, shop, method, branch }) {
      const { provider, shop: sh } = await providers.resolve(shop);
      const l = await list(provider, when, method ?? 'delivery', branch);
      return {
        text: await slotsText(sh.name, l, await s.currency(), canCollect(provider)),
        data: { date: l.date, described: l.described, method: l.method, store: l.store, stores: l.stores, slots: l.slots },
      };
    },
  });

  ctx.addTool({
    name: 'book_slot', title: 'Book a delivery or click and collect slot',
    description: 'Book a delivery or click and collect slot from list_slots, only once the person has agreed to it (and, for collection, to the branch). Offers in fill_basket are then checked for that day.',
    input: z.object({ slot_id: z.string().min(1).max(200).describe('The id from list_slots'), shop: Shop }),
    async run({ slot_id, shop }) {
      const { provider, shop: sh } = await providers.resolve(shop);
      const b = await book(provider, slot_id);
      return { text: `${bookingText(b, sh.name)} Next: fill_basket.`, data: { booking: b } };
    },
  });
}
