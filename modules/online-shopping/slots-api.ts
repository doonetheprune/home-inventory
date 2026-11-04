/**
 * Delivery slots and the start of a shop: list_slots (in everyday words),
 * book_slot, and start_shop, which checks the shop is ready and walks an
 * assistant through "do me a shop".
 */
import { z } from 'zod';
import { Id, LarderError, ValidationError, type ModuleContext, type Shop as ShopRecord } from '@larder/core';
import type { SlotList } from './contract';
import { money } from './format';
import type { Provider } from './providers';
import { Shop } from './providers-api';
import type { Services } from './services';
import { BookingInfo, slotText, type Shops } from './shop';

const ListedSlots = z.object({ listedAt: z.string(), date: z.string(), described: z.string(), slots: z.array(z.object({ id: z.string(), start: z.string(), end: z.string(), price: z.number(), available: z.boolean() })) });
type ListedSlots = z.infer<typeof ListedSlots>;

export function slotFeatures(ctx: ModuleContext, s: Services, shops: Shops) {
  const { providers } = s;
  // The slots listed at each provider in the last hour, so a booking knows when its slot is
  // (the app looks at a few days before picking one).
  const listed = ctx.collection<ListedSlots>('slots');
  const HOUR = 3_600_000;

  async function list(provider: Provider, when: string): Promise<SlotList> {
    if (!s.can(provider, 'slot_booking')) throw new ValidationError(`The ${await providers.shopName(provider.shopId)} provider can't book delivery slots. Book one on the shop's website.`);
    const w = when.trim();
    const answer = await (await s.ready(provider)).slots(/^\d{4}-\d{2}-\d{2}$/.test(w) ? { date: w } : { when: w });
    const before = await listed.get(provider.id);
    const recent = before && Date.parse(ctx.core.now()) - Date.parse(before.listedAt) < HOUR ? before.slots : [];
    const ids = new Set(answer.slots.map((x) => x.id));
    await listed.put(provider.id, ListedSlots.parse({
      listedAt: ctx.core.now(), date: answer.date, described: answer.described,
      slots: [...answer.slots, ...recent.filter((x) => !ids.has(x.id) && x.start.slice(0, 10) !== answer.date)],
    }));
    return answer;
  }

  async function book(provider: Provider, slotId: string): Promise<BookingInfo> {
    const known = (await listed.get(provider.id))?.slots.find((x) => x.id === slotId);
    if (!known) throw new ValidationError('Larder doesn\'t know that slot. List the slots again (list_slots), then book one from that list.');
    if (!s.can(provider, 'slot_booking')) throw new ValidationError(`The ${await providers.shopName(provider.shopId)} provider can't book delivery slots.`);
    const b = await (await s.ready(provider)).book(slotId);
    const info = BookingInfo.parse({ slotId, start: known.start, end: known.end, price: known.price, reference: b.booking_reference, reservedUntil: b.reserved_until, bookedAt: ctx.core.now() });
    await shops.setBooking(provider.id, info);
    ctx.publish('online-shopping.slot_booked', { shop: await providers.shopName(provider.shopId), slot: slotText(info), start: info.start, end: info.end, reference: info.reference, reserved_until: info.reservedUntil });
    return info;
  }

  async function slotsText(shopName: string, l: SlotList, currency: string): Promise<string> {
    const free = l.slots.filter((x) => x.available);
    const head = `${l.described || l.date} at ${shopName}:`;
    if (!free.length) return `${head} no slots free. Try another day or time.`;
    const time = (x: { start: string; end: string }) => `${x.start.slice(11, 16)}–${x.end.slice(11, 16)}`;
    return [
      head,
      ...free.map((x) => `- ${time(x)}, ${x.price ? money(x.price, currency) : 'free'} (id ${x.id})`),
      'Say the day back to the person so a misread shows, suggest one, and book it with book_slot once they agree.',
    ].join('\n');
  }

  const bookingText = (b: BookingInfo, shopName: string) =>
    `Booked ${slotText(b)} at ${shopName}${b.reference ? ` (ref ${b.reference})` : ''}${b.reservedUntil ? `. It's held until ${b.reservedUntil.slice(11, 16)} on ${b.reservedUntil.slice(0, 10)} unless the order is checked out` : ''}.`;

  async function forShopId(shopId: string): Promise<{ provider: Provider; shop: ShopRecord }> {
    const provider = await providers.forShop(shopId);
    const shop = (await ctx.core.shops.list()).find((x) => x.id === shopId);
    if (!provider || !shop) throw new LarderError('That shop has no shopping provider. Link one to it in Settings → Larder Automations.', 409, 'no_provider');
    return { provider, shop };
  }

  /* ---------------------------------- Routes --------------------------------- */

  ctx.addRoute({
    method: 'GET', path: '/shops/:shopId/slots', summary: 'Delivery slots for a day, in everyday words ("tomorrow evening") or YYYY-MM-DD',
    params: z.object({ shopId: Id }), query: z.object({ when: z.string().min(1).max(100) }),
    response: z.object({ date: z.string(), described: z.string(), slots: z.array(z.object({ id: z.string(), start: z.string(), end: z.string(), price: z.number(), available: z.boolean() })) }),
    async handler({ params, query }) {
      const { provider } = await forShopId(params.shopId);
      const l = await list(provider, query.when);
      return { date: l.date, described: l.described, slots: l.slots };
    },
  });

  ctx.addRoute({
    method: 'POST', path: '/shops/:shopId/book', summary: 'Book a delivery slot from the last list',
    params: z.object({ shopId: Id }), body: z.object({ slotId: z.string().min(1) }),
    response: z.object({ booking: BookingInfo, message: z.string() }),
    async handler({ params, body }) {
      const { provider, shop } = await forShopId(params.shopId);
      const b = await book(provider, body.slotId);
      return { booking: b, message: bookingText(b, shop.name) };
    },
  });

  ctx.addRoute({
    method: 'GET', path: '/shops/:shopId/booking', summary: 'The delivery slot booked at a shop, while it\'s still to come',
    params: z.object({ shopId: Id }), response: z.object({ booking: BookingInfo.nullable() }),
    async handler({ params }) {
      const p = await providers.forShop(params.shopId);
      return { booking: p ? await shops.booking(p.id) : null };
    },
  });

  /* ---------------------------------- Tools ---------------------------------- */

  const When = z.string().min(1).max(100).describe('The day, in words ("tomorrow", "friday evening", "next monday after 6pm") or YYYY-MM-DD');

  ctx.addTool({
    name: 'start_shop', title: 'Start an online shop',
    description: 'Begin "do me a shop": checks the shop is ready (waking its computer if needed), then lists delivery slots for when the person wants it. Ask when first if they haven\'t said. Next: book_slot once they pick one, then fill_basket.',
    input: z.object({ shop: Shop, when: When.optional() }),
    async run({ shop, when }) {
      const { provider, shop: sh } = await providers.resolve(shop);
      await s.ready(provider);
      const booked = await shops.booking(provider.id);
      const lines = [`${sh.name} is ready.`];
      if (booked) lines.push(`A slot is already booked: ${slotText(booked)}${booked.reference ? ` (ref ${booked.reference})` : ''}. Fill the basket with fill_basket, or book another.`);
      if (!s.can(provider, 'slot_booking')) {
        lines.push(`The ${sh.name} provider can't book slots, so book one on ${sh.name}'s website. Then fill the basket with fill_basket.`);
      } else if (!when) {
        lines.push('Ask when they\'d like it delivered (e.g. "tomorrow evening"), then call start_shop again with when.');
      } else {
        lines.push(await slotsText(sh.name, await list(provider, when), await s.currency()));
        lines.push('After booking, fill the basket with fill_basket.');
      }
      return { text: lines.join('\n'), data: { shop: sh.name, booked } };
    },
  });

  ctx.addTool({
    name: 'list_slots', title: 'List delivery slots', readOnly: true,
    description: 'Free delivery slots at an online shop for a day, in everyday words. Say the day back so a misread shows.',
    input: z.object({ when: When, shop: Shop }),
    async run({ when, shop }) {
      const { provider, shop: sh } = await providers.resolve(shop);
      const l = await list(provider, when);
      return { text: await slotsText(sh.name, l, await s.currency()), data: { date: l.date, described: l.described, slots: l.slots } };
    },
  });

  ctx.addTool({
    name: 'book_slot', title: 'Book a delivery slot',
    description: 'Book a delivery slot from list_slots, only once the person has agreed to it. Offers in fill_basket are then checked for that day.',
    input: z.object({ slot_id: z.string().min(1).max(200).describe('The id from list_slots'), shop: Shop }),
    async run({ slot_id, shop }) {
      const { provider, shop: sh } = await providers.resolve(shop);
      const b = await book(provider, slot_id);
      return { text: `${bookingText(b, sh.name)} Next: fill_basket.`, data: { booking: b } };
    },
  });
}
