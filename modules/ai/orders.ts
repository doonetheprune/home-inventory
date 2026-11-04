/**
 * Order confirmation emails: the AI reads one (the email module finds it in
 * Gmail and says which shop it's from) and matches each line to an item the
 * household has, as a receipt's lines are, with the same remembered names. It
 * also says what won't come and when the order (or part of it) arrives. Offered
 * to other modules as "ai.order-reader"; nothing is changed here.
 */
import { z } from 'zod';
import type { ModuleContext } from '@larder/core';
import type { OrderEmail, OrderEmailReading, OrderReader } from '../_shared/order-email';
import type { Task } from './providers';
import { householdItems, itemMemory, matcher, MAX_LINES, type Asked, type Known, type Learnt } from './receipts';

/** What the AI read from the email. */
export const OrderReading = z.object({
  readable: z.boolean().describe('False if this is not an order confirmation you can read'),
  reference: z.string().nullable().describe('The order number'),
  delivery_date: z.string().nullable().describe('When the order is delivered or ready to collect, as YYYY-MM-DD'),
  delivery_from: z.string().nullable().describe('When the delivery slot starts, as HH:MM'),
  delivery_to: z.string().nullable().describe('When the delivery slot ends, as HH:MM'),
  lines: z.array(z.object({
    text: z.string().describe('The product as the email names it'),
    count: z.number().describe('How many were ordered'),
    price: z.number().nullable().describe('The price for the line in all'),
    item: z.number().nullable().describe('The number of the household item it is, or null if none is'),
    quantity: z.number().nullable().describe('How much of that item\'s unit it is in all'),
    sure: z.boolean().describe('True if it is certainly that item'),
    status: z.enum(['coming', 'unavailable']).describe('unavailable if the email says it will not come'),
    delivery_date: z.string().nullable().describe('When this line comes, as YYYY-MM-DD, only if not with the rest'),
  })),
});
export type OrderReading = z.infer<typeof OrderReading>;

const GEMINI_ORDER = {
  type: 'OBJECT',
  properties: {
    readable: { type: 'BOOLEAN' },
    reference: { type: 'STRING', nullable: true },
    delivery_date: { type: 'STRING', nullable: true },
    delivery_from: { type: 'STRING', nullable: true },
    delivery_to: { type: 'STRING', nullable: true },
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          count: { type: 'NUMBER' },
          price: { type: 'NUMBER', nullable: true },
          item: { type: 'INTEGER', nullable: true },
          quantity: { type: 'NUMBER', nullable: true },
          sure: { type: 'BOOLEAN' },
          status: { type: 'STRING', format: 'enum', enum: ['coming', 'unavailable'] },
          delivery_date: { type: 'STRING', nullable: true },
        },
        required: ['text', 'count', 'price', 'item', 'quantity', 'sure', 'status', 'delivery_date'],
      },
    },
  },
  required: ['readable', 'reference', 'delivery_date', 'delivery_from', 'delivery_to', 'lines'],
};

/** Long emails are cut: an order's lines come well within this. */
export const MAX_EMAIL = 40_000;

/** The email as the AI is given it. */
export function emailText(email: OrderEmail): string {
  return [`The order email from ${email.shopName}, subject ${JSON.stringify(email.subject)}:`, '<<<', email.text.slice(0, MAX_EMAIL), '>>>'].join('\n');
}

/** What to read from the email, and the household's items to match against. */
export function orderPrompt(email: OrderEmail, known: Known[], learnt: Learnt[], shopName: (id: string | null) => string | null): string {
  const sent = email.sentAt.slice(0, 10);
  return [
    `Above is ${email.shopName}'s email confirming an order, sent on ${sent}. List what was ordered and when it comes, and match each line to one of the household's items listed below. Fill in each field:`,
    '- reference: the order number. Null if it is not shown.',
    `- delivery_date: the day the order is delivered or ready to collect, as YYYY-MM-DD. The email was sent on ${sent}, so a weekday means the next one after that. Null if it is not shown.`,
    '- delivery_from and delivery_to: the delivery slot\'s start and end in 24-hour time, e.g. "10:00" and "11:00". Null if no time is given.',
    '- lines: one for each product in the order, including ones the email says are unavailable, out of stock or replaced. Leave out delivery charges, bags, totals, vouchers, points and savings. For each line:',
    '  - text: the product as the email names it.',
    '  - count: how many were ordered. 1 if it does not say.',
    '  - price: the price for the line in all, as a number (2.5 for £2.50). Null if it is not shown.',
    '  - item: the number of the household\'s item it is. Match on what it is, not the exact words: another brand or size of the same thing is still that item. Null if none of the items is it: never pick the nearest one just to have one.',
    '  - quantity: how much of that item\'s unit the line is in all. Two 9-roll packs of an item counted in rolls is 18. Null if item is null.',
    '  - sure: true if it is certainly that item, false if it might be something else.',
    '  - status: "unavailable" if the email says it will not come (unavailable, out of stock, not available, removed from the order); otherwise "coming". A substitute is coming: give the substitute\'s name as text.',
    '  - delivery_date: only when this line comes on a different day from the rest of the order (a separate delivery), as YYYY-MM-DD; otherwise null.',
    '- readable: false if this is not an order confirmation you can read. Then give what you can.',
    '',
    ...householdItems(known, learnt, shopName),
  ].join('\n');
}

export const orderTask = (prompt: string): Task<OrderReading> => ({ prompt, schema: OrderReading, gemini: GEMINI_ORDER, effort: 'medium' });

const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) && !Number.isNaN(Date.parse(s.trim()));
const date = (s: string | null | undefined) => (isDate(s) ? s.trim() : null);
/** "9:30" and "09:30" are 09:30; anything else is no time. */
function time(s: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
}
const pence = (n: number) => Math.round(n * 100) / 100;

export interface OrderDeps {
  ready(): Promise<boolean>;
  /** Asks the AIs in the household's order about some text. */
  ask<T>(text: string, task: () => Promise<Task<T>>): Promise<Asked<T>>;
}

export function orderReader(ctx: ModuleContext, deps: OrderDeps): OrderReader {
  const memory = itemMemory(ctx);
  return {
    ready: deps.ready,
    remember: (shopId, text, productId, each) => memory.remember(shopId, text, productId, each),
    async read(email): Promise<OrderEmailReading> {
      const shops = await ctx.core.shops.list();
      const shopName = (id: string | null) => (id ? shops.find((s) => s.id === id)?.name ?? null : null);
      let known: Known[] = [];
      let learnt: Learnt[] = [];
      const asked = await deps.ask(emailText(email), async () => {
        ({ known, learnt } = await memory.load());
        return orderTask(orderPrompt(email, known, learnt, shopName));
      });
      const r = asked.answer;
      const match = matcher(known, learnt, email.shopId);
      const from = time(r.delivery_from);
      const to = time(r.delivery_to);
      return {
        readable: r.readable,
        reference: (r.reference ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || null,
        delivery: { date: date(r.delivery_date), from, to: from ? to : null },
        lines: r.lines.slice(0, MAX_LINES).map((l) => ({
          ...match(l),
          status: l.status === 'unavailable' ? 'unavailable' as const : 'coming' as const,
          date: date(l.delivery_date),
          price: typeof l.price === 'number' && Number.isFinite(l.price) && l.price >= 0 ? pence(l.price) : null,
        })),
        provider: asked.provider,
        model: asked.model,
      };
    },
  };
}
