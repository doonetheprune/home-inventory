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

/** Stock as shown in lists: "6 charged · 4 flat" for rechargeables. */
export function stockText(s: ProductSummary): string {
  if (s.product.rechargeable && s.charged !== null && s.flat !== null) return s.flat ? `${num(s.charged)} charged · ${num(s.flat)} flat` : `${qty(s.charged, s.product.unit)}`;
  return qty(s.inStock, s.product.unit);
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
  if (s.status.low) out.push({ kind: 'low', text: s.inStock + s.expected <= 0 ? 'Out' : 'Low' });
  if (s.status.outOfPlace && s.nowIn[0]) out.push({ kind: 'away', text: `Now in ${s.nowIn[0].name}` });
  if (s.status.hasExpected) out.push({ kind: 'coming', text: `+${num(s.expected)} on the way` });
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
