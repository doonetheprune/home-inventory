/**
 * Price units. A price is per one of the item's own unit (a tea bag, a roll),
 * per its pack (a box of 20), or by weight or volume (per 100 g, per kg, per
 * 100 ml, per litre). Going between an item and a weight needs its size
 * ("1 bag = 200 g"); its pack comes from the item (core `product.pack`).
 */
import { z } from 'zod';
import type { Pack } from '@larder/core';

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

/** A unit as it's said, one of it: "100 g", "per kg", "Litres", "Tea bags" → "100g", "kg", "l", "tea bag". */
export function unitName(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/^(per|a|an)\s+/, '').replace(/\./g, '').replace(/\s+/g, ' ');
  const tight = k.replace(/\s/g, '');
  if (ALIASES[tight]) return ALIASES[tight]!;
  if (MEASURES[tight]) return tight;
  if (k.length > 4 && k.endsWith('ies')) return `${k.slice(0, -3)}y`;
  if (/(x|ch|sh|ss)es$/.test(k)) return k.slice(0, -2);
  if (k.length > 3 && k.endsWith('s') && !k.endsWith('ss')) return k.slice(0, -1);
  return k;
}

/** A unit to compare by: its name without spaces ("tea bag" and "teabags" are the same). */
export const unitKey = (raw: string): string => unitName(raw).replace(/\s/g, '');

export const isMeasure = (unit: string) => !!MEASURES[unitKey(unit)];

const isPack = (k: string, pack: Pack | null) => !!pack && unitKey(pack.name) === k;

/** How much one `unit` is, in each dimension it can be measured in. Empty for units Larder doesn't know. */
function amounts(unit: string, itemUnit: string, size: ItemSize | null, pack: Pack | null = null): Partial<Record<Dim, number>> {
  const k = unitKey(unit);
  const m = MEASURES[k];
  if (m) return { [m.dim]: m.base };
  const own = unitKey(itemUnit);
  const ownMeasure = MEASURES[own];
  if (k === own) return ownMeasure ? { [ownMeasure.dim]: ownMeasure.base } : { item: 1, ...(size ? { [MEASURES[size.unit]!.dim]: size.amount * MEASURES[size.unit]!.base } : {}) };
  // Its pack is so many of its own unit ("pack" too, which otherwise means one of its own).
  if (isPack(k, pack)) {
    const one = amounts(itemUnit, itemUnit, size);
    return Object.fromEntries(Object.entries(one).map(([d, n]) => [d, n * pack!.holds]));
  }
  if (ONE.has(k) && !ownMeasure) return amounts(itemUnit, itemUnit, size);
  return {};
}

/**
 * The factor that turns a price per `from` into a price per `to` (so £5 a kg
 * × 0.1 = £0.50 per 100 g), or null when they can't be compared.
 */
export function priceFactor(from: string, to: string, itemUnit: string, size: ItemSize | null, pack: Pack | null = null): number | null {
  const a = amounts(from, itemUnit, size, pack);
  const b = amounts(to, itemUnit, size, pack);
  for (const d of ['item', 'mass', 'volume'] as const) {
    if (a[d] && b[d]) return b[d]! / a[d]!;
  }
  return null;
}

/** Why two units can't be compared, in words for people and assistants. */
export function whyNot(from: string, to: string, item: { name: string; unit: string; pack?: Pack | null }): string {
  const pack = item.pack ?? null;
  for (const u of [from, to]) {
    if (!Object.keys(amounts(u, item.unit, null, pack)).length && !Object.keys(amounts(u, item.unit, { amount: 1, unit: 'g' }, pack)).length) {
      return `Larder doesn't know the unit "${u}". Use ${isMeasure(item.unit) ? '' : `${unitName(item.unit)}, `}${pack ? `${unitName(pack.name)}, ` : ''}g, 100 g, kg, ml, 100 ml or litre${pack ? '' : `, or say what ${item.name} comes in on the item's Edit page`}.`;
    }
  }
  const dims = [from, to].map((u) => MEASURES[unitKey(u)]?.dim ?? 'item');
  if (dims.includes('item')) {
    const other = MEASURES[unitKey(dims[0] === 'item' ? to : from)];
    return `Larder doesn't know how much is in one ${unitName(item.unit)} of ${item.name}, so it can't work out a price ${perText(dims[0] === 'item' ? to : from, item.unit, pack)}. Say how much one holds (for example 1 ${unitName(item.unit)} = 200 ${other?.dim === 'volume' ? 'ml' : 'g'}) with set_item_size, or on the item's price card.`;
  }
  return 'A price by weight can\'t be compared with a price by volume.';
}

/** "per 100 g", "a kg", "a litre", "a bag", "a box" (its pack). */
export function perText(unit: string, itemUnit: string, pack: Pack | null = null): string {
  const k = unitKey(unit);
  const m = MEASURES[k];
  if (m) return m.base === 100 ? `per ${m.label}` : `a ${m.label}`;
  const name = ONE.has(k) && !isPack(k, pack) ? unitName(itemUnit) : unitName(unit);
  return /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`;
}

/** The units a price can be shown per for this item: its own unit, its pack, then weights or volumes. */
export function choicesFor(itemUnit: string, size: ItemSize | null, pack: Pack | null = null): string[] {
  const own = unitName(itemUnit);
  const ownMeasure = MEASURES[own];
  const packed = pack ? [unitName(pack.name)] : [];
  if (ownMeasure) return [...(ownMeasure.dim === 'mass' ? ['100g', 'kg'] : ['100ml', 'l']), ...packed];
  const dim = size ? MEASURES[size.unit]!.dim : null;
  return [own, ...packed, ...(dim === 'volume' ? ['100ml', 'l'] : dim === 'mass' ? ['100g', 'kg'] : ['100g', 'kg', '100ml', 'l'])];
}

/** What a price card shows by default: per item, or per 100 g / kg / 100 ml / litre for things counted by weight or volume. */
export function defaultShow(itemUnit: string): string {
  const own = unitName(itemUnit);
  return ({ g: '100g', ml: '100ml' } as Record<string, string>)[own] ?? own;
}

/** Units a pack's size can be given in. */
export function packUnitsFor(itemUnit: string, pack: Pack | null = null): string[] {
  const own = unitName(itemUnit);
  const ownMeasure = MEASURES[own];
  const packed = pack ? [unitName(pack.name)] : [];
  if (ownMeasure) return [...(ownMeasure.dim === 'mass' ? ['g', 'kg'] : ['ml', 'l']), ...packed];
  return [own, ...packed, 'g', 'kg', 'ml', 'l'];
}
