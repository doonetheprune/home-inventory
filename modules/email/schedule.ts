/**
 * When to look in Gmail. Often while it matters (just after an order, while
 * its confirmation is due; around a delivery, while the "delivered" email is
 * due) and seldom otherwise. Plain functions of the time, so they're tested
 * without waiting.
 */
import { z } from 'zod';

export const Timing = z.object({
  /** After a basket is filled (a pending order): every `every` minutes for `hours` hours, for its confirmation. */
  afterOrder: z.object({ every: z.number().int().min(1).max(120), hours: z.number().min(0).max(48) }),
  /** Around a delivery: every `every` minutes from `before` hours before its slot to `after` hours after it. */
  aroundDelivery: z.object({ every: z.number().int().min(1).max(120), before: z.number().min(0).max(24), after: z.number().min(0).max(24) }),
  /** The rest of the time: every `everyHours` hours (0: not at all), for orders placed outside Larder. */
  otherwise: z.object({ everyHours: z.number().min(0).max(48) }),
});
export type Timing = z.infer<typeof Timing>;
export const DEFAULT_TIMING: Timing = { afterOrder: { every: 5, hours: 2 }, aroundDelivery: { every: 5, before: 3, after: 2 }, otherwise: { everyHours: 3 } };

/** A delivery to watch for: from an order email, or a booked slot. Times are the household's, HH:MM. */
export interface DeliveryWindow { shopName: string; date: string; from: string | null; to: string | null }
/** When a slot isn't known, a delivery's day is taken as this. */
export const DAY = { from: '08:00', to: '20:00' };

export interface Watch { why: string; from: number; until: number; every: number }

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Milliseconds for a date and time in a time zone ("2026-11-06", "09:30", "Europe/London"). */
export function localTime(date: string, hhmm: string, timeZone: string): number {
  const asUtc = Date.parse(`${date}T${hhmm}:00Z`);
  const offset = (t: number) => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
    const n = (type: string) => Number(p.find((x) => x.type === type)?.value);
    return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - t;
  };
  // Twice, so a time just after the clocks change lands right.
  const first = asUtc - offset(asUtc);
  return asUtc - offset(first);
}

export interface WatchInput {
  timing: Timing;
  timeZone: string;
  /** Orders waiting to be confirmed (filled baskets): their source and when they were placed. */
  pending: Array<{ source: string; since: string | null }>;
  /** Deliveries on the way, from the core: their source and day. */
  deliveries: Array<{ source: string; eta: string | null }>;
  /** Delivery slots Larder knows (from order emails and booked slots). */
  windows: DeliveryWindow[];
}

const firstWord = (s: string) => s.trim().toLowerCase().split(/\s+/)[0] ?? '';

/** Every stretch of time when Gmail should be checked often, and why. */
export function watches(w: WatchInput): Watch[] {
  const out: Watch[] = [];
  const { afterOrder, aroundDelivery } = w.timing;
  if (afterOrder.hours > 0) {
    for (const p of w.pending) {
      if (!p.since) continue;
      const from = Date.parse(p.since);
      out.push({ why: `waiting for ${p.source}'s confirmation`, from, until: from + afterOrder.hours * HOUR, every: afterOrder.every });
    }
  }
  const around = (shop: string, date: string, from: string | null, to: string | null) => {
    const start = localTime(date, from ?? DAY.from, w.timeZone);
    const end = localTime(date, to ?? (from ? from : DAY.to), w.timeZone);
    out.push({ why: `around the ${shop} delivery`, from: start - aroundDelivery.before * HOUR, until: Math.max(end, start) + aroundDelivery.after * HOUR, every: aroundDelivery.every });
  };
  for (const x of w.windows) around(x.shopName, x.date, x.from, x.to);
  // Deliveries Larder knows the day of but no slot for (an order placed by hand, say): the whole day.
  for (const d of w.deliveries) {
    if (!d.eta) continue;
    if (w.windows.some((x) => x.date === d.eta && firstWord(x.shopName) === firstWord(d.source))) continue;
    around(d.source.replace(/\s+(delivery|order)$/i, ''), d.eta, null, null);
  }
  return out;
}

/**
 * When to check next, and why: as often as the busiest stretch going on now asks; else when the next
 * one starts; else the occasional check. Null when Gmail needn't be checked at all.
 */
export function nextCheck(lastCheck: number | null, now: number, list: Watch[], timing: Timing): { at: number; why: string } | null {
  const candidates: Array<{ at: number; why: string }> = [];
  const active = list.filter((x) => x.from <= now && now < x.until).sort((a, b) => a.every - b.every);
  if (active.length) {
    const busiest = active[0]!;
    candidates.push({ at: lastCheck === null ? now : Math.max(lastCheck + busiest.every * MINUTE, busiest.from), why: busiest.why });
  }
  const upcoming = list.filter((x) => x.from > now).sort((a, b) => a.from - b.from)[0];
  if (upcoming) candidates.push({ at: upcoming.from, why: upcoming.why });
  if (timing.otherwise.everyHours > 0) candidates.push({ at: lastCheck === null ? now : lastCheck + timing.otherwise.everyHours * HOUR, why: 'the regular check' });
  return candidates.sort((a, b) => a.at - b.at)[0] ?? null;
}
