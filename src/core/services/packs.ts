/**
 * An item's own unit, its pack and its usage: what a quantity is in, and how
 * they read ("2 boxes", "1 tea bag a day", "a week's worth").
 */
import { ValidationError } from '../errors';
import type { Product } from '../model';
import { amount, pluralWord, roundQty } from '../util';

/** Words that end in s but are one of them. */
const ONE_WITH_S = /(^|\s)(lens|series|species|gas|bus|plus)$/;

/** "Tea bags" → "tea bag", "boxes" → "box", "batteries" → "battery". */
export function singular(raw: string): string {
  const w = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (ONE_WITH_S.test(w)) return w;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(x|ch|sh|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export const sameUnit = (a: string, b: string) => singular(a) === singular(b);

/** One of a unit as it was typed, keeping its capitals: "Tea bags" → "Tea bag", "L" → "L". */
export function oneOf(raw: string): string {
  const w = raw.trim().replace(/\s+/g, ' ');
  const s = singular(w);
  if (s === w.toLowerCase()) return w;
  return w.toLowerCase().startsWith(s) ? w.slice(0, s.length) : `${w.slice(0, -3)}y`;
}

/** "tea bags", or "ones" for things counted as "each". */
const many = (unit: string) => (unit === 'each' ? 'ones' : pluralWord(unit, 2));

type Item = Pick<Product, 'name' | 'unit'> & { pack?: Product['pack'] };

/** A quantity given in `unit` (the item's own, or its pack's name), in the item's own unit. */
export function inOwnUnit(product: Item, quantity: number, unit?: string): number {
  const pack = product.pack ?? null;
  if (!unit || sameUnit(unit, product.unit) || (product.unit === 'each' && /^(each|ones?|items?)$/i.test(unit.trim()))) return quantity;
  if (pack && sameUnit(unit, pack.name)) return roundQty(quantity * pack.holds);
  throw new ValidationError(`${product.name} is counted in ${many(product.unit)}${pack ? ` and comes in ${pluralWord(pack.name, 2)} of ${pack.holds}` : ''}. Give how many ${many(product.unit)}${pack ? ` or ${pluralWord(pack.name, 2)}` : ''}.`);
}

/** "about 1.9 boxes", "2 boxes": a quantity as packs, or null without a pack. */
export function packsText(product: Item, quantity: number): string | null {
  const pack = product.pack ?? null;
  if (!pack || quantity <= 0) return null;
  const n = quantity / pack.holds;
  const whole = Math.abs(n - Math.round(n)) < 1e-9;
  const shown = whole ? Math.round(n) : Math.round(n * 10) / 10;
  return `${whole ? '' : 'about '}${shown} ${pluralWord(pack.name, shown)}`;
}

/** "a day", "a week", "every 2 weeks", "every 14 days" → in words. */
export function everyText(days: number): string {
  if (days === 1) return 'a day';
  if (days === 7) return 'a week';
  if (days % 7 === 0) return `every ${days / 7} weeks`;
  return `every ${days} days`;
}

/** "1 tea bag a day", "2 rolls a week", "1 every 14 days". */
export function usageText(product: Pick<Product, 'unit' | 'usage'>): string {
  const u = product.usage;
  return u ? `${amount(u.amount, product.unit)} ${everyText(u.everyDays)}` : '';
}

/**
 * Whether a plain Use starts one: with a usage Larder doesn't take out, always; with one it
 * does, only when none has been started (otherwise it's an extra).
 */
export function startsOne(product: Pick<Product, 'usage' | 'inUseSince'>): boolean {
  const u = product.usage ?? null;
  return !!u && (!u.auto || !product.inUseSince);
}

/** How many days `quantity` lasts at its usage, or null without one. */
export function daysFor(product: Pick<Product, 'usage'>, quantity: number): number | null {
  const u = product.usage ?? null;
  return u ? (quantity * u.everyDays) / u.amount : null;
}

/** "a week's worth", "about 10 days' worth", "2 weeks' worth". */
export function worthText(days: number): string {
  const d = Math.round(days);
  if (d < 1) return "less than a day's worth";
  if (d === 1) return "a day's worth";
  if (d === 7) return "a week's worth";
  if (d % 7 === 0) return `${d / 7} weeks' worth`;
  return `about ${d} days' worth`;
}
