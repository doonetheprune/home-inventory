/**
 * Units. This is the only place in Larder that knows about them (docs/plans/units.md,
 * "Rules for the code"): nothing else has a unit table, unit aliases or a guess at plurals.
 *
 * - **The list.** Built-in units and the household's own count words, each a count (bag,
 *   tea bag), a weight (g, kg) or a volume (ml, L, pint), with what one and several are
 *   called. Stored as keys: the singular in lower case ("tea bag", "l").
 * - **The converter.** An amount in any unit an item can be given in, as what it's bought in
 *   (`toBoughtIn`), and back again (`fromBoughtIn`). It has three cases, each reading one
 *   field: in what it's bought in (`unit`), in what one contains when that's a count
 *   (`contents`), and in a weight or volume, through what one weighs (`weight`, always in g
 *   or ml). Nothing else turns an amount into what an item is bought in, nothing reads
 *   `contents` for grams, and only the converter reads `weight`.
 * - **Saying amounts.** "4 boxes", "about ¾ jar", "350 g", "1.6 kg", "1 tea bag a day",
 *   "a box lasts 20 days".
 *
 * The web app imports these too (through "@larder/core"), so it says amounts the same way.
 */
import { ValidationError } from '../errors';
import type { Unit, UnitKind } from '../model';
import { roundQty } from '../util';

export type { Unit, UnitKind } from '../model';

/** An amount in a unit from the list: what one contains (20 tea bags, 1 kg) or weighs (400 g). */
export interface UnitAmount { amount: number; unit: string }

/** How fast something is used: `amount` (in `unit`, or what it's bought in) every `everyDays` days. */
export interface UnitUsage { amount: number; everyDays: number; auto?: boolean; unit?: string | null }

/** What the converter and the text helpers read of an item. */
export interface UnitItem {
  name: string;
  /** Bought in: a key from the list. */
  unit: string;
  /** What one contains: a count (20 tea bags) or an amount (1 kg). */
  contents?: UnitAmount | null;
  /** What one weighs or holds, in g or ml. */
  weight?: UnitAmount | null;
  usage?: UnitUsage | null;
}

/** A word the household adds to the list: always a count. */
export interface HouseholdUnit { one: string; many: string }

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

/** Counts: [one, many, other ways people write it]. */
const COUNTS: Array<[string, string, ...string[]]> = [
  ['each', 'each', 'ea', 'one', 'ones', 'item', 'items', 'unit', 'units', 'single', 'singles', 'x'],
  ['bag', 'bags'], ['bale', 'bales'], ['bar', 'bars'], ['battery', 'batteries'], ['block', 'blocks'], ['bottle', 'bottles', 'btl', 'btls'],
  ['box', 'boxes', 'bx'], ['bucket', 'buckets'], ['bulb', 'bulbs'], ['bunch', 'bunches'], ['bundle', 'bundles'],
  ['can', 'cans'], ['candle', 'candles'], ['canister', 'canisters'], ['capsule', 'capsules', 'caps'], ['card', 'cards'],
  ['carton', 'cartons'], ['cartridge', 'cartridges'], ['case', 'cases'], ['clove', 'cloves'], ['coil', 'coils'],
  ['crate', 'crates'], ['cube', 'cubes'], ['cylinder', 'cylinders'], ['disc', 'discs', 'disk', 'disks'], ['dose', 'doses'],
  ['egg', 'eggs'], ['envelope', 'envelopes'], ['fillet', 'fillets'], ['filter', 'filters'], ['head', 'heads'],
  ['jar', 'jars'], ['jerrycan', 'jerrycans'], ['jug', 'jugs'], ['kit', 'kits'], ['lens', 'lenses'], ['loaf', 'loaves'], ['log', 'logs'],
  ['metre', 'metres', 'm', 'meter', 'meters', 'mtr', 'mtrs'], ['nappy', 'nappies', 'diaper', 'diapers'], ['net', 'nets'],
  ['pack', 'packs', 'pk', 'pks'], ['packet', 'packets', 'pkt', 'pkts'], ['pad', 'pads'], ['pair', 'pairs', 'pr', 'prs'],
  ['piece', 'pieces', 'pc', 'pcs'], ['pill', 'pills'], ['pod', 'pods'], ['portion', 'portions'], ['pot', 'pots'], ['pouch', 'pouches'],
  ['punnet', 'punnets'], ['ream', 'reams'], ['refill', 'refills'], ['reel', 'reels'], ['roll', 'rolls'], ['sachet', 'sachets'],
  ['sack', 'sacks'], ['sensor', 'sensors'], ['set', 'sets'], ['sheet', 'sheets'], ['slice', 'slices'], ['spool', 'spools'],
  ['spray', 'sprays'], ['stick', 'sticks'], ['tablet', 'tablets', 'tab', 'tabs'], ['tea bag', 'tea bags'], ['tin', 'tins'],
  ['tray', 'trays'], ['tub', 'tubs'], ['tube', 'tubes'], ['vial', 'vials'], ['wipe', 'wipes'],
];

/** Weights and volumes: [key, one, many, g or ml in one, other ways people write it]. */
const MEASURES: Array<[string, string, string, UnitKind, number, ...string[]]> = [
  ['g', 'g', 'g', 'weight', 1, 'gram', 'grams', 'gramme', 'grammes', 'gr', 'grm', 'grms', 'gm', 'gms'],
  ['kg', 'kg', 'kg', 'weight', 1000, 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'],
  ['ml', 'ml', 'ml', 'volume', 1, 'mls', 'millilitre', 'millilitres', 'milliliter', 'milliliters'],
  ['cl', 'cl', 'cl', 'volume', 10, 'cls', 'centilitre', 'centilitres', 'centiliter', 'centiliters'],
  ['l', 'L', 'L', 'volume', 1000, 'litre', 'litres', 'liter', 'liters', 'ltr', 'ltrs', 'lt'],
  ['pint', 'pint', 'pints', 'volume', 568.261, 'pt', 'pts'],
];

/** How a word is compared: lower case, single spaces, no hyphens or full stop ("Tea-bags." is "tea bags"). */
const tidy = (word: string) => word.trim().toLowerCase().replace(/[-_]/g, ' ').replace(/\.$/, '').replace(/\s+/g, ' ');
/** Without spaces, so "teabags" finds "tea bags". */
const squash = (word: string) => tidy(word).replace(/\s/g, '');

const ALIASES = new Map<string, string>();
export const BUILT_IN_UNITS: readonly Unit[] = [
  ...COUNTS.map(([one, many, ...also]) => {
    for (const a of also) ALIASES.set(a, one);
    return { key: one, one, many, kind: 'count' as const, factor: null, builtIn: true };
  }),
  ...MEASURES.map(([key, one, many, kind, factor, ...also]) => {
    for (const a of also) ALIASES.set(a, key);
    return { key, one, many, kind, factor, builtIn: true };
  }),
];

/** The unit list: built in, then the household's own words. */
export interface Units {
  readonly all: readonly Unit[];
  /** The unit a word means: its key, one or many in any case, or a common spelling ("kgs", "litre", "pkt"). Null when it isn't on the list. */
  find(word: string | null | undefined): Unit | null;
}

export function unitList(household: readonly HouseholdUnit[] = []): Units {
  const own: Unit[] = household.map((u) => ({ key: tidy(u.one), one: u.one.trim(), many: u.many.trim(), kind: 'count', factor: null, builtIn: false }));
  const all = [...BUILT_IN_UNITS, ...own];
  const index = new Map<string, Unit>();
  const add = (word: string, u: Unit) => {
    for (const w of [tidy(word), squash(word)]) if (!index.has(w)) index.set(w, u);
  };
  // Built-in words first, then their other spellings, then the household's (which never clash: see newUnit).
  for (const u of BUILT_IN_UNITS) for (const w of [u.key, u.one, u.many]) add(w, u);
  for (const [alias, key] of ALIASES) add(alias, BUILT_IN_UNITS.find((u) => u.key === key)!);
  for (const u of own) for (const w of [u.key, u.one, u.many]) add(w, u);
  return {
    all,
    find(word) {
      if (word === null || word === undefined) return null;
      return index.get(tidy(word)) ?? index.get(squash(word)) ?? null;
    },
  };
}

/** The built-in list on its own, for places that have no household (tests, the app before it has loaded). */
export const builtInUnits = unitList();

/** A unit that isn't on the list. The assistant tools add how to ask for it to be added. */
export class UnknownUnitError extends ValidationError {
  constructor(readonly word: string) {
    super(`Larder doesn't have the unit "${word.trim()}". Add it in Settings → Units, then try again.`);
  }
}

/** The unit a word means, or an UnknownUnitError. */
export function unitOf(units: Units, word: string): Unit {
  const u = units.find(word);
  if (!u) throw new UnknownUnitError(word);
  return u;
}

/** Its key: the unit's, or the word tidied when it isn't on the list (an old item's "4 pint bottle"). */
export const unitKeyOf = (units: Units, word: string) => units.find(word)?.key ?? tidy(word);

export const isCount = (units: Units, key: string | null | undefined) => (units.find(key)?.kind ?? 'count') === 'count';
/** Weight or volume: g, kg, ml, cl, L, pint. */
export const isMeasure = (units: Units, key: string | null | undefined) => !isCount(units, key);
/** Things bought loose are bought in g or ml. */
export const isLoose = (units: Units, item: Pick<UnitItem, 'unit'>) => isMeasure(units, item.unit);

/**
 * A word the household wants to add, tidied: a count with a singular and a plural, and
 * not one Larder already has (by either word, or a common spelling of one).
 */
export function newUnit(units: Units, input: HouseholdUnit): HouseholdUnit {
  const one = input.one.trim().replace(/\s+/g, ' ');
  const many = input.many.trim().replace(/\s+/g, ' ');
  if (!one || !many) throw new ValidationError('Give the unit\'s singular and plural, e.g. "sleeve" and "sleeves".');
  if (/\d/.test(one + many)) throw new ValidationError('A unit is a word, without a number: "sleeve", not "sleeve of 50". Say how many one contains on the item.');
  for (const w of [one, many]) {
    const has = units.find(w);
    if (has) throw new ValidationError(`Larder already has "${has.one}"${has.builtIn ? '' : ' (added by the household)'}${tidy(w) === tidy(has.one) || tidy(w) === tidy(has.many) ? '' : `, which "${w}" means`}.`);
  }
  return { one, many };
}

/* ------------------------------------------------------------------ */
/* The converter                                                       */
/* ------------------------------------------------------------------ */

/** "boxes", or "ones" for things counted one by one. */
function manyOf(units: Units, key: string): string {
  const u = units.find(key);
  if (u?.key === 'each') return 'ones';
  return u ? u.many : pluralOf(key, 2);
}

/** "g or kg", "ml, cl, L or pints": the weights or volumes something can be given in. */
function measuresText(units: Units, kind: UnitKind): string {
  return orList(units.all.filter((u) => u.kind === kind).map((u) => u.many));
}

/** "Give how many boxes or tea bags, or how much in g or kg.": what an item can be given in. */
export function givenInText(units: Units, item: UnitItem): string {
  const bought = units.find(item.unit);
  if (bought && bought.kind !== 'count') return `Give how much in ${measuresText(units, bought.kind)}.`;
  const c = item.contents ?? null;
  const inside = c && isCount(units, c.unit) ? manyOf(units, c.unit) : null;
  const counts = bought?.key === 'each' ? `how many${inside ? `, or how many ${inside}` : ''}` : `how many ${orList([manyOf(units, item.unit), ...(inside ? [inside] : [])])}`;
  const w = item.weight ?? null;
  const kind: UnitKind | null = w ? (w.unit === 'ml' ? 'volume' : 'weight') : null;
  return `Give ${counts}${kind ? `, or how much in ${measuresText(units, kind)}` : ''}.`;
}

/** "Twinings Sleep is bought in boxes, each containing 20 tea bags." */
function boughtInSentence(units: Units, item: UnitItem): string {
  const loose = isLoose(units, item);
  const c = item.contents ?? null;
  const has = c ? `, each containing ${amountText(units, c.amount, c.unit)}` : '';
  if (loose) return `${item.name} is bought loose, by ${units.find(item.unit)!.kind}.`;
  if (units.find(item.unit)?.key === 'each') return `${item.name} is counted one by one${has}.`;
  return `${item.name} is bought in ${manyOf(units, item.unit)}${has}.`;
}

/** A weight or volume's kind, and how many g or ml one is. */
const base = (u: Unit) => ({ kind: u.kind, factor: u.factor! });

/**
 * How many of what the item is bought in `amount` of `unit` is: `unit` left out (or what
 * it's bought in) as it is; what one contains, when that's a count (5 tea bags of a box of
 * 20 is 0.25 box); a weight or volume through what one weighs (100 g of a 400 g jar is 0.25
 * jar). Anything else is a ValidationError that says what the item can be given in.
 * Not rounded: callers keep stock to thousandths, but a usage needs the exact amount.
 */
export function toBoughtIn(units: Units, item: UnitItem, amount: number, unit?: string | null): number {
  return amount * perBoughtIn(units, item, unit);
}

/** `amount` of what the item is bought in, as `unit`: 0.25 box of 20 tea bags is 5 tea bags. */
export function fromBoughtIn(units: Units, item: UnitItem, amount: number, unit: string): number {
  return amount / perBoughtIn(units, item, unit);
}

/** Whether an amount in `unit` can be turned into what the item is bought in. */
export function canConvert(units: Units, item: UnitItem, unit: string | null | undefined): boolean {
  try {
    perBoughtIn(units, item, unit);
    return true;
  } catch {
    return false;
  }
}

/** How many of what it's bought in one `unit` is. */
function perBoughtIn(units: Units, item: UnitItem, unit: string | null | undefined): number {
  // 1. In what it's bought in: as it is. An old item's unit that isn't on the list still works as itself.
  if (unit === undefined || unit === null || !unit.trim() || tidy(unit) === tidy(item.unit)) return 1;
  const u = unitOf(units, unit);
  const bought = units.find(item.unit);
  if (u.key === bought?.key) return 1;
  // 2. In what one contains, when that's a count: divided by how many one contains.
  const c = item.contents ?? null;
  if (u.kind === 'count') {
    if (c && units.find(c.unit)?.key === u.key && isCount(units, c.unit)) return 1 / c.amount;
    throw new ValidationError(`${boughtInSentence(units, item)} ${givenInText(units, item)}`);
  }
  // 3. In a weight or volume: as g or ml, then through what one weighs (or, bought loose, as it is).
  const want = base(u);
  if (bought && bought.kind !== 'count') {
    const own = base(bought);
    if (own.kind !== want.kind) throw new ValidationError(`${item.name} is bought loose, by ${own.kind}, so it can't be given in ${u.one}. ${givenInText(units, item)}`);
    return want.factor / own.factor;
  }
  const w = item.weight ?? null;
  const one = bought?.key === 'each' ? 'one' : `one ${bought?.one ?? item.unit}`;
  if (!w) throw new ValidationError(`Larder doesn't know what ${one} of ${item.name} ${want.kind === 'weight' ? 'weighs' : 'holds'}, so it can't work in ${u.one}. ${givenInText(units, item)} Or give it a Weight first.`);
  const has: UnitKind = w.unit === 'ml' ? 'volume' : 'weight';
  if (has !== want.kind) throw new ValidationError(`${one[0]!.toUpperCase()}${one.slice(1)} of ${item.name} ${has === 'weight' ? 'weighs' : 'holds'} ${weightText(w)}, so it can't be given in ${u.one}: a ${want.kind} can't be worked out from a ${has}. ${givenInText(units, item)}`);
  return want.factor / w.amount;
}

/**
 * What a weight or volume is in g or ml, as Weight is kept: 1 kg is 1000 g, 4 pints 2273.044 ml.
 * Null for a count.
 */
export function asWeight(units: Units, amount: UnitAmount): UnitAmount | null {
  const u = unitOf(units, amount.unit);
  if (u.kind === 'count') return null;
  return { amount: roundQty(amount.amount * u.factor!), unit: u.kind === 'weight' ? 'g' : 'ml' };
}

/** The usage as so many of what it's bought in every so many days (1 tea bag a day of boxes of 20 is 0.05 box a day), or null when it can't be. */
export function usageInBoughtIn(units: Units, item: UnitItem): { amount: number; everyDays: number } | null {
  const u = item.usage ?? null;
  if (!u) return null;
  try {
    return { amount: toBoughtIn(units, item, u.amount, u.unit), everyDays: u.everyDays };
  } catch {
    return null;
  }
}

/** How many days `quantity` (in what it's bought in) lasts at its usage, or null without one. */
export function daysFor(units: Units, item: UnitItem, quantity: number): number | null {
  const u = usageInBoughtIn(units, item);
  return u ? (quantity * u.everyDays) / u.amount : null;
}

/**
 * Whether a plain Use starts one: with a usage Larder doesn't take out, always; with one it
 * does, only when none has been started (otherwise it's an extra). Something used a little at
 * a time (in what it contains, or by weight) isn't started one at a time, so a Use is just a
 * use of a whole one, unless Larder has stopped taking it out.
 */
export function startsOne(item: { usage?: UnitUsage | null; inUseSince?: string | null }): boolean {
  const u = item.usage ?? null;
  if (u?.unit) return !!u.auto && !item.inUseSince;
  return !!u && (!u.auto || !item.inUseSince);
}

/**
 * How many periods Larder waits before taking stock out, so what it takes rounds cleanly to the
 * thousandths stock is kept in: 0.0125 of a jar a day would round to 0.013 (4% too fast), so it
 * takes 0.025 every 2 days. Within 1%, and at most a month of days apart.
 */
export function periodsPerTake(perPeriod: number): number {
  for (let k = 1; k <= 31; k++) {
    const exact = k * perPeriod;
    if (Math.abs(roundQty(exact) - exact) <= exact * 0.01) return k;
  }
  return 1;
}

/* ------------------------------------------------------------------ */
/* Saying amounts                                                      */
/* ------------------------------------------------------------------ */

/** How a number is written: Larder keeps amounts to thousandths. The app passes its own ("1,200", "¾"). */
export type NumberText = (n: number) => string;
const plain: NumberText = (n) => String(roundQty(n));

/**
 * "2 tins", "1 battery", "350 g", "1.6 kg", "1.5 L", "3" (for things counted one by one).
 * Grams and millilitres of 1000 or more are said in kg and L.
 */
export function amountText(units: Units, n: number, unit: string, num: NumberText = plain): string {
  const u = units.find(unit);
  if (!u) return `${num(n)} ${unitWord(units, unit, roundQty(n))}`;
  if (u.key === 'each') return num(n);
  if ((u.key === 'g' || u.key === 'ml') && Math.abs(n) >= 1000) return amountText(units, n / 1000, u.key === 'g' ? 'kg' : 'l', num);
  const q = roundQty(n);
  return `${num(n)} ${q > 0 && q <= 1 ? u.one : u.many}`;
}

/** "tea bag" or "tea bags" for `n`, as shown after a number the app formats itself. Empty for things counted one by one. */
export function unitWord(units: Units, unit: string, n: number): string {
  const u = units.find(unit);
  const one = n > 0 && n <= 1;
  if (!u) return one ? unit.trim() : pluralOf(unit.trim(), 2);
  if (u.key === 'each') return '';
  return one ? u.one : u.many;
}

const QUARTERS: Record<number, string> = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
/** 3.75 as "3¾", 0.5 as "½", 4 as "4". */
const quarters = (q: number) => {
  const whole = Math.floor(q);
  const part = QUARTERS[Math.round((q - whole) * 4) / 4];
  return part ? `${whole || ''}${part}` : String(whole);
};

/**
 * Stock in what it's bought in: "4 boxes", "about 3¾ boxes", "about ¾ jar", "350 g", "1.6 kg".
 * Part of one left is said in quarters, at least ¼.
 */
export function stockText(units: Units, item: Pick<UnitItem, 'unit'>, n: number, num: NumberText = plain): string {
  if (isLoose(units, item) || Math.abs(n - Math.round(n)) < 0.001) return amountText(units, Math.round(n * 1000) / 1000, item.unit, num);
  const q = Math.max(0.25, Math.round(n * 4) / 4);
  const word = unitWord(units, item.unit, q);
  return `about ${Number.isInteger(q) ? num(q) : quarters(q)}${word ? ` ${word}` : ''}`;
}

/** What part of one is best said in: what one contains when that's a count, else what it's used in or its Weight's g or ml. Null when there's none. */
function insideUnit(units: Units, item: UnitItem): string | null {
  if (isLoose(units, item)) return null;
  const c = item.contents ?? null;
  if (c && isCount(units, c.unit)) return c.unit;
  const u = item.usage?.unit ?? null;
  if (u && canConvert(units, item, u)) return u;
  return item.weight ? item.weight.unit : null;
}

/**
 * An amount of what it's bought in, exactly, with what's inside when it's part of one:
 * "0.35 box (7 tea bags)", "2 boxes", "0.75 jar (300 g)". For assistants, which need the exact amount.
 */
export function exactText(units: Units, item: UnitItem, n: number): string {
  const inside = Math.abs(n - Math.round(n)) < 0.001 ? null : insideUnit(units, item);
  const said = amountText(units, n, item.unit);
  return inside ? `${said} (${amountText(units, roundQty(fromBoughtIn(units, item, n, inside)), inside)})` : said;
}

/** Stock as stockText says it, with the exact amount inside when part of one is left: "about 4 boxes (79 tea bags)", "about ¾ jar (300 g)", "3.8 boxes". */
export function stockWithInside(units: Units, item: UnitItem, n: number): string {
  if (isLoose(units, item) || Math.abs(n - Math.round(n)) < 0.001) return stockText(units, item, n);
  const inside = insideUnit(units, item);
  return inside ? `${stockText(units, item, n)} (${amountText(units, roundQty(fromBoughtIn(units, item, n, inside)), inside)})` : amountText(units, n, item.unit);
}

/** "Bought in boxes", "Bought one at a time", "Bought loose, by weight (g)". */
export function boughtInText(units: Units, item: Pick<UnitItem, 'unit'>): string {
  const u = units.find(item.unit);
  if (!u) return `Bought in "${item.unit}" (not on the unit list)`;
  if (u.key === 'each') return 'Bought one at a time';
  if (u.kind !== 'count') return `Bought loose, by ${u.kind} (${u.one})`;
  return `Bought in ${u.many}`;
}

/** "Each box contains 20 tea bags", "Each bag contains 1 kg", or null without Contains. */
export function containsText(units: Units, item: Pick<UnitItem, 'unit' | 'contents'>): string | null {
  const c = item.contents ?? null;
  if (!c) return null;
  const u = units.find(item.unit);
  return `Each ${u?.key === 'each' ? 'one' : (u?.one ?? item.unit)} contains ${amountText(units, c.amount, c.unit)}`;
}

/** "30 g", "2273 ml": what one weighs or holds, in g or ml as it's kept. */
export function weightText(weight: UnitAmount): string {
  const n = weight.amount >= 100 ? Math.round(weight.amount) : Math.round(weight.amount * 10) / 10;
  return `${n} ${weight.unit}`;
}

/** "a day", "a week", "every 2 weeks", "every 14 days" → in words. */
export function everyText(days: number): string {
  if (days === 1) return 'a day';
  if (days === 7) return 'a week';
  if (days % 7 === 0) return `every ${days / 7} weeks`;
  return `every ${days} days`;
}

/** "1 tea bag a day", "2 rolls a week", "4 g a day", "1 every 14 days". Empty without a usage. */
export function usageText(units: Units, item: UnitItem, num: NumberText = plain): string {
  const u = item.usage ?? null;
  return u ? `${amountText(units, u.amount, u.unit ?? item.unit, num)} ${everyText(u.everyDays)}` : '';
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

/** "a box lasts 20 days", "one lasts 2 weeks": how long one of what it's bought in lasts. Null without a usage, or for things bought loose. */
export function lastsText(units: Units, item: UnitItem): string | null {
  const per = usageInBoughtIn(units, item);
  if (!per || isLoose(units, item)) return null;
  const u = units.find(item.unit);
  const one = !u || u.key === 'each' ? 'one' : `a ${u.one}`;
  return `${one} lasts ${durationText(per.everyDays / per.amount)}`;
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

/**
 * A pack size as printed ("400 g", "1,5 kg", "20 tea bags", "80 pyramid tea bags", "4 x 415 g"): so many
 * of a unit on the list, and how many of them a multipack has (4). Null when it can't be read.
 */
export function parseAmount(units: Units, text: string | null | undefined): { amount: number; unit: string; count: number } | null {
  const t = (text ?? '').toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  const m = /(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*([a-z][a-z .'-]*)/.exec(t);
  if (!m) return null;
  const words = m[3]!.trim().split(/\s+/);
  // The first words that are a unit, the longest first: "pyramid tea bags" is tea bags.
  for (let i = 0; i < words.length; i++) {
    for (let j = words.length; j > i; j--) {
      const u = units.find(words.slice(i, j).join(' '));
      if (u && u.key !== 'each') return { amount: Number(m[2]), unit: u.key, count: m[1] ? Number(m[1]) : 1 };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Words that aren't units                                             */
/* ------------------------------------------------------------------ */

/**
 * The plural of a word that isn't on the list (a shelf label, a recipe's "handful", an old
 * item's unit Larder doesn't have): a guess. Units on the list say their own plural.
 */
export function pluralOf(word: string, n: number): string {
  if (n === 1) return word;
  if (/[^f]f$/i.test(word)) return `${word.slice(0, -1)}ves`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** "handfuls" → "handful", "slices" → "slice": the singular of a word, from the list when it's on it, else a guess. */
export function singularOf(units: Units, word: string): string {
  const u = units.find(word);
  return u ? u.key : singularGuess(tidy(word));
}

/** The singular of a word that isn't a unit, a guess: "rolls" → "roll", "batteries" → "battery", "tomatoes" → "tomato". The resolver matches names with it. */
export function singularGuess(word: string): string {
  const w = word.toLowerCase();
  if (/(^|\s)(lens|series|species|gas|bus|plus)$/.test(w)) return w;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  // Tomatoes and potatoes, as recipes say them.
  if (/(x|ch|sh|ss|o)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** "a, b or c". */
function orList(items: string[]): string {
  const u = [...new Set(items)];
  return u.length <= 2 ? u.join(' or ') : `${u.slice(0, -1).join(', ')} or ${u.at(-1)}`;
}
