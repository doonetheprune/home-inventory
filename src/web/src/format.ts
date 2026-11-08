/** Formatting for quantities, dates and statuses, in UK English. */
import type { ProductSummary } from '@larder/core';

const MEASURES = new Set(['l', 'ml', 'kg', 'g', 'm', 'cm', 'mm', 'oz', 'lb']);
const FRACTIONS: Record<string, string> = { '0.25': '¼', '0.5': '½', '0.75': '¾', '0.33': '⅓', '0.67': '⅔' };

export function plural(unit: string, n: number): string {
  if ((n > 0 && n <= 1) || MEASURES.has(unit.toLowerCase())) return unit;
  if (/(s|x|z|ch|sh)$/i.test(unit)) return `${unit}es`;
  if (/[^aeiou]y$/i.test(unit)) return `${unit.slice(0, -1)}ies`;
  return `${unit}s`;
}

export function num(n: number): string {
  const whole = Math.trunc(n);
  const frac = Math.round((n - whole) * 100) / 100;
  const f = FRACTIONS[frac.toFixed(2).replace(/0$/, '')] ?? FRACTIONS[String(frac)];
  if (f) return whole ? `${whole}${f}` : f;
  return Number.isInteger(n) ? n.toLocaleString('en-GB') : n.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

/** "4 rolls", "1.6 kg", "¼ bottle", "3" (for "each"). */
export function qty(n: number, unit: string): string {
  if (unit === 'each') return num(n);
  return `${num(n)} ${plural(unit, n)}`;
}

/** Stock as shown in lists: "6 charged · 4 flat" for rechargeables, "0.75 jar · 300 g" for something used by weight. */
export function stockText(s: ProductSummary): string {
  if (s.product.rechargeable && s.charged !== null && s.flat !== null) return s.flat ? `${num(s.charged)} charged · ${num(s.flat)} flat` : `${qty(s.charged, s.product.unit)}`;
  const byWeight = measureQty(s.product.unit, s.product.size, s.product.usage, s.inStock);
  return `${qty(s.inStock, s.product.unit)}${byWeight ? ` · ${byWeight}` : ''}`;
}

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const d = (iso: string) => new Date(`${iso}T12:00:00Z`);

export const shortDate = (iso: string) => DATE.format(d(iso));
export const longDate = (iso: string) => LONG.format(d(iso));
export const dayDate = (iso: string) => DAY.format(d(iso)).replace(',', '');

/** "Today", "Tomorrow", "Fri 30 Oct", "15 Nov", "Expired 2 days ago". */
export function expiryText(date: string, days: number | null, renewal = false): string {
  if (days === null) return shortDate(date);
  if (renewal) return days < 0 ? `Renewal overdue` : `Renews ${shortDate(date)}`;
  if (days < -1) return `Expired ${-days} days ago`;
  if (days === -1) return 'Expired yesterday';
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return dayDate(date);
  return shortDate(date);
}

/** "today", "tomorrow", "Fri 30 Oct", "15 Nov": when something with a usage runs out. */
export function dayText(date: string, days: number | null): string {
  if (days === null) return shortDate(date);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return dayDate(date);
  return shortDate(date);
}

/** "Tea bags" and "tea bag" are the same unit, as are "boxes" and "box". */
export function sameUnit(a: string, b: string): boolean {
  const one = (w: string) => {
    const x = w.trim().toLowerCase().replace(/\s+/g, ' ');
    if (x.length > 4 && x.endsWith('ies')) return `${x.slice(0, -3)}y`;
    if (/(x|ch|sh|ss)es$/.test(x)) return x.slice(0, -2);
    return x.length > 3 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x;
  };
  return one(a) === one(b);
}

interface Usage { amount: number; everyDays: number; auto?: boolean; unit?: string | null }
interface Pack { name: string; holds: number }
export type Measure = 'g' | 'kg' | 'ml' | 'l';
export interface Size { amount: number; unit: Measure }

const SCALE: Record<Measure, { dim: 'mass' | 'volume'; base: number }> = {
  g: { dim: 'mass', base: 1 }, kg: { dim: 'mass', base: 1000 }, ml: { dim: 'volume', base: 1 }, l: { dim: 'volume', base: 1000 },
};
/** "g", "L" → the measure; null for anything else (a jar). */
export const measureOf = (unit: string): Measure | null => {
  const k = unit.trim().toLowerCase();
  return k in SCALE ? (k as Measure) : null;
};
/** A measure as it's written: litres as "L". */
export const measureName = (m: Measure) => (m === 'l' ? 'L' : m);
/** The measures a size in `m` can be said in: g and kg, or ml and L. */
export const measuresLike = (m: Measure): Measure[] => (SCALE[m].dim === 'mass' ? ['g', 'kg'] : ['ml', 'l']);

/** How much of `m` one of the item's unit is (400 for a 400 g jar, in g), or null when it can't be told. */
export function perOne(unit: string, size: Size | null | undefined, m: Measure): number | null {
  const own = measureOf(unit);
  if (own) return SCALE[own].dim === SCALE[m].dim ? SCALE[own].base / SCALE[m].base : null;
  if (!size) return null;
  return SCALE[size.unit].dim === SCALE[m].dim ? (size.amount * SCALE[size.unit].base) / SCALE[m].base : null;
}

/** The usage in the item's own unit: 4 g a day of a 400 g jar is 0.01 jar a day. */
export function ownUsage(unit: string, size: Size | null | undefined, u: Usage): Usage | null {
  if (!u.unit) return u;
  const per = perOne(unit, size, u.unit as Measure);
  return per ? { ...u, amount: u.amount / per, unit: null } : null;
}

/** "1 jar = 400 g", or null. */
export const weighsText = (unit: string, size: Size | null | undefined) => (size && !measureOf(unit) ? `1 ${unit === 'each' ? 'item' : unit} = ${num(size.amount)} ${measureName(size.unit)}` : null);

/** "300 g": stock by weight, for something used by weight. Null otherwise. */
export function measureQty(unit: string, size: Size | null | undefined, u: Usage | null | undefined, quantity: number): string | null {
  if (!u?.unit || measureOf(unit)) return null;
  const per = perOne(unit, size, u.unit as Measure);
  return per ? `${num(Math.round(quantity * per * 10) / 10)} ${measureName(u.unit as Measure)}` : null;
}

/** "a day", "a week", "every 2 weeks", "every 14 days". */
export const everyText = (days: number) => (days === 1 ? 'a day' : days === 7 ? 'a week' : days % 7 === 0 ? `every ${days / 7} weeks` : `every ${days} days`);

/** "1 tea bag a day", "2 rolls a week", "4 g a day", "1 every 14 days". */
export const usageText = (unit: string, u: Usage) => `${u.unit ? `${num(u.amount)} ${measureName(u.unit as Measure)}` : qty(u.amount, unit)} ${everyText(u.everyDays)}`;

/** "a day", "a week", "3 weeks", "about 10 days". */
function daysText(days: number): string {
  const d = Math.round(days);
  if (d < 1) return 'less than a day';
  if (d === 1) return 'a day';
  if (d === 7) return 'a week';
  if (d % 7 === 0) return `${d / 7} weeks`;
  return `${Math.abs(days - d) > 0.05 ? 'about ' : ''}${d} days`;
}

/** What a usage means, said back so a slip shows: "A box of 80 lasts 40 days.", "A 400 g jar lasts 100 days." */
export function usageSentence({ unit, pack, size, usage }: { unit: string; pack: Pack | null; size?: Size | null; usage: Usage }): string {
  const own = ownUsage(unit, size, usage);
  if (!own) return `Say what one ${unit === 'each' ? 'weighs' : `${unit} weighs`} first.`;
  const lasts = (n: number) => daysText((n * own.everyDays) / own.amount);
  if (pack) return `A ${pack.name} of ${pack.holds} lasts ${lasts(pack.holds)}.`;
  if (usage.unit && size && !measureOf(unit)) return `A ${num(size.amount)} ${measureName(size.unit)} ${unit === 'each' ? 'one' : unit} lasts ${lasts(1)}.`;
  return usage.amount <= 1 && !usage.unit ? `One lasts ${lasts(1)}.` : `That's ${usageText(unit, usage)}.`;
}

/** "a week's worth", "about 10 days' worth". */
export function worthText(days: number): string {
  const d = Math.round(days);
  if (d < 1) return "less than a day's worth";
  if (d === 1) return "a day's worth";
  if (d === 7) return "a week's worth";
  if (d % 7 === 0) return `${d / 7} weeks' worth`;
  return `about ${d} days' worth`;
}

/** "about 1¼ boxes", "2 boxes": stock as packs, or null without a pack. */
export function packsText(pack: Pack | null | undefined, quantity: number): string | null {
  if (!pack || quantity <= 0) return null;
  const n = quantity / pack.holds;
  const quarter = Math.round(n * 4) / 4;
  const whole = Math.abs(n - Math.round(n)) < 1e-9;
  return `${whole ? '' : 'about '}${num(whole ? Math.round(n) : quarter || 0.25)} ${plural(pack.name, whole ? Math.round(n) : Math.max(quarter, 2))}`;
}

/** One of what it's bought in, for the quick Add buttons: its pack if it has one ("1 box (80 tea bags)"). */
export function oneBought(p: { unit: string; pack?: Pack | null }): { quantity: number; unit?: string; text: string } {
  const pack = p.pack ?? null;
  return pack ? { quantity: 1, unit: pack.name, text: `1 ${pack.name} (${qty(pack.holds, p.unit)})` } : { quantity: 1, text: '1' };
}

export function ago(iso: string, now = Date.now()): string {
  const mins = Math.round((now - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  return `${Math.round(days / 7)} wks`;
}

export type PillKind = 'low' | 'soon' | 'away' | 'coming' | 'ok' | 'plain' | 'wish';

/** Up to two status pills for a product. */
export function statusPills(s: ProductSummary): Array<{ kind: PillKind; text: string }> {
  const out: Array<{ kind: PillKind; text: string }> = [];
  const renewal = s.category?.name === 'Renewals';
  if (s.product.wish) out.push({ kind: 'wish', text: 'Wish list' });
  if (s.status.expired) out.push({ kind: 'low', text: renewal ? 'Renewal overdue' : 'Expired' });
  else if (s.status.expiringSoon && s.nextExpiry) out.push({ kind: 'soon', text: expiryText(s.nextExpiry, s.daysToExpiry, renewal) });
  // With none left but one open (or in use), it's the last one, not out.
  if (s.status.low) {
    const none = s.inStock + s.expected + s.pending <= 0;
    out.push({ kind: 'low', text: none && s.inUse ? (s.product.usage ? 'Last one in use' : 'Last one open') : none ? 'Out' : 'Low' });
  }
  if (s.status.outOfPlace && s.nowIn[0]) out.push({ kind: 'away', text: `Now in ${s.nowIn[0].name}` });
  if (s.status.hasExpected) out.push({ kind: 'coming', text: `+${num(s.expected)} on the way` });
  if (s.pending > 0) out.push({ kind: 'coming', text: `+${num(s.pending)} ordered, not confirmed` });
  return out.slice(0, 2);
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  return h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening';
}

export function money(amount: number, currency = 'GBP', decimals?: number): string {
  const symbol = ({ GBP: '£', EUR: '€', USD: '$' } as Record<string, string>)[currency] ?? `${currency} `;
  return `${symbol}${amount.toFixed(decimals ?? (amount < 1 && amount > 0 ? 3 : 2))}`;
}

/** When something was saved, in this device's time: "Today, 14:32", "Yesterday, 08:10", "Mon 3 Nov, 19:45", "3 Nov 2025, 19:45". */
export function savedText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear() ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return `${d.toLocaleDateString('en-GB', opts).replace(',', '')}, ${time}`;
}

/** "640 KB", "1.2 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
