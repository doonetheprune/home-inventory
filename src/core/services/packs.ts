/**
 * An item's own unit, its pack, its size and its usage: what a quantity is in,
 * and how they read ("2 boxes", "1 jar = 400 g", "4 g a day", "a week's worth").
 */
import { ValidationError } from '../errors';
import type { Measure, Product, Usage } from '../model';
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

type Item = Pick<Product, 'name' | 'unit'> & { pack?: Product['pack']; size?: Product['size'] };

const MEASURES: Record<Measure, { dim: 'mass' | 'volume'; base: number }> = {
  g: { dim: 'mass', base: 1 }, kg: { dim: 'mass', base: 1000 }, ml: { dim: 'volume', base: 1 }, l: { dim: 'volume', base: 1000 },
};
const MEASURE_WORDS: Record<string, Measure> = {
  gram: 'g', grams: 'g', gramme: 'g', grammes: 'g', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', kgs: 'kg',
  millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml', litre: 'l', litres: 'l', liter: 'l', liters: 'l', ltr: 'l',
};

/** "g", "Grams", "L", "litres" → the measure they are, or null for anything else (a jar). */
export function measureOf(unit: string): Measure | null {
  const k = unit.trim().toLowerCase();
  return k in MEASURES ? (k as Measure) : (MEASURE_WORDS[k] ?? null);
}

export const isMeasure = (unit: string) => measureOf(unit) !== null;

/** A measure as it's written: litres as "L" (1.5 L), the rest as they are. */
const written = (m: string) => (m === 'l' ? 'L' : m);

/** "g or kg", "ml or l": what an item's weight or volume can be given in, or null when Larder can't tell. */
function measuresFor(product: Pick<Item, 'unit' | 'size'>): string | null {
  const m = measureOf(product.unit) ?? product.size?.unit ?? null;
  return m ? (MEASURES[m].dim === 'mass' ? 'g or kg' : 'ml or l') : null;
}

/**
 * How much of `unit` (g, kg, ml or l) one of the item's own unit is: 400 for a 400 g jar in g,
 * 0.001 for something counted in g, in kg. Null when Larder can't tell (no size, or a weight
 * asked of something measured by volume).
 */
export function measurePerOne(product: Pick<Item, 'unit' | 'size'>, unit: string): number | null {
  const to = measureOf(unit);
  if (!to) return null;
  const own = measureOf(product.unit);
  if (own) return MEASURES[own].dim === MEASURES[to].dim ? MEASURES[own].base / MEASURES[to].base : null;
  const size = product.size ?? null;
  if (!size) return null;
  return MEASURES[size.unit].dim === MEASURES[to].dim ? (size.amount * MEASURES[size.unit].base) / MEASURES[to].base : null;
}

/**
 * The usage in the item's own unit, for working out stock and dates: 4 g a day of a 400 g
 * jar is 0.01 jar a day. Null without a usage.
 */
export function ownUsage(product: Pick<Product, 'unit' | 'usage'> & { size?: Product['size'] }): Usage | null {
  const u = product.usage ?? null;
  if (!u?.unit) return u;
  const per = measurePerOne(product, u.unit);
  return per ? { ...u, amount: u.amount / per, unit: null } : null;
}

/** A quantity given in `unit` (the item's own, its pack's name, or a weight or volume), in the item's own unit. */
export function inOwnUnit(product: Item, quantity: number, unit?: string): number {
  const pack = product.pack ?? null;
  if (!unit || sameUnit(unit, product.unit) || (product.unit === 'each' && /^(each|ones?|items?)$/i.test(unit.trim()))) return quantity;
  if (pack && sameUnit(unit, pack.name)) return roundQty(quantity * pack.holds);
  const per = measurePerOne(product, unit);
  if (per) return roundQty(quantity / per);
  const by = measuresFor(product);
  const options = [many(product.unit), ...(pack ? [pluralWord(pack.name, 2)] : [])];
  throw new ValidationError(`${product.name} is counted in ${many(product.unit)}${pack ? ` and comes in ${pluralWord(pack.name, 2)} of ${pack.holds}` : ''}. Give how many ${options.join(' or ')}${by && !isMeasure(product.unit) ? `, or how much in ${by}` : ''}.`);
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

/** "1 jar = 400 g", or null for something with no size. */
export function sizeText(product: Pick<Item, 'unit' | 'size'>): string | null {
  const s = product.size ?? null;
  return s && !isMeasure(product.unit) ? `1 ${product.unit === 'each' ? 'item' : product.unit} = ${amount(s.amount, written(s.unit))}` : null;
}

/** "300 g": a quantity of the item by weight or volume, for something used by weight (4 g a day of a jar). Null otherwise. */
export function measureText(product: Pick<Product, 'unit' | 'usage'> & { size?: Product['size'] }, quantity: number): string | null {
  const unit = product.usage?.unit ?? null;
  if (!unit || isMeasure(product.unit)) return null;
  const per = measurePerOne(product, unit);
  return per ? amount(Math.round(quantity * per * 10) / 10, written(unit)) : null;
}

/** "a day", "a week", "every 2 weeks", "every 14 days" → in words. */
export function everyText(days: number): string {
  if (days === 1) return 'a day';
  if (days === 7) return 'a week';
  if (days % 7 === 0) return `every ${days / 7} weeks`;
  return `every ${days} days`;
}

/** "1 tea bag a day", "2 rolls a week", "4 g a day", "1 every 14 days". */
export function usageText(product: Pick<Product, 'unit' | 'usage'>): string {
  const u = product.usage;
  return u ? `${amount(u.amount, u.unit ? written(u.unit) : product.unit)} ${everyText(u.everyDays)}` : '';
}

/** "100 days", "about 133 days", "a week", "3 weeks". */
export function durationText(days: number): string {
  const d = Math.round(days);
  if (d < 1) return 'less than a day';
  if (d === 1) return 'a day';
  if (d === 7) return 'a week';
  if (d % 7 === 0) return `${d / 7} weeks`;
  return `${Math.abs(days - d) < 0.05 ? '' : 'about '}${d} days`;
}

/** "a 400 g jar lasts 100 days": for something used by weight or volume, how long one lasts. Null otherwise. */
export function oneLastsText(product: Pick<Product, 'unit' | 'usage'> & { size?: Product['size'] }): string | null {
  const own = ownUsage(product);
  const size = product.size ?? null;
  if (!product.usage?.unit || !own || !size || isMeasure(product.unit)) return null;
  const one = product.unit === 'each' ? 'one' : product.unit;
  return `a ${amount(size.amount, written(size.unit))} ${one} lasts ${durationText(own.everyDays / own.amount)}`;
}

/**
 * Whether a plain Use starts one: with a usage Larder doesn't take out, always; with one it
 * does, only when none has been started (otherwise it's an extra). Something used by weight
 * isn't started one at a time, so a Use is just a use, unless Larder has stopped taking it out.
 */
export function startsOne(product: Pick<Product, 'usage' | 'inUseSince'>): boolean {
  const u = product.usage ?? null;
  if (u?.unit) return u.auto && !product.inUseSince;
  return !!u && (!u.auto || !product.inUseSince);
}

/** How many days `quantity` (in the item's own unit) lasts at its usage, or null without one. */
export function daysFor(product: Pick<Product, 'unit' | 'usage'> & { size?: Product['size'] }, quantity: number): number | null {
  const u = ownUsage(product);
  return u ? (quantity * u.everyDays) / u.amount : null;
}

/**
 * How many periods Larder waits before taking stock out, so what it takes rounds cleanly to the
 * thousandths stock is kept in: 0.0125 of a jar a day would round to 0.013 (4% too fast), so it
 * takes 0.025 every 2 days. Within 1%, and at most a month of days apart.
 */
export function periodsPerTake(ownAmount: number): number {
  for (let k = 1; k <= 31; k++) {
    const exact = k * ownAmount;
    if (Math.abs(roundQty(exact) - exact) <= exact * 0.01) return k;
  }
  return 1;
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
