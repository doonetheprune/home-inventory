/**
 * A shop at one provider, run in the background: wake and check it, quote
 * the candidates, plan, and (to fill) add to the basket and record what's on
 * the way as expected deliveries. One at a time per provider. Each run is kept
 * so its progress and summary can be asked for (shop_status, the app).
 */
import { z } from 'zod';
import { LarderError, NotFoundError, amount, andList, newId, type ModuleContext, type Shop } from '@larder/core';
import { BasketAddResult, ProviderError, STOPPING } from './client';
import type { QuoteLine } from './contract';
import { money, perUnit } from './format';
import { fieldsOf, rulesFor } from './items';
import { dailyUse, isCandidate, plan, type Candidate, type Plan } from './plan';
import type { Provider } from './providers';
import type { Services } from './services';

export const Options = z.object({
  /** Rounding up to complete a multibuy may go this many percent over the level. */
  multibuyOverPercent: z.number().int().min(0).max(200).default(25),
});
export type Options = z.infer<typeof Options>;

export const BookingInfo = z.object({
  slotId: z.string(),
  start: z.string(),
  end: z.string(),
  price: z.number().nullable().default(null),
  reference: z.string().nullable(),
  reservedUntil: z.string().nullable(),
  bookedAt: z.string(),
});
export type BookingInfo = z.infer<typeof BookingInfo>;

const PlannedLineSchema = z.object({ listingId: z.string(), name: z.string(), packs: z.number(), quantity: z.number(), cost: z.number(), deal: z.string().nullable(), roundedForDeal: z.boolean() });
export const PlanSchema = z.object({
  items: z.array(z.object({
    productId: z.string(), name: z.string(), unit: z.string(), reason: z.enum(['offer', 'low', 'manual']), have: z.number(), level: z.number(), needed: z.number(),
    unitPrice: z.number().nullable(), targetPrice: z.number().nullable(), capped: z.string().nullable(), lines: z.array(PlannedLineSchema), quantity: z.number(), cost: z.number(),
  })),
  skipped: z.array(z.object({ productId: z.string(), name: z.string(), why: z.string() })),
  unavailable: z.array(z.object({ productId: z.string(), name: z.string(), why: z.string() })),
  relink: z.array(z.object({ productId: z.string(), name: z.string(), listingId: z.string(), listingName: z.string() })),
  otherDeals: z.array(z.object({ productId: z.string(), name: z.string(), listingName: z.string(), text: z.string() })),
  lines: z.array(z.object({ listing_id: z.string(), quantity: z.number() })),
  total: z.number(),
}).meta({ id: 'OnlineShopPlan' });

export const Run = z.object({
  id: z.string(),
  shopId: z.string(),
  shopName: z.string(),
  providerId: z.string(),
  /** plan: work out the basket only. fill: and add it to the shop's basket. */
  kind: z.enum(['plan', 'fill']),
  status: z.enum(['running', 'done', 'failed']),
  /** What it's doing now, or did last. */
  step: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** The day offers had to cover. */
  deliveryDate: z.string(),
  booking: BookingInfo.nullable(),
  plan: PlanSchema.nullable(),
  /** Items in Larder that are low at this shop but have no listing there. */
  unmatched: z.array(z.object({ productId: z.string(), name: z.string() })).default([]),
  /** Low items linked here, but bought at other shops (their preferred shops don't include this one). */
  elsewhere: z.array(z.object({ productId: z.string(), name: z.string(), shops: z.array(z.string()) })).default([]),
  /** Filled: what went into the basket, and what the shop refused. */
  added: z.array(z.object({ productId: z.string(), name: z.string(), quantity: z.number(), unit: z.string() })).default([]),
  failed: z.array(z.object({ productId: z.string(), name: z.string(), listingName: z.string(), error: z.string(), message: z.string() })).default([]),
  summary: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
}).meta({ id: 'OnlineShopRun' });
export type Run = z.infer<typeof Run>;

const KEEP_RUNS = 30;

/** "Friday 6 November, 17:00–18:00" */
export function slotText(b: Pick<BookingInfo, 'start' | 'end'>): string {
  const day = new Date(`${b.start.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return `${day}, ${b.start.slice(11, 16)}–${b.end.slice(11, 16)}`;
}

export function createShops(ctx: ModuleContext, s: Services) {
  const { providers, items } = s;
  const runs = ctx.collection<Run>('runs');
  const bookings = ctx.collection<BookingInfo>('bookings');
  const settings = ctx.collection<Options>('settings');
  const working = new Map<string, Promise<void>>();

  async function options(): Promise<Options> {
    return Options.parse((await settings.get('options')) ?? {});
  }

  /** The booked slot for a provider, while it's still to come. */
  async function booking(providerId: string): Promise<BookingInfo | null> {
    const b = await bookings.get(providerId);
    if (!b) return null;
    return b.end.slice(0, 10) >= ctx.core.today() ? BookingInfo.parse(b) : null;
  }

  async function save(run: Run): Promise<Run> {
    await runs.put(run.id, run);
    return run;
  }

  async function allRuns(): Promise<Run[]> {
    return (await runs.list()).map((d) => Run.parse(d.data)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async function prune(): Promise<void> {
    const old = (await allRuns()).filter((r) => r.status !== 'running').slice(KEEP_RUNS);
    for (const r of old) await runs.remove(r.id);
  }

  /**
   * Items linked to this shop that are worth quoting. Only items that belong on this shop's list:
   * one of their shops, or "any shop" and this shop sells their category. A listing alone doesn't
   * decide where something is bought. Also: low items here with no listing, and low items linked
   * here that are bought elsewhere.
   */
  async function candidates(shop: Shop): Promise<{ candidates: Candidate[]; unmatched: Run['unmatched']; elsewhere: Run['elsewhere'] }> {
    const out: Candidate[] = [];
    const elsewhere: Run['elsewhere'] = [];
    const shops = await ctx.core.shops.list();
    for (const sum of await ctx.core.products.list({ status: 'all' })) {
      const p = sum.product;
      const f = fieldsOf(p);
      const rules = rulesFor(p, shop.id);
      if (!rules.listings.length) continue;
      const here = p.preferredShopIds.length ? p.preferredShopIds.includes(shop.id) : !!p.categoryId && shop.sells.includes(p.categoryId);
      if (!here) {
        if (sum.status.low || p.onShoppingList) elsewhere.push({ productId: p.id, name: p.name, shops: shops.filter((s) => p.preferredShopIds.includes(s.id)).map((s) => s.name) });
        continue;
      }
      const c: Candidate = {
        // On order counts whether it's confirmed or still pending (a basket not checked out).
        productId: p.id, name: p.name, unit: p.unit, inStock: sum.inStock, expected: sum.expected + (sum.pending ?? 0),
        minimum: p.minQuantity, stockUpTo: p.stockUpTo ?? null, offerStockUpTo: f.offerStockUpTo, targetPrice: rules.targetPrice ?? f.targetPrice,
        manual: p.onShoppingList, shelfLifeDays: p.shelfLifeDays, dailyUse: null, packRule: rules.packRule, fixedListingId: rules.fixedListingId,
        listings: rules.listings.map((l) => ({ listingId: l.listingId, name: l.name || l.listingId, packQuantity: l.packQuantity })),
      };
      if (!isCandidate(c)) continue;
      if (c.shelfLifeDays) c.dailyUse = dailyUse(await ctx.core.history.product(p.id, 500), ctx.core.today());
      out.push(c);
    }
    const list = await ctx.core.shopping.forShop(shop.id);
    const unmatched = list.groups.flatMap((g) => g.items).filter((i) => !rulesFor(i.summary.product, shop.id).listings.length).map((i) => ({ productId: i.summary.product.id, name: i.summary.product.name }));
    return { candidates: out, unmatched, elsewhere };
  }

  /** Records what went into the basket as a pending order, item by item, until it's confirmed or removed. */
  async function expectDeliveries(run: Run, p: Plan, result: z.infer<typeof BasketAddResult>): Promise<Pick<Run, 'added' | 'failed'>> {
    const left = new Map<string, number>();
    for (const a of result.added) left.set(a.listing_id, (left.get(a.listing_id) ?? 0) + a.quantity);
    const refused = new Map(result.failed.map((f) => [f.listing_id, f]));
    const added: Run['added'] = [];
    const failed: Run['failed'] = [];
    for (const item of p.items) {
      let quantity = 0;
      for (const line of item.lines) {
        const take = Math.min(line.packs, left.get(line.listingId) ?? 0);
        left.set(line.listingId, (left.get(line.listingId) ?? 0) - take);
        quantity += take * (line.quantity / line.packs);
        const no = refused.get(line.listingId);
        if (take < line.packs && no) failed.push({ productId: item.productId, name: item.name, listingName: line.name, error: no.error, message: no.message });
      }
      quantity = Math.round(quantity * 1000) / 1000;
      if (quantity <= 0) continue;
      await ctx.core.stock.expect({
        productId: item.productId, quantity, source: `${run.shopName} delivery`, pending: true,
        reference: run.booking?.reference ?? null, eta: run.booking ? run.booking.start.slice(0, 10) : null,
      });
      added.push({ productId: item.productId, name: item.name, quantity, unit: item.unit });
    }
    return { added, failed };
  }

  async function execute(run: Run, provider: Provider): Promise<void> {
    let current = run;
    const update = async (patch: Partial<Run>) => {
      current = await save({ ...current, ...patch });
    };
    try {
      await providers.working(provider, async () => {
        await update({ step: `Checking ${run.shopName} is ready` });
        const { woke } = await providers.awake(provider, { wake: true, onWaking: () => void update({ step: `Waking the ${run.shopName} provider's computer` }) });
        const client = await s.ready(provider);
        const shop = (await ctx.core.shops.list()).find((x) => x.id === run.shopId);
        if (!shop) throw new LarderError(`${run.shopName} has been removed from Larder.`, 404, 'not_found');
        const { candidates: cs, unmatched, elsewhere } = await candidates(shop);
        const ids = [...new Set(cs.flatMap((c) => c.listings.map((l) => l.listingId)))];
        await update({ step: ids.length ? `Getting ${run.shopName}'s prices for ${ids.length} product${ids.length === 1 ? '' : 's'}` : 'Nothing to check', unmatched, elsewhere });
        const quotes = new Map<string, QuoteLine>();
        if (ids.length) for (const q of await client.quote(ids)) quotes.set(q.listing_id, q);
        const o = await options();
        const p = plan(cs, quotes, { deliveryDate: run.deliveryDate, loyalty: provider.loyaltyPrices, multibuyOver: o.multibuyOverPercent / 100 });

        // Keep listings' "gone" marks up to date for relinking.
        const dead = p.relink.map((r) => ({ productId: r.productId, listingId: r.listingId }));
        const alive = cs.flatMap((c) => c.listings.filter((l) => quotes.get(l.listingId)?.available).map((l) => ({ productId: c.productId, listingId: l.listingId })));
        await items.markDead(run.shopId, dead, alive);

        if (run.kind === 'plan' || !p.lines.length) {
          await update({ status: 'done', step: run.kind === 'plan' ? 'Planned' : 'Nothing to buy', plan: p, finishedAt: ctx.core.now() });
          current = await save({ ...current, summary: summary(current, await s.currency(), woke) });
          return;
        }

        await update({ step: `Adding ${p.lines.length} product${p.lines.length === 1 ? '' : 's'} to the ${run.shopName} basket`, plan: p });
        const started = await client.basketAdd(p.lines);
        const job = await client.waitFor(started.id, { pollMs: Number(ctx.config.job_poll_ms ?? 3000) });
        if (job.status === 'failed') throw new ProviderError(job.error?.message ?? `${run.shopName} couldn't fill the basket.`, job.error?.code ?? 'provider_error');
        const result = BasketAddResult.parse(job.result);
        const got = await expectDeliveries(current, p, result);
        // Put on the list by hand: it's bought now, as when ticked off in a shop, so it isn't bought again.
        const byHand = new Set(cs.filter((c) => c.manual).map((c) => c.productId));
        for (const a of got.added) if (byHand.has(a.productId)) await ctx.core.products.setOnList(a.productId, false);
        await update({ status: 'done', step: 'Basket filled', ...got, finishedAt: ctx.core.now() });
        current = await save({ ...current, summary: summary(current, await s.currency(), woke) });
        ctx.publish('online-shopping.basket_filled', {
          pending_order: `${run.shopName} delivery`,
          shop: run.shopName, run_id: run.id, items: got.added.length, total: p.total, failed: got.failed.length,
          relink: p.relink.length, slot: run.booking ? slotText(run.booking) : null, summary: current.summary,
        });
      });
    } catch (err) {
      const e = err instanceof LarderError ? { code: err.code, message: err.message } : { code: 'provider_error', message: `Something went wrong: ${err instanceof Error ? err.message : String(err)}` };
      if (!(err instanceof LarderError)) ctx.log.error('A shop failed', { error: String(err) });
      current = await save({ ...current, status: 'failed', step: 'Stopped', error: e, finishedAt: ctx.core.now() });
      current = await save({ ...current, summary: summary(current, await s.currency(), false) });
      ctx.publish('online-shopping.failed', { shop: run.shopName, run_id: run.id, code: e.code, message: e.message, needs_you: STOPPING.has(e.code) });
    }
    // Back to sleep, when it was set up and nothing else is running there.
    if (run.kind === 'fill') await providers.sleepIfIdle(provider).catch((err: unknown) => ctx.log.warn('Couldn\'t put the provider to sleep', { error: String(err) }));
    await prune();
  }

  return {
    options,
    async setOptions(patch: Partial<Options>): Promise<Options> {
      const next = Options.parse({ ...(await options()), ...patch });
      await settings.put('options', next);
      return next;
    },
    booking,
    async setBooking(providerId: string, b: BookingInfo): Promise<void> {
      await bookings.put(providerId, b);
    },

    async get(id: string): Promise<Run> {
      const r = await runs.get(id);
      if (!r) throw new NotFoundError('Shop', id);
      return Run.parse(r);
    },
    async latest(shopId?: string): Promise<Run | null> {
      return (await allRuns()).find((r) => !shopId || r.shopId === shopId) ?? null;
    },

    /** Starts planning or filling a basket, or answers the run already going at that provider. */
    async start(kind: Run['kind'], provider: Provider, shop: Shop): Promise<{ run: Run; already: boolean; done: Promise<void> }> {
      const going = (await allRuns()).find((r) => r.providerId === provider.id && r.status === 'running' && working.has(r.id));
      if (going) return { run: going, already: true, done: working.get(going.id)! };
      const b = await booking(provider.id);
      const run = await save(Run.parse({
        id: newId(), shopId: shop.id, shopName: shop.name, providerId: provider.id, kind, status: 'running', step: 'Starting', startedAt: ctx.core.now(), finishedAt: null,
        deliveryDate: b ? b.start.slice(0, 10) : ctx.core.today(), booking: b, plan: null, summary: null, error: null,
      }));
      const done = execute(run, provider).finally(() => working.delete(run.id));
      working.set(run.id, done);
      return { run, already: false, done };
    },

    /** Runs left "running" when Larder stopped: they'll never finish. */
    async tidyAfterRestart(): Promise<void> {
      for (const r of await allRuns()) {
        if (r.status === 'running' && !working.has(r.id)) {
          const e = { code: 'interrupted', message: `Larder restarted while this was running. Check the basket on ${r.shopName}'s website.` };
          await save({ ...r, status: 'failed', step: 'Stopped', error: e, finishedAt: ctx.core.now(), summary: e.message });
        }
      }
    },
  };
}
export type Shops = ReturnType<typeof createShops>;

/** The summary for people and assistants: what was (or would be) bought, and everything that needs a look. */
export function summary(run: Run, currency: string, woke = false): string {
  const p = run.plan;
  const lines: string[] = [];
  if (woke) lines.push(`Woke the ${run.shopName} provider's computer.`);
  if (run.status === 'failed' && run.error) lines.push(`The shop at ${run.shopName} stopped: ${run.error.message}`);
  const when = run.booking ? `, for delivery ${slotText(run.booking)}` : '';
  if (p) {
    const filled = run.kind === 'fill' && run.status === 'done';
    if (!p.items.length) lines.push(`Nothing needs buying at ${run.shopName} right now.`);
    else {
      lines.push(filled
        ? `Added ${p.items.length} item${p.items.length === 1 ? '' : 's'} to your ${run.shopName} basket, about ${money(p.total, currency)}${when}:`
        : `Planned: ${p.items.length} item${p.items.length === 1 ? '' : 's'} at ${run.shopName}, about ${money(p.total, currency)}${when}:`);
      for (const i of p.items) {
        const packs = i.lines.map((l) => `${l.packs} × ${l.name}${l.deal ? ` (${l.deal}${l.roundedForDeal ? ', rounded up for it' : ''})` : ''}`).join(' + ');
        const why = i.reason === 'offer' ? `on offer at ${perUnit(i.unitPrice ?? 0, i.unit, currency)}${i.targetPrice !== null ? ` (target ${perUnit(i.targetPrice, i.unit, currency)})` : ''}, up to ${amount(i.level, i.unit)}`
          : i.reason === 'low' ? `low (${amount(i.have, i.unit)}), up to ${amount(i.level, i.unit)}` : 'on the list by hand';
        lines.push(`- ${i.name}: ${packs} = ${amount(i.quantity, i.unit)}, ${money(i.cost, currency)}; ${why}${i.capped ? `; held to ${amount(i.level, i.unit)} because ${i.capped}` : ''}`);
      }
      const offers = p.items.filter((i) => i.reason === 'offer').map((i) => i.name);
      if (offers.length) lines.push(`On offer: ${andList(offers)}.`);
    }
    if (run.failed.length) lines.push(`${run.shopName} wouldn't add: ${run.failed.map((f) => `${f.name} (${f.message})`).join('; ')}`);
    if (p.unavailable.length) lines.push(`Unavailable: ${p.unavailable.map((u) => `${u.name} (${u.why})`).join('; ')}.`);
    if (p.relink.length) lines.push(`Gone from ${run.shopName}, link the new one: ${p.relink.map((r) => `${r.name} (${r.listingName})`).join('; ')}.`);
    if (run.unmatched.length) lines.push(`Low but not linked to a ${run.shopName} product: ${andList(run.unmatched.map((u) => u.name))}.`);
    if (run.elsewhere.length) lines.push(`Low and linked at ${run.shopName}, but bought elsewhere (add ${run.shopName} to its shops to buy it here): ${run.elsewhere.map((e) => `${e.name} (${e.shops.length ? andList(e.shops) : 'no shop sells its type'})`).join('; ')}.`);
    if (p.otherDeals.length) lines.push(`Other offers seen (not used): ${p.otherDeals.map((d) => `${d.name}: ${d.text}`).join('; ')}.`);
  }
  if (run.kind === 'fill' && run.status === 'done' && p?.items.length) {
    lines.push(run.booking ? `Delivery slot booked: ${slotText(run.booking)}${run.booking.reference ? ` (ref ${run.booking.reference})` : ''}.` : 'No delivery slot is booked yet.');
    lines.push(`Check the basket on ${run.shopName}'s website and pay there. Until then it's a pending "${run.shopName} delivery" order in Larder (not bought again, not on its way yet): confirm it once you've checked out (the order email does too), or remove it if you don't go ahead.`);
  }
  return lines.join('\n');
}
