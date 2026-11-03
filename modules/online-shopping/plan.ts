/**
 * The order logic: given each item's stock, buying rules and live quotes,
 * what to put in the basket. Pure (no Larder, no provider), so it's tested
 * on its own. The steps follow the design (SPEC.md, "Order logic"):
 *
 * 1. An item is a candidate when it's low, on the list by hand, or could be
 *    stocked up on offer (stock plus on order below its on-offer amount).
 * 2. Its listings are quoted.
 * 3. On offer (the best price per unit at or below its target): top up to the
 *    on-offer amount. Not on offer but low (or on the list by hand): the normal
 *    amount. Otherwise skip it.
 * 4. Needed = that level − stock − on order.
 * 5. Packs: a fixed pack, or the cheapest mix of listings that covers it.
 * 6. Multibuys are rounded up to complete the deal, unless that goes more than
 *    a set share over the level.
 * 7. Perishables are capped by shelf life (how much gets used before it goes off).
 */
import type { Deal, QuoteLine, Validity } from './contract';

export interface PlanOptions {
  /** The delivery day offers must cover (the booked slot's, else today). YYYY-MM-DD. */
  deliveryDate: string;
  /** Count loyalty prices and loyalty-only deals (Clubcard). */
  loyalty: boolean;
  /** Rounding up to complete a multibuy may go this share over the level (0.25 is 25%). */
  multibuyOver: number;
}

export interface CandidateListing {
  listingId: string;
  name: string;
  /** How many of the item's unit one pack gives. */
  packQuantity: number;
}

export interface Candidate {
  productId: string;
  name: string;
  unit: string;
  inStock: number;
  expected: number;
  minimum: number | null;
  /** The normal stock-up amount (the item's own). */
  stockUpTo: number | null;
  offerStockUpTo: number | null;
  /** Per one of the item's unit, this shop's own if it has one. */
  targetPrice: number | null;
  /** Put on the shopping list by hand. */
  manual: boolean;
  shelfLifeDays: number | null;
  /** How much is used a day, from recent history; null when there isn't enough. */
  dailyUse: number | null;
  packRule: 'fixed' | 'cheapest';
  fixedListingId: string | null;
  listings: CandidateListing[];
}

export interface PlannedLine {
  listingId: string;
  name: string;
  packs: number;
  /** In the item's unit. */
  quantity: number;
  cost: number;
  /** The deal used, in the shop's words. */
  deal: string | null;
  /** Packs added to complete a multibuy. */
  roundedForDeal: boolean;
}

export interface PlannedItem {
  productId: string;
  name: string;
  unit: string;
  reason: 'offer' | 'low' | 'manual';
  have: number;
  /** The level it's topped up to. */
  level: number;
  needed: number;
  /** The best price per unit found, and the target it was compared with. */
  unitPrice: number | null;
  targetPrice: number | null;
  /** Why the level is lower than the rules say, when shelf life capped it. */
  capped: string | null;
  lines: PlannedLine[];
  quantity: number;
  cost: number;
}

export interface Plan {
  items: PlannedItem[];
  /** Candidates not bought, and why. */
  skipped: Array<{ productId: string; name: string; why: string }>;
  /** Nothing could be bought: every listing out of stock or without a price. */
  unavailable: Array<{ productId: string; name: string; why: string }>;
  /** Listings the shop says have gone: link the new one. */
  relink: Array<{ productId: string; name: string; listingId: string; listingName: string }>;
  /** Offers seen that the logic doesn't use ("other" deals), for the summary. */
  otherDeals: Array<{ productId: string; name: string; listingName: string; text: string }>;
  /** What to send to the basket, one line per listing. */
  lines: Array<{ listing_id: string; quantity: number }>;
  total: number;
}

/** Things that keep less than this many days count as perishable when there's no usage history. */
export const PERISHABLE_DAYS = 90;
const EPS = 1e-9;
const MAX_PACKS = 99;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function validOn(v: Validity | null | undefined, date: string): boolean {
  if (!v) return true;
  if (v.from && date < v.from) return false;
  if (v.until && date > v.until) return false;
  return true;
}

/** A listing as priced for this delivery: the price per pack, and the deal that counts. */
export interface Priced extends CandidateListing {
  base: number;
  deal: Exclude<Deal, { type: 'other' }> | null;
}

export function priced(l: CandidateListing, q: QuoteLine | undefined, o: Pick<PlanOptions, 'deliveryDate' | 'loyalty'>): Priced | null {
  if (!q || !q.available || q.price === null && q.loyalty_price === null) return null;
  const loyalty = o.loyalty && q.loyalty_price !== null && validOn(q.loyalty_price_valid, o.deliveryDate) ? q.loyalty_price : null;
  const base = Math.min(q.price ?? Infinity, loyalty ?? Infinity);
  if (!Number.isFinite(base)) return null;
  const d = q.deal;
  const deal = d && d.type !== 'other' && validOn(d.valid, o.deliveryDate) && (!d.loyalty_only || o.loyalty) ? d : null;
  return { ...l, base, deal };
}

/** What `n` packs of a listing cost, with its deal. */
export function cost(p: Priced, n: number): number {
  const d = p.deal;
  if (n <= 0) return 0;
  if (!d) return n * p.base;
  switch (d.type) {
    case 'multibuy_fixed': return Math.floor(n / d.quantity) * d.price + (n % d.quantity) * p.base;
    case 'multibuy_free': {
      const group = d.buy + d.free;
      return (Math.floor(n / group) * d.buy + Math.min(n % group, d.buy)) * p.base;
    }
    case 'percent_off': return n >= d.min_quantity ? n * p.base * (1 - d.percent / 100) : n * p.base;
  }
}

/** How many packs complete the deal (null when there isn't one). */
function dealSize(p: Priced): number | null {
  const d = p.deal;
  if (!d) return null;
  if (d.type === 'multibuy_fixed') return d.quantity;
  if (d.type === 'multibuy_free') return d.buy + d.free;
  return d.min_quantity > 1 ? d.min_quantity : null;
}

/** The best price per one of the item's unit, buying enough to get the deal. */
export function bestUnitPrice(p: Priced): number {
  const n = dealSize(p) ?? 1;
  return Math.min(p.base / p.packQuantity, cost(p, n) / (n * p.packQuantity));
}

interface Mix { counts: number[]; cost: number; quantity: number; packs: number }

/** The cheapest mix of packs covering `need`; ties go to the least over, then the fewest packs. */
export function cheapestMix(need: number, listings: Priced[]): Mix | null {
  if (!listings.length) return null;
  // The cheapest per unit first, and only a few: more would only slow the search.
  const ls = [...listings].sort((a, b) => bestUnitPrice(a) - bestUnitPrice(b)).slice(0, 6);
  let best: Mix | null = null;
  const counts = new Array<number>(ls.length).fill(0);
  const better = (m: Mix) => !best || m.cost < best.cost - EPS || (Math.abs(m.cost - best.cost) <= EPS && (m.quantity < best.quantity - EPS || (Math.abs(m.quantity - best.quantity) <= EPS && m.packs < best.packs)));
  const walk = (i: number, left: number) => {
    if (i === ls.length - 1 || left <= EPS) {
      const last = left <= EPS ? 0 : Math.ceil(left / ls[i]!.packQuantity - EPS);
      if (last > MAX_PACKS) return;
      counts[i] = last;
      for (let j = i + 1; j < ls.length; j++) counts[j] = 0;
      const total = ls.reduce((n, l, j) => n + cost(l, counts[j]!), 0);
      const quantity = ls.reduce((n, l, j) => n + l.packQuantity * counts[j]!, 0);
      const packs = counts.reduce((a, b) => a + b, 0);
      const m = { counts: [...counts], cost: total, quantity, packs };
      if (packs > 0 && better(m)) best = m;
      return;
    }
    const most = Math.min(MAX_PACKS, Math.ceil(left / ls[i]!.packQuantity - EPS));
    for (let n = most; n >= 0; n--) {
      counts[i] = n;
      walk(i + 1, left - n * ls[i]!.packQuantity);
    }
  };
  walk(0, need);
  if (!best) return null;
  // Back in the order given, so the caller can match counts to its listings.
  const found = best as Mix;
  return { ...found, counts: listings.map((l) => { const j = ls.indexOf(l); return j < 0 ? 0 : found.counts[j]!; }) };
}

/** How much a perishable may be topped up to, from how fast it's used. */
export function shelfLifeCap(c: Candidate, onOffer: boolean, normal: number): { level: number | null; why: string | null } {
  if (!c.shelfLifeDays) return { level: null, why: null };
  if (c.dailyUse !== null && c.dailyUse > 0) {
    const cap = r3(Math.max(c.minimum ?? 0, c.dailyUse * c.shelfLifeDays));
    return { level: cap, why: `it keeps ${c.shelfLifeDays} days and you use about ${useText(c.dailyUse)}` };
  }
  if (onOffer && c.shelfLifeDays < PERISHABLE_DAYS) return { level: normal, why: `it keeps ${c.shelfLifeDays} days and there's no usage history yet, so not stocking up on offer` };
  return { level: null, why: null };
}

/** "2 a day", "3 a week", "1 a month" (rounded to a half). */
function useText(perDay: number): string {
  const half = (n: number) => String(Math.max(0.5, Math.round(n * 2) / 2));
  return perDay >= 1 ? `${half(perDay)} a day` : perDay * 7 >= 1 ? `${half(perDay * 7)} a week` : `${half(perDay * 30)} a month`;
}

export const normalLevel = (c: Pick<Candidate, 'minimum' | 'stockUpTo'>) => Math.max(c.minimum ?? 0, c.stockUpTo ?? 0);
export const offerLevel = (c: Pick<Candidate, 'minimum' | 'stockUpTo' | 'offerStockUpTo'>) => Math.max(normalLevel(c), c.offerStockUpTo ?? 0);
const isLow = (c: Candidate) => c.minimum !== null && c.minimum > 0 && r3(c.inStock + c.expected) < c.minimum;

/** Step 1: worth quoting? */
export function isCandidate(c: Candidate): boolean {
  if (!c.listings.length) return false;
  return isLow(c) || c.manual || (c.targetPrice !== null && r3(c.inStock + c.expected) < offerLevel(c));
}

export function plan(candidates: Candidate[], quotes: Map<string, QuoteLine>, o: PlanOptions): Plan {
  const out: Plan = { items: [], skipped: [], unavailable: [], relink: [], otherDeals: [], lines: [], total: 0 };

  for (const c of candidates) {
    if (!isCandidate(c)) continue;
    for (const l of c.listings) {
      const q = quotes.get(l.listingId);
      if (q?.error === 'listing_dead') out.relink.push({ productId: c.productId, name: c.name, listingId: l.listingId, listingName: l.name });
      if (q?.deal?.type === 'other') out.otherDeals.push({ productId: c.productId, name: c.name, listingName: l.name, text: q.deal.text });
    }
    const usable = c.packRule === 'fixed' ? c.listings.filter((l) => l.listingId === (c.fixedListingId ?? c.listings[0]!.listingId)) : c.listings;
    const prices = usable.map((l) => priced(l, quotes.get(l.listingId), o)).filter((p): p is Priced => !!p);
    const have = r3(c.inStock + c.expected);
    if (!prices.length) {
      const errors = usable.map((l) => quotes.get(l.listingId)?.error ?? null);
      // Only worth saying when it would have been bought anyway (low, or by hand); gone listings are already in relink.
      if ((isLow(c) || c.manual) && !errors.every((e) => e === 'listing_dead')) {
        out.unavailable.push({ productId: c.productId, name: c.name, why: errors.includes('out_of_stock') ? 'out of stock' : 'no price from the shop' });
      }
      continue;
    }

    // 3. On offer, low, or skip.
    const unitPrice = Math.min(...prices.map(bestUnitPrice));
    const onOffer = c.targetPrice !== null && unitPrice <= c.targetPrice + EPS;
    const normal = normalLevel(c);
    let reason: PlannedItem['reason'];
    let level: number;
    if (onOffer) {
      reason = 'offer';
      level = offerLevel(c);
    } else if (isLow(c) || c.manual) {
      reason = isLow(c) ? 'low' : 'manual';
      level = normal;
    } else {
      out.skipped.push({ productId: c.productId, name: c.name, why: 'not low and not on offer' });
      continue;
    }

    // 7. Perishables: no more than gets used before it goes off.
    let capped: string | null = null;
    const cap = shelfLifeCap(c, onOffer, normal);
    if (cap.level !== null && cap.level < level - EPS) {
      level = cap.level;
      capped = cap.why;
    }

    // 4. How many.
    let needed = r3(level - have);
    if (needed <= EPS) {
      if (!c.manual) {
        out.skipped.push({ productId: c.productId, name: c.name, why: capped ? `enough already (${capped})` : 'enough already' });
        continue;
      }
      needed = Math.min(...prices.map((p) => p.packQuantity));
    }

    // 5. Packs.
    const mix = cheapestMix(needed, prices);
    if (!mix) {
      out.unavailable.push({ productId: c.productId, name: c.name, why: `more than ${MAX_PACKS} packs would be needed` });
      continue;
    }
    const lines: PlannedLine[] = [];
    let quantity = 0;
    prices.forEach((p, i) => {
      let packs = mix.counts[i]!;
      if (!packs) return;
      // 6. Complete a multibuy if it doesn't go too far over.
      const size = dealSize(p);
      let rounded = false;
      if (size && packs % size !== 0) {
        const up = p.deal!.type === 'percent_off' ? (packs < size ? size : packs) : packs + (size - (packs % size));
        const after = have + mix.quantity + (up - packs) * p.packQuantity;
        if (up !== packs && up <= MAX_PACKS && after <= level * (1 + o.multibuyOver) + EPS) {
          packs = up;
          rounded = true;
        }
      }
      const lineCost = cost(p, packs);
      const dealUsed = p.deal && lineCost < packs * p.base - EPS ? p.deal.text : null;
      lines.push({ listingId: p.listingId, name: p.name, packs, quantity: r3(packs * p.packQuantity), cost: Math.round(lineCost * 100) / 100, deal: dealUsed, roundedForDeal: rounded });
      quantity += packs * p.packQuantity;
    });
    const itemCost = Math.round(lines.reduce((n, l) => n + l.cost, 0) * 100) / 100;
    out.items.push({ productId: c.productId, name: c.name, unit: c.unit, reason, have, level: r3(level), needed, unitPrice: Math.round(unitPrice * 10_000) / 10_000, targetPrice: c.targetPrice, capped, lines, quantity: r3(quantity), cost: itemCost });
  }

  // One basket line per listing.
  const byListing = new Map<string, number>();
  for (const item of out.items) for (const l of item.lines) byListing.set(l.listingId, (byListing.get(l.listingId) ?? 0) + l.packs);
  out.lines = [...byListing].map(([listing_id, quantity]) => ({ listing_id, quantity: Math.min(MAX_PACKS, quantity) }));
  out.total = Math.round(out.items.reduce((n, i) => n + i.cost, 0) * 100) / 100;
  return out;
}

/**
 * How much is used a day, from recent stock movements (newest first): what
 * was used over the last 90 days, or since the oldest movement Larder has if
 * that's sooner. Null with less than a week of history or nothing used.
 */
export function dailyUse(movements: Array<{ kind: string; quantity: number; at: string }>, today: string, windowDays = 90): number | null {
  const start = new Date(`${today}T00:00:00Z`).getTime() - windowDays * 86_400_000;
  const recent = movements.filter((m) => new Date(m.at).getTime() >= start);
  const used = recent.filter((m) => m.kind === 'use').reduce((n, m) => n + Math.abs(m.quantity), 0);
  if (used <= 0) return null;
  const oldest = Math.min(...recent.map((m) => new Date(m.at).getTime()));
  const days = (new Date(`${today}T00:00:00Z`).getTime() + 86_400_000 - Math.max(oldest, start)) / 86_400_000;
  if (days < 7) return null;
  return used / days;
}
