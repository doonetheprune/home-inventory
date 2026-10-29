/**
 * Price units. A price is per one of the item's own unit (a bag, a roll), or
 * by weight or volume (per 100 g, per kg, per 100 ml, per litre). Going
 * between an item and a weight needs the item's size ("1 bag = 200 g").
 */
import { z } from 'zod';

export type Dim = 'item' | 'mass' | 'volume';

export const MEASURES: Record<string, { dim: Dim; base: number; label: string }> = {
  g: { dim: 'mass', base: 1, label: 'g' },
  '100g': { dim: 'mass', base: 100, label: '100 g' },
  kg: { dim: 'mass', base: 1000, label: 'kg' },
  ml: { dim: 'volume', base: 1, label: 'ml' },
  '100ml': { dim: 'volume', base: 100, label: '100 ml' },
  l: { dim: 'volume', base: 1000, label: 'litre' },
};

const ALIASES: Record<string, string> = {
  gram: 'g', grams: 'g', gramme: 'g', grammes: 'g', '100gram': '100g', '100grams': '100g',
  kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', kgs: 'kg',
  millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml', '100millilitres': '100ml',
  litre: 'l', litres: 'l', liter: 'l', liters: 'l', ltr: 'l',
};

/** Words meaning "one of the item's own unit". */
const ONE = new Set(['each', 'item', 'unit', 'one', 'pack']);

/** How much one of the item's own unit holds, e.g. a bag of spinach is 200 g. */
export const ItemSize = z.object({
  amount: z.number().positive().max(1_000_000),
  unit: z.enum(['g', 'kg', 'ml', 'l']),
});
export type ItemSize = z.infer<typeof ItemSize>;

/** "100 g", "per kg", "Litres", "bags" → "100g", "kg", "l", "bag". */
export function unitKey(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/^(per|a|an)\s+/, '').replace(/[\s.]/g, '');
  if (ALIASES[k]) return ALIASES[k]!;
  if (MEASURES[k]) return k;
  if (k.length > 4 && k.endsWith('ies')) return `${k.slice(0, -3)}y`;
  if (/(x|ch|sh|ss)es$/.test(k)) return k.slice(0, -2);
  if (k.length > 3 && k.endsWith('s') && !k.endsWith('ss')) return k.slice(0, -1);
  return k;
}

export const isMeasure = (unit: string) => !!MEASURES[unitKey(unit)];

/** How much one `unit` is, in each dimension it can be measured in. Empty for units Larder doesn't know. */
function amounts(unit: string, itemUnit: string, size: ItemSize | null): Partial<Record<Dim, number>> {
  const k = unitKey(unit);
  const m = MEASURES[k];
  if (m) return { [m.dim]: m.base };
  const own = unitKey(itemUnit);
  const ownMeasure = MEASURES[own];
  if (k === own) return ownMeasure ? { [ownMeasure.dim]: ownMeasure.base } : { item: 1, ...(size ? { [MEASURES[size.unit]!.dim]: size.amount * MEASURES[size.unit]!.base } : {}) };
  if (ONE.has(k) && !ownMeasure) return amounts(itemUnit, itemUnit, size);
  return {};
}

/**
 * The factor that turns a price per `from` into a price per `to` (so £5 a kg
 * × 0.1 = £0.50 per 100 g), or null when they can't be compared.
 */
export function priceFactor(from: string, to: string, itemUnit: string, size: ItemSize | null): number | null {
  const a = amounts(from, itemUnit, size);
  const b = amounts(to, itemUnit, size);
  for (const d of ['item', 'mass', 'volume'] as const) {
    if (a[d] && b[d]) return b[d]! / a[d]!;
  }
  return null;
}

/** Why two units can't be compared, in words for people and assistants. */
export function whyNot(from: string, to: string, item: { name: string; unit: string }): string {
  for (const u of [from, to]) {
    if (!Object.keys(amounts(u, item.unit, null)).length && !Object.keys(amounts(u, item.unit, { amount: 1, unit: 'g' })).length) {
      return `Larder doesn't know the unit "${u}". Use ${isMeasure(item.unit) ? '' : `${unitKey(item.unit)}, `}g, 100 g, kg, ml, 100 ml or litre.`;
    }
  }
  const dims = [from, to].map((u) => MEASURES[unitKey(u)]?.dim ?? 'item');
  if (dims.includes('item')) {
    const other = MEASURES[unitKey(dims[0] === 'item' ? to : from)];
    return `Larder doesn't know how much is in one ${unitKey(item.unit)} of ${item.name}, so it can't work out a price ${perText(dims[0] === 'item' ? to : from, item.unit)}. Say how much one holds (for example 1 ${unitKey(item.unit)} = 200 ${other?.dim === 'volume' ? 'ml' : 'g'}) with set_item_size, or on the item's price card.`;
  }
  return 'A price by weight can\'t be compared with a price by volume.';
}

/** "per 100 g", "a kg", "a litre", "a bag". */
export function perText(unit: string, itemUnit: string): string {
  const k = unitKey(unit);
  const m = MEASURES[k];
  if (m) return m.base === 100 ? `per ${m.label}` : `a ${m.label}`;
  const name = ONE.has(k) ? unitKey(itemUnit) : k;
  return /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`;
}

/** The units a price can be shown per for this item, its own unit first. */
export function choicesFor(itemUnit: string, size: ItemSize | null): string[] {
  const own = unitKey(itemUnit);
  const ownMeasure = MEASURES[own];
  if (ownMeasure) return ownMeasure.dim === 'mass' ? ['100g', 'kg'] : ['100ml', 'l'];
  const dim = size ? MEASURES[size.unit]!.dim : null;
  return [own, ...(dim === 'volume' ? ['100ml', 'l'] : dim === 'mass' ? ['100g', 'kg'] : ['100g', 'kg', '100ml', 'l'])];
}

/** What a price card shows by default: per item, or per 100 g / kg / 100 ml / litre for things counted by weight or volume. */
export function defaultShow(itemUnit: string): string {
  const own = unitKey(itemUnit);
  return ({ g: '100g', ml: '100ml' } as Record<string, string>)[own] ?? own;
}

/** Units a pack's size can be given in. */
export function packUnitsFor(itemUnit: string): string[] {
  const own = unitKey(itemUnit);
  const ownMeasure = MEASURES[own];
  if (ownMeasure) return ownMeasure.dim === 'mass' ? ['g', 'kg'] : ['ml', 'l'];
  return [own, 'g', 'kg', 'ml', 'l'];
}
