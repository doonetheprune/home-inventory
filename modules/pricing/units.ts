/**
 * Price units. A price is per one of what the item is bought in (a box, a bag), per one of
 * what's in its pack when its pack size is a count (a tea bag), or by weight or volume (per 100 g, a kg,
 * per 100 ml, a litre) through the item's Weight. Every conversion goes through the core's
 * converter (`toBoughtIn`); the only words kept here are price labels, each so many of a core
 * unit ("100 g" is 100 g), and the words for "one of it" on a price ("each", "an item").
 */
import { LarderError, ValidationError, isCount, isLoose, measuredIn, toBoughtIn, unitOf, type Product, type Units } from '@larder/core';

type Item = Pick<Product, 'name' | 'unit' | 'packSize' | 'weight'>;

/** Price labels, by key: so many of a core unit, and how the label reads. */
const LABELS: Record<string, { unit: string; amount: number; label: string }> = {
  '100g': { unit: 'g', amount: 100, label: '100 g' },
  kg: { unit: 'kg', amount: 1, label: 'kg' },
  '100ml': { unit: 'ml', amount: 100, label: '100 ml' },
  l: { unit: 'l', amount: 1, label: 'litre' },
};
/** Words on a price that mean one of what it's bought in: "£1.20 each", "per item". */
const ONE = new Set(['each', 'item', 'items', 'one', 'unit']);

/** What a price is per: a key (a label, or a unit's key), and how much of a core unit that is. */
export interface PriceUnit { key: string; unit: string; amount: number }

/** "100 g", "per kg", "a Litre", "Tea bags", "each" → what it means for this item. Throws for a unit Larder doesn't have. */
export function priceUnit(units: Units, item: Pick<Item, 'unit'>, raw: string): PriceUnit {
  const said = raw.trim().toLowerCase().replace(/^(per|a|an)\s+/, '').replace(/\./g, '');
  const label = (key: string): PriceUnit => ({ key, unit: LABELS[key]!.unit, amount: LABELS[key]!.amount });
  if (LABELS[said.replace(/\s/g, '')]) return label(said.replace(/\s/g, ''));
  if (ONE.has(said)) return { key: unitOf(units, item.unit).key, unit: item.unit, amount: 1 };
  // "100 grams" is the 100 g label; "kilos" and "litre" are the kg and litre ones.
  const hundred = /^100\s*(.+)$/.exec(said);
  if (hundred) {
    const u = unitOf(units, hundred[1]!);
    if (LABELS[`100${u.key}`]) return label(`100${u.key}`);
  }
  const u = unitOf(units, said);
  return LABELS[u.key] ? label(u.key) : { key: u.key, unit: u.key, amount: 1 };
}

/** The key a price unit is kept under: "100g", "kg", "tea bag". */
export const priceKey = (units: Units, item: Pick<Item, 'unit'>, raw: string) => priceUnit(units, item, raw).key;

/** How many of what the item is bought in one price unit is (a tea bag of a box of 80 is 0.0125 box), or a ValidationError saying why it can't be worked out. */
function inBoughtIn(units: Units, item: Item, pu: PriceUnit): number {
  return toBoughtIn(units, item, pu.amount, pu.unit);
}

/** The factor that turns a price per `from` into a price per `to` (£5 a kg × 0.1 is £0.50 per 100 g). Throws when they can't be compared. */
export function priceFactor(units: Units, item: Item, from: string, to: string): number {
  const a = priceUnit(units, item, from);
  const b = priceUnit(units, item, to);
  if (a.key === b.key) return 1;
  // A kg as 100 g needs no Weight, only the core's g; a bag as a kg does.
  if (!isCount(units, a.unit) && !isCount(units, b.unit)) return measureFactor(units, from, to);
  return inBoughtIn(units, item, b) / inBoughtIn(units, item, a);
}

/** The same, or null when they can't be compared (the price card shows it as needing a Weight). */
export function factorOrNull(units: Units, item: Item, from: string, to: string): number | null {
  try {
    return priceFactor(units, item, from, to);
  } catch (err) {
    if (err instanceof LarderError) return null;
    throw err;
  }
}

/**
 * Between two weights or two volumes, with no item: "£3.50 a kg is £0.35 per 100 g". A count
 * needs the item, and a weight can't be compared with a volume.
 */
export function measureFactor(units: Units, from: string, to: string): number {
  const kindOfUnit = (raw: string) => {
    const pu = priceUnit(units, { unit: 'g' }, raw);
    return isCount(units, pu.unit) ? null : unitOf(units, pu.unit).kind;
  };
  const kinds = [kindOfUnit(from), kindOfUnit(to)];
  if (kinds.includes(null)) throw new ValidationError(`Say which item, so Larder knows how much one ${kinds[0] === null ? from.trim() : to.trim()} is.`);
  if (kinds[0] !== kinds[1]) throw new ValidationError('A price by weight can\'t be compared with a price by volume.');
  // As something bought loose in g or ml, the core converter needs nothing else.
  const loose = { name: 'it', unit: kinds[0] === 'weight' ? 'g' : 'ml', packSize: null, weight: null };
  return inBoughtIn(units, loose, priceUnit(units, loose, to)) / inBoughtIn(units, loose, priceUnit(units, loose, from));
}

/** "per 100 g", "a kg", "a litre", "a bag", "a tea bag", "an egg". */
export function perText(units: Units, item: Pick<Item, 'unit'>, raw: string): string {
  const pu = priceUnit(units, item, raw);
  const label = LABELS[pu.key];
  if (label) return label.amount === 100 ? `per ${label.label}` : `a ${label.label}`;
  const u = unitOf(units, pu.unit);
  const one = u.key === 'each' ? 'item' : u.one;
  return /^[aeiou]/i.test(one) ? `an ${one}` : `a ${one}`;
}

/** The weights or volumes a price can be per, through a Weight in g or ml, or both when there's none yet. */
const measuresFor = (kind: 'weight' | 'volume' | null) => (kind === 'weight' ? ['100g', 'kg'] : kind === 'volume' ? ['100ml', 'l'] : ['100g', 'kg', '100ml', 'l']);

/** What it's weighed or measured by: the unit it's bought loose in, or its Weight. Null with neither. */
function kindOf(units: Units, item: Item): 'weight' | 'volume' | null {
  const m = measuredIn(units, item);
  return m ? (m === 'ml' ? 'volume' : 'weight') : null;
}

/** What's in its pack, when its pack size is a count: a price can be per tea bag. */
const inside = (units: Units, item: Item) => (item.packSize && isCount(units, item.packSize.unit) ? [unitOf(units, item.packSize.unit).key] : []);

/** The units a price can be shown per for this item: what it's bought in, what's in its pack, then by weight or volume. */
export function choicesFor(units: Units, item: Item): string[] {
  if (isLoose(units, item)) return measuresFor(kindOf(units, item));
  return [item.unit, ...inside(units, item), ...measuresFor(kindOf(units, item))];
}

/** What a price card shows by default: per one of what it's bought in, or per 100 g or 100 ml for things bought loose. */
export function defaultShow(units: Units, item: Item): string {
  if (!isLoose(units, item)) return item.unit;
  return kindOf(units, item) === 'weight' ? '100g' : '100ml';
}

/** Units a pack's size can be given in: what it's bought in and what's in its pack, then weights or volumes. */
export function packUnitsFor(units: Units, item: Item): string[] {
  const kind = kindOf(units, item);
  const measures = units.all.filter((u) => u.kind !== 'count' && (!kind || u.kind === kind)).map((u) => u.key);
  return isLoose(units, item) ? measures : [item.unit, ...inside(units, item), ...measures];
}
