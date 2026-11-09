/**
 * Kitchen measures for scaling recipes. g, kg, ml, cl, L and pints are the core's own units, read
 * from its list with its spellings; the only words kept here are the kitchen measures it doesn't
 * have (oz, lb, spoons, fl oz), each so many of the core's g or ml (`inCore`), which is how an
 * ingredient becomes stock, through the core's converter. Anything else ("egg", "slice", "clove",
 * or no unit at all) is a count, and a count only matches itself; its singular and plural come
 * from the core's unit list.
 */
import { andList, builtInUnits, singularOf, unitWord, type Units } from '@larder/core';

type Dim = 'mass' | 'volume';

/** Kitchen measures the core doesn't have, each so many of its g or ml, with how they're written. */
const KITCHEN: Record<string, { unit: 'g' | 'ml'; amount: number; label: string; said: string[] }> = {
  oz: { unit: 'g', amount: 28.349523125, label: 'oz', said: ['ounce', 'ounces'] },
  lb: { unit: 'g', amount: 453.59237, label: 'lb', said: ['pound', 'pounds', 'lbs'] },
  tsp: { unit: 'ml', amount: 5, label: 'tsp', said: ['teaspoon', 'teaspoons', 'tsps'] },
  tbsp: { unit: 'ml', amount: 15, label: 'tbsp', said: ['tablespoon', 'tablespoons', 'tbsps', 'tbs', 'tbl'] },
  floz: { unit: 'ml', amount: 28.4130625, label: 'fl oz', said: ['fluidounce', 'fluidounces'] },
};
const SAID = new Map(Object.entries(KITCHEN).flatMap(([k, m]) => m.said.map((w) => [w, k] as const)));

/** A measure by its key, in g or ml: a kitchen one, or a weight or volume from the core's list. Null for a count. */
function measure(k: string): { dim: Dim; base: number; one: string; many: string } | null {
  const m = KITCHEN[k];
  if (m) return { dim: m.unit === 'g' ? 'mass' : 'volume', base: m.amount, one: m.label, many: m.label };
  const u = builtInUnits.find(k);
  if (!u || u.kind === 'count' || u.key !== k) return null;
  return { dim: u.kind === 'weight' ? 'mass' : 'volume', base: u.factor!, one: u.one, many: u.many };
}

/** Words that mean "just count them". */
const COUNT = new Set(['', 'each', 'x', 'whole', 'item', 'items', 'number']);

/** "Grams" → "g", "tablespoons" → "tbsp", "slices" → "slice", "each" or nothing → "" (a count). */
export function unitKey(raw: string, units: Units = builtInUnits): string {
  const k = raw.trim().toLowerCase().replace(/[\s.]/g, '');
  if (COUNT.has(k)) return '';
  if (KITCHEN[k]) return k;
  if (SAID.has(k)) return SAID.get(k)!;
  const core = builtInUnits.find(k);
  if (core && core.kind !== 'count') return core.key;
  return singularOf(units, raw.trim().toLowerCase()).replace(/\s/g, '');
}

/** A kitchen measure as the core's g or ml: 2 tbsp is 30 ml, 1 lb is 453.6 g. Null for a count. */
export function inCore(n: number, unit: string): { amount: number; unit: 'g' | 'ml' } | null {
  const m = measure(unitKey(unit));
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
  const ma = measure(a);
  const mb = measure(b);
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
  const m = measure(k);
  if (m) return `${q} ${q !== 1 ? m.many : m.one}`;
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
  const m = measure(unitKey(unit));
  return m ? (m.dim === 'mass' ? 'weight' : 'volume') : null;
}

/** What to give an amount in, for a message: "g, kg, oz or lb". */
export function unitsLike(unit: string): string | null {
  const m = measure(unitKey(unit));
  if (!m) return null;
  const core = builtInUnits.all.filter((u) => u.kind === (m.dim === 'mass' ? 'weight' : 'volume')).map((u) => u.many);
  const labels = [...core, ...Object.values(KITCHEN).filter((x) => (x.unit === 'g') === (m.dim === 'mass')).map((x) => x.label)];
  return andList(labels).replace(/ and ([^,]+)$/, ' or $1');
}
