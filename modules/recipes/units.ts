/**
 * Kitchen measures for scaling recipes: grams to pounds, millilitres to UK
 * pints, and spoons. Each maps onto the core's g or ml (`inCore`), which is
 * how an ingredient becomes stock, through the core's converter. Anything else
 * ("egg", "slice", "clove", or no unit at all) is a count, and a count only
 * matches itself; its singular and plural come from the core's unit list.
 */
import { andList, builtInUnits, singularOf, unitWord, type Units } from '@larder/core';

type Dim = 'mass' | 'volume';

const MEASURES: Record<string, { dim: Dim; base: number; label: string; plural?: string }> = {
  g: { dim: 'mass', base: 1, label: 'g' },
  kg: { dim: 'mass', base: 1000, label: 'kg' },
  oz: { dim: 'mass', base: 28.349523125, label: 'oz' },
  lb: { dim: 'mass', base: 453.59237, label: 'lb' },
  ml: { dim: 'volume', base: 1, label: 'ml' },
  cl: { dim: 'volume', base: 10, label: 'cl' },
  l: { dim: 'volume', base: 1000, label: 'litre', plural: 'litres' },
  tsp: { dim: 'volume', base: 5, label: 'tsp' },
  tbsp: { dim: 'volume', base: 15, label: 'tbsp' },
  floz: { dim: 'volume', base: 28.4130625, label: 'fl oz' },
  pint: { dim: 'volume', base: 568.26125, label: 'pint', plural: 'pints' },
};

const ALIASES: Record<string, string> = {
  gram: 'g', grams: 'g', gramme: 'g', grammes: 'g', gr: 'g',
  kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', kgs: 'kg',
  ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb',
  millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml', mls: 'ml',
  centilitre: 'cl', centilitres: 'cl', centiliter: 'cl', centiliters: 'cl',
  litre: 'l', litres: 'l', liter: 'l', liters: 'l', ltr: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
  fluidounce: 'floz', fluidounces: 'floz', pints: 'pint', pt: 'pint', pts: 'pint',
};

/** Words that mean "just count them". */
const COUNT = new Set(['', 'each', 'x', 'whole', 'item', 'items', 'number']);

/** "Grams" → "g", "tablespoons" → "tbsp", "slices" → "slice", "each" or nothing → "" (a count). */
export function unitKey(raw: string, units: Units = builtInUnits): string {
  const k = raw.trim().toLowerCase().replace(/[\s.]/g, '');
  if (COUNT.has(k)) return '';
  if (ALIASES[k]) return ALIASES[k]!;
  if (MEASURES[k]) return k;
  return singularOf(units, raw.trim().toLowerCase()).replace(/\s/g, '');
}

/** A kitchen measure as the core's g or ml: 2 tbsp is 30 ml, 1 lb is 453.6 g. Null for a count. */
export function inCore(n: number, unit: string): { amount: number; unit: 'g' | 'ml' } | null {
  const m = MEASURES[unitKey(unit)];
  return m ? { amount: n * m.base, unit: m.dim === 'mass' ? 'g' : 'ml' } : null;
}

const lastWord = (name: string) => name.trim().split(/[\s-]+/).at(-1) ?? '';

/**
 * `n` of `from` in `to`, or null when they can't be compared. `names` are what
 * the ingredient is called: a plain count ("2") of eggs is the same as 2 of
 * an item counted in eggs, but 8 chicken thighs aren't 8 packs.
 */
export function convert(n: number, from: string, to: string, names: string[] = []): number | null {
  const a = unitKey(from);
  const b = unitKey(to);
  if (a === b) return n;
  const ma = MEASURES[a];
  const mb = MEASURES[b];
  if (ma && mb) return ma.dim === mb.dim ? (n * ma.base) / mb.base : null;
  if (ma || mb) return null;
  const counted = a === '' ? b : b === '' ? a : null;
  if (counted !== null && names.some((name) => unitKey(lastWord(name)) === counted)) return n;
  return null;
}

/** Rounded the way a cook would weigh or count it: 133 g, 2.7 eggs, 0.25 tsp. */
export function nice(n: number): number {
  const a = Math.abs(n);
  const f = a >= 10 ? 1 : a >= 1 ? 10 : a >= 0.1 ? 100 : 1000;
  return Math.round(n * f) / f;
}

/** "100 g", "1.5 litres", "2 tsp", "3 slices", "2" (a count). */
export function measureText(n: number, unit: string, units: Units = builtInUnits): string {
  const q = nice(n);
  const k = unitKey(unit, units);
  const m = MEASURES[k];
  if (m) return `${q} ${q !== 1 && m.plural ? m.plural : m.label}`;
  if (!k) return String(q);
  const word = units.find(unit)?.key ?? singularOf(units, unit.trim().toLowerCase());
  return `${q} ${unitWord(units, word, q) || word}`;
}

/** "2 eggs", "1 egg", "100 g plain flour", "a pinch salt": an amount with what it's of. */
export function withAmount(shown: string, name: string, unit: string, units: Units = builtInUnits): string {
  if (!shown) return name;
  if (shown === '1' && !unitKey(unit, units)) return `1 ${name.replace(/\S+$/, (w) => singularOf(units, w))}`;
  return `${shown} ${name}`;
}

/** "×2", "×0.67". */
export const timesText = (t: number) => `×${Math.round(t * 100) / 100}`;

/** "weight" or "volume"; null for a count or a word like "slice". */
export function measuredBy(unit: string): 'weight' | 'volume' | null {
  const m = MEASURES[unitKey(unit)];
  return m ? (m.dim === 'mass' ? 'weight' : 'volume') : null;
}

/** What to give an amount in, for a message: "g, kg, oz or lb". */
export function unitsLike(unit: string): string | null {
  const m = MEASURES[unitKey(unit)];
  if (!m) return null;
  const labels = Object.values(MEASURES).filter((x) => x.dim === m.dim).map((x) => x.plural ?? x.label);
  return andList(labels).replace(/ and ([^,]+)$/, ' or $1');
}
