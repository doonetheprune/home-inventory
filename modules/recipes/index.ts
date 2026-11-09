/**
 * Recipes: the ones the household liked, saved (usually by an AI assistant)
 * so they can be found again and checked against what's in the house.
 *
 * Larder doesn't invent recipes; assistants do, from what's in stock and
 * what needs using soon. After cooking, Larder proposes what to take out of
 * stock and only does it once the person confirms (with quantities changed
 * if they like).
 *
 * Ingredients can carry ratios (2 eggs to 100 g flour to 300 ml milk), so a
 * recipe can be scaled: "I've only got 2 eggs" works out the rest. Amounts
 * people make often are kept as named presets ("Just me", "Family"); the
 * default one is used unless another is asked for.
 *
 * A recipe can belong to scenarios (Christmas, Halloween), by their ids from
 * the scenarios module, and can be kept for those scenarios only, so a
 * seasonal recipe doesn't crowd the main list.
 */
import { z } from 'zod';
import { amountText, andList, canConvert, defineModule, Id, LarderError, newId, NotFoundError, roundQty, toBoughtIn, unitWord, ValidationError, type CoreApi, type Product, type ProductSummary, type Units } from '@larder/core';
import { convert, inCore, measuredBy, measureText, timesText, unitKey, unitsLike, withAmount } from './units';

export const Ingredient = z.object({
  /** As the recipe says it, e.g. "chopped tomatoes". */
  name: z.string().min(1).max(120),
  /** The Larder item it uses, when there is one. */
  productId: Id.nullable().default(null),
  /** How much, in the item's own unit (e.g. 1 tin), used when cooking it takes stock. */
  quantity: z.number().positive().nullable().default(null),
  /** How the recipe puts it, e.g. "400 g" or "a handful". */
  amount: z.string().max(60).default(''),
  optional: z.boolean().default(false),
  /**
   * How much goes in for the recipe as saved, relative to the other
   * ingredients, in `ratioUnit`: 2 (eggs), 100 (g of flour). Scaling works from these.
   */
  ratio: z.number().positive().nullable().default(null),
  /** The ratio's measure: "g", "ml", "tsp", "slice"…; empty for a count (2 eggs). */
  ratioUnit: z.string().max(20).default(''),
});
export type Ingredient = z.infer<typeof Ingredient>;

/** Amounts the household makes often, e.g. "Family" at twice the recipe as saved. */
export const Preset = z.object({
  name: z.string().min(1).max(60),
  /** How many times the recipe as saved: its ratios, stock quantities and servings. */
  times: z.number().positive(),
});
export type Preset = z.infer<typeof Preset>;

const MAX_PRESETS = 20;

export const Recipe = z.object({
  id: Id,
  title: z.string().min(1).max(120),
  serves: z.number().int().positive().nullable().default(null),
  ingredients: z.array(Ingredient).max(60),
  method: z.string().max(20_000).default(''),
  notes: z.string().max(2000).default(''),
  /** Who wrote it, e.g. "Claude" or "Grandma". */
  source: z.string().max(60).default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastCookedAt: z.string().nullable().default(null),
  timesCooked: z.number().int().default(0),
  presets: z.array(Preset).max(MAX_PRESETS).default([]),
  /** The preset used when none is asked for; null for the amounts as saved. */
  defaultPreset: z.string().nullable().default(null),
  /** Scenarios it belongs to (ids from the scenarios module), e.g. Christmas. */
  scenarioIds: z.array(Id).default([]),
  /** Only show it in those scenarios, not on the main list (a Halloween recipe in November). */
  scenarioOnly: z.boolean().default(false),
}).meta({ id: 'Recipe' });
export type Recipe = z.infer<typeof Recipe>;

const IngredientInput = z.object({
  name: z.string().min(1).max(120),
  item: z.string().max(200).optional().describe('The Larder item, if different from the name'),
  /** The Larder item's id; null to leave it unlinked. Left out, a re-saved ingredient keeps its link. */
  productId: Id.nullable().optional(),
  quantity: z.number().positive().optional(),
  amount: z.string().max(60).optional(),
  optional: z.boolean().optional(),
  ratio: z.number().positive().max(1_000_000).nullable().optional().describe('How much goes in for the recipe as saved, in ratioUnit (2 eggs, 100 g flour)'),
  ratioUnit: z.string().trim().max(20).optional().describe('g, kg, oz, lb, ml, l, tsp, tbsp, fl oz, pint or a word like "slice"; empty for a count'),
});
const PresetInput = z.object({
  name: z.string().trim().min(1).max(60),
  times: z.number().positive().max(1000).describe('How many times the recipe as saved'),
});
const RecipeInput = z.object({
  title: z.string().trim().min(1).max(120),
  serves: z.number().int().positive().nullable().optional(),
  ingredients: z.array(IngredientInput).max(60).default([]),
  method: z.string().max(20_000).optional(),
  notes: z.string().max(2000).optional(),
  source: z.string().max(60).optional(),
  /** Replaces the presets; left out keeps them. */
  presets: z.array(PresetInput).max(MAX_PRESETS).optional(),
  /** One of the presets' names, or null for the amounts as saved. Left out keeps it. */
  defaultPreset: z.string().trim().max(60).nullable().optional(),
  /** Every scenario it belongs to (replaces the old list). Left out keeps them. */
  scenarioIds: z.array(Id).max(20).optional(),
  scenarioOnly: z.boolean().optional(),
});
type RecipeInput = z.input<typeof RecipeInput>;

/** How much to make. Give one of these; none means the default preset (or the amounts as saved). */
export const ScaleInput = z.object({
  preset: z.string().trim().min(1).max(60).optional().describe('A saved preset, by name, e.g. "family"'),
  servings: z.number().int().positive().max(1000).optional().describe('How many it is for, when the recipe says how many it serves'),
  times: z.number().positive().max(1000).optional().describe('How many times the recipe as saved: 2 doubles it, 0.5 halves it, 1 is the amounts as saved'),
  have: z.array(z.object({
    ingredient: z.string().trim().min(1).max(120).describe('The ingredient, e.g. "eggs"'),
    amount: z.number().positive().max(1_000_000),
    unit: z.string().trim().max(20).optional().describe('e.g. "g", "kg", "ml", "tbsp"; leave out for a count (2 eggs)'),
  })).min(1).max(20).optional().describe('How much they have of some ingredients, e.g. only 2 eggs: the rest is worked out from the ratios so that none needs more than this'),
});
export type ScaleInput = z.infer<typeof ScaleInput>;

const PresetSave = ScaleInput.omit({ preset: true }).extend({
  name: z.string().trim().min(1).max(60).describe('What to call it, e.g. "Family" or "Just me"'),
  default: z.boolean().optional().describe('true to use it whenever no other amount is asked for; false to stop'),
});
type PresetSave = z.infer<typeof PresetSave>;

const Scale = z.object({
  /** saved: the amounts as saved. preset: a preset (the default one when nothing was asked for). */
  kind: z.enum(['saved', 'preset', 'servings', 'times', 'have']),
  /** How many times the recipe as saved. */
  times: z.number(),
  preset: z.string().nullable(),
  servings: z.number().nullable(),
  /** In words: "as saved", 'the "Family" preset', "for 6", "×2", "2 eggs". */
  by: z.string(),
  /** Given several ingredients they have, the one that runs out first. */
  limitedBy: z.string().nullable(),
});
type Scale = z.infer<typeof Scale>;

const IngredientView = z.object({
  name: z.string(),
  productId: z.string().nullable(),
  item: z.string().nullable(),
  amount: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  inStock: z.number().nullable(),
  /** have: enough in stock. short: some, not enough. none: none in. unknown: not linked to a Larder item. */
  status: z.enum(['have', 'short', 'none', 'unknown']),
  optional: z.boolean(),
  ratio: z.number().nullable(),
  ratioUnit: z.string(),
  /** How much at this scale, in words ("200 g", "4"), or as the recipe puts it when it can't be scaled. */
  shown: z.string(),
  /** The amount with the ingredient: "200 g plain flour", "1 egg". */
  label: z.string(),
  /** False when it has no ratio or stock quantity, so `shown` stays as saved whatever the scale. */
  scales: z.boolean(),
  /** What cooking takes from stock at this scale, in what the item is bought in. */
  need: z.number().nullable(),
  /** Why cooking can't take it out of stock, when Larder can't turn the recipe's amount into what it's bought in (ml of an item with no Weight). */
  why: z.string().nullable().default(null),
});
export const RecipeView = Recipe.extend({
  ingredients: z.array(IngredientView),
  /** Required linked ingredients that are short or none, at this scale. */
  missing: z.array(z.string()),
  scale: Scale,
  /** The scenarios it belongs to that still exist. */
  scenarios: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Kept for its scenarios, so it's not on the main list. */
  hidden: z.boolean(),
}).meta({ id: 'RecipeView' });
export type RecipeView = z.infer<typeof RecipeView>;

export const Proposal = z.object({
  id: z.string(),
  recipeId: z.string(),
  recipe: z.string(),
  servings: z.number().nullable(),
  /** How many times the recipe as saved, and the preset or what they had that set it. */
  times: z.number().default(1),
  preset: z.string().nullable().default(null),
  from: z.string().default(''),
  items: z.array(z.object({ productId: z.string(), name: z.string(), quantity: z.number(), unit: z.string(), inStock: z.number() })),
  /** Ingredients that can't be taken from stock (not linked, or no amount). */
  skipped: z.array(z.string()),
  /** Those that have an amount Larder can't turn into what the item is bought in, and why. */
  notTaken: z.array(z.object({ name: z.string(), why: z.string() })).default([]),
  expiresAt: z.string(),
}).meta({ id: 'CookingProposal' });
export type Proposal = z.infer<typeof Proposal>;

const PROPOSAL_HOURS = 6;

/**
 * The scenarios module's scenarios (id → name) while it's on. Recipes keep
 * only the ids, so when a scenario is removed (or the module is switched
 * off) it stops counting, and its scenario-only recipes are back on the main list.
 */
export async function scenarioNames(core: CoreApi): Promise<Map<string, string>> {
  if (!core.modules.isEnabled('scenarios')) return new Map();
  const list = core.modules.routes().find((r) => r.moduleId === 'scenarios' && r.route.method === 'GET' && r.route.path === '/');
  if (!list) return new Map();
  const scenarios = (await list.route.handler({ body: undefined, query: {}, params: {}, userId: null })) as Array<{ id: string; name: string }>;
  return new Map(scenarios.map((s) => [s.id, s.name]));
}


const sameName = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');
/** "grams" → "g", "Slices" → "slice", "each" → "": stored the same way however it was typed. */
const canonicalUnit = (u: string) => (unitKey(u) === 'floz' ? 'fl oz' : unitKey(u));
const roundTimes = (t: number) => Math.max(0.0001, Math.round(t * 10_000) / 10_000);

/** An ingredient with its Larder item and what it can be scaled by. */
interface Base {
  i: Ingredient;
  s: ProductSummary | undefined;
  names: string[];
  /** The ratio, or the stock quantity in the item's unit when there's no ratio. */
  measure: { amount: number; unit: string } | null;
  /** What cooking takes from stock for the recipe as saved, in what the item is bought in. */
  stock: number | null;
  /** Why it can't be taken from stock, when Larder can't work it out. */
  why: string | null;
}

const lastWord = (name: string) => name.trim().split(/[\s-]+/).at(-1) ?? '';

/**
 * What cooking takes from stock for `n` of `unit`, in what the item is bought in, through the core's
 * converter: a kitchen measure as g or ml through the item's Weight (300 ml of milk from bottles
 * of 4 pints), and a count in what it's bought in or what's in its pack (2 eggs from boxes of 6).
 * A plain count is of what the name says ("2 eggs"), never 8 chicken thighs as 8 packs. A measure
 * Larder can't work out (no Weight) isn't taken, and says why.
 */
function stockFor(units: Units, product: Product, names: string[], n: number, unit: string): { quantity: number | null; why: string | null } {
  const measured = inCore(n, unit);
  if (measured) {
    try {
      return { quantity: roundQty(toBoughtIn(units, product, measured.amount, measured.unit)), why: null };
    } catch (err) {
      if (err instanceof LarderError) return { quantity: null, why: err.message };
      throw err;
    }
  }
  const k = unitKey(unit, units);
  const said = k ? [unit] : names.map(lastWord);
  const word = said.find((w) => units.find(w) && canConvert(units, product, w)) ?? (!k && units.find(product.unit)?.key === 'each' ? product.unit : null);
  return { quantity: word ? roundQty(toBoughtIn(units, product, n, word)) : null, why: null };
}

function ingredientCalled(core: CoreApi, r: Recipe, base: Base[], ref: string): Base {
  const what = `ingredient in ${r.title}`;
  try {
    return core.resolve.among(what, ref, base.map((b) => ({ name: b.i.name, b }))).b;
  } catch (err) {
    if (!(err instanceof LarderError) || err.status !== 404) throw err;
    // "milk" when the ingredient is "semi-skimmed" but linked to the milk.
    try {
      return core.resolve.among(what, ref, base.filter((b) => b.s).map((b) => ({ name: b.s!.product.name, b }))).b;
    } catch (again) {
      throw again instanceof LarderError && again.status !== 404 ? again : err;
    }
  }
}

function presetCalled(core: CoreApi, r: Recipe, ref: string): Preset {
  if (!r.presets.length) throw new LarderError(`${r.title} has no presets yet. Save one with save_recipe_preset.`, 404, 'not_found');
  try {
    return core.resolve.among(`${r.title} preset`, ref, r.presets);
  } catch (err) {
    if (err instanceof LarderError && err.status === 404) throw new LarderError(`${r.title} has no preset called "${ref.trim()}". Its presets are ${andList(r.presets.map((p) => `"${p.name}"`))}.`, 404, 'not_found');
    throw err;
  }
}

function unitMismatch(units: Units, r: Recipe, b: Base): string {
  const u = b.measure!.unit;
  const by = measuredBy(u);
  if (by) return `${r.title} measures the ${b.i.name} by ${by}, so give it in ${unitsLike(u)}.`;
  if (!unitKey(u, units)) return `${r.title} counts the ${b.i.name}, so give how many, with no unit.`;
  return `${r.title} measures the ${b.i.name} in ${unitWord(units, unitKey(u, units), 2)}, so give how many of those.`;
}

/** How much to make, from what was asked (or the default preset). */
function scaleFor(core: CoreApi, units: Units, r: Recipe, base: Base[], input: ScaleInput): Scale {
  const asked = (['preset', 'servings', 'times', 'have'] as const).filter((k) => input[k] !== undefined);
  if (asked.length > 1) throw new ValidationError(`Give one of preset, servings, times or have, not ${andList(asked)}.`);
  const plain = { preset: null, servings: null, limitedBy: null };
  if (input.preset !== undefined) {
    const p = presetCalled(core, r, input.preset);
    return { ...plain, kind: 'preset', times: p.times, preset: p.name, by: `the "${p.name}" preset` };
  }
  if (input.servings !== undefined) {
    if (!r.serves) throw new ValidationError(`${r.title} doesn't say how many it serves, so it can't be worked out for ${input.servings}. Give times, or what they have.`);
    return { ...plain, kind: 'servings', times: input.servings / r.serves, servings: input.servings, by: `for ${input.servings}` };
  }
  if (input.times !== undefined) return { ...plain, kind: input.times === 1 ? 'saved' : 'times', times: input.times, by: input.times === 1 ? 'as saved' : timesText(input.times) };
  if (input.have?.length) {
    const scalable = base.filter((b) => b.measure).map((b) => b.i.name);
    let least: { times: number; name: string } | null = null;
    const said: string[] = [];
    for (const h of input.have) {
      const b = ingredientCalled(core, r, base, h.ingredient);
      if (!b.measure) throw new ValidationError(`${r.title} has no ratio for ${b.i.name}, so the rest can't be worked out from it.${scalable.length ? ` It can from ${andList(scalable)}.` : ' Add ratios to its ingredients first (save_recipe).'}`);
      const n = convert(h.amount, h.unit ?? b.measure.unit, b.measure.unit, b.names);
      if (n === null) throw new ValidationError(unitMismatch(units, r, b));
      const unit = h.unit ?? b.measure.unit;
      said.push(withAmount(measureText(h.amount, unit, units), b.i.name, unit, units));
      const t = n / b.measure.amount;
      if (!least || t < least.times) least = { times: t, name: b.i.name };
    }
    return { ...plain, kind: 'have', times: least!.times, by: andList(said), limitedBy: input.have.length > 1 ? least!.name : null };
  }
  const d = r.defaultPreset ? r.presets.find((p) => p.name === r.defaultPreset) : undefined;
  if (d) return { ...plain, kind: 'preset', times: d.times, preset: d.name, by: `the "${d.name}" preset` };
  return { ...plain, kind: 'saved', times: 1, by: 'as saved' };
}

async function view(core: CoreApi, r: Recipe, input: ScaleInput = {}, known?: Map<string, string>): Promise<RecipeView> {
  const names = known ?? (await scenarioNames(core));
  const units = await core.units.list();
  const scenarios = r.scenarioIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! }));
  const summaries = new Map<string, ProductSummary>();
  for (const i of r.ingredients) {
    if (i.productId && !summaries.has(i.productId)) {
      const s = await core.products.summary(i.productId).catch(() => null);
      if (s) summaries.set(i.productId, s);
    }
  }
  const base: Base[] = r.ingredients.map((i) => {
    const s = i.productId ? summaries.get(i.productId) : undefined;
    const names = [i.name, ...(s ? [s.product.name] : [])];
    const measure = i.ratio ? { amount: i.ratio, unit: i.ratioUnit } : s && i.quantity ? { amount: i.quantity, unit: s.product.unit } : null;
    // The quantity given (in what it's bought in), or the ratio through the core's converter.
    const fromRatio = s && i.quantity === null && i.ratio ? stockFor(units, s.product, names, i.ratio, i.ratioUnit) : null;
    const stock = !s ? null : (i.quantity ?? fromRatio?.quantity ?? null);
    return { i, s, names, measure, stock, why: fromRatio?.why ?? null };
  });
  const scale = scaleFor(core, units, r, base, input);
  const t = scale.times;
  const ingredients = base.map(({ i, s, measure, stock, why }) => {
    const need = stock === null ? null : roundQty(stock * t);
    const status = !s ? 'unknown' : s.inStock <= 0 ? 'none' : s.inStock + 1e-9 < (need ?? 0) ? 'short' : 'have';
    const shown = t === 1 ? i.amount || (measure ? measureText(measure.amount, measure.unit, units) : '') : measure ? measureText(measure.amount * t, measure.unit, units) : i.amount;
    return {
      name: i.name, productId: s ? i.productId : null, item: s?.product.name ?? null, amount: i.amount, quantity: i.quantity, unit: s?.product.unit ?? null, inStock: s ? s.inStock : null, status, optional: i.optional,
      ratio: i.ratio, ratioUnit: i.ratioUnit, shown, label: withAmount(shown, i.name, measure?.unit ?? '', units), scales: !!measure, need, why,
    } as const;
  });
  return { ...r, ingredients, missing: ingredients.filter((i) => !i.optional && (i.status === 'none' || i.status === 'short')).map((i) => i.item ?? i.name), scale, scenarios, hidden: r.scenarioOnly && scenarios.length > 0 };
}

function scaleLine(v: RecipeView): string | null {
  const s = v.scale;
  const t = timesText(s.times);
  if (s.kind === 'preset') return `Amounts for the "${s.preset}" preset (${s.preset === v.defaultPreset ? 'the default, ' : ''}${t}).`;
  if (s.kind === 'servings') return `Amounts for ${s.servings} (${t}).`;
  if (s.kind === 'times') return `Amounts at ${t} the recipe as saved.`;
  if (s.kind === 'have') return `Amounts worked out from ${s.by} (${t}).${s.limitedBy ? ` Limited by the ${s.limitedBy}.` : ''}`;
  return v.presets.length ? 'Amounts as saved.' : null;
}

export function recipeText(units: Units, v: RecipeView): string {
  const s = v.scale;
  const lines = [`${v.title}${v.serves ? ` (serves ${v.serves})` : ''}`];
  const line = scaleLine(v);
  if (line) lines.push(line);
  if (v.presets.length) {
    const list = v.presets.map((p) => `${p.name} (${timesText(p.times)}${p.name === v.defaultPreset ? ', the default' : ''})`);
    lines.push(`Presets: ${list.join(', ')}.${!v.defaultPreset && s.kind === 'saved' ? ' None is the default: ask which they\'d like, or use the amounts as saved.' : ''}`);
  }
  lines.push('Ingredients:');
  for (const i of v.ingredients) {
    const state = i.status === 'have' ? 'in the house' : i.status === 'short' ? `only ${amountText(units, i.inStock ?? 0, i.unit ?? 'each')} in` : i.status === 'none' ? 'none in' : 'not tracked in Larder';
    const fixed = !i.scales && s.times !== 1 ? ' (not scaled)' : '';
    lines.push(`- ${i.label}${i.optional ? ' (optional)' : ''}${fixed}: ${state}`);
  }
  lines.push(v.missing.length ? `Missing: ${andList(v.missing)}.` : 'Everything needed is in the house.');
  if (s.kind !== 'preset' && s.kind !== 'saved') lines.push('If they might make these amounts again, offer to save them as a preset (save_recipe_preset).');
  if (v.scenarios.length) lines.push(`${v.hidden ? 'Only shown in' : 'Also in'} ${andList(v.scenarios.map((x) => x.name))}.`);
  if (v.method) lines.push('Method:', v.method);
  if (v.notes) lines.push(`Notes: ${v.notes}`);
  if (v.lastCookedAt) lines.push(`Last cooked ${v.lastCookedAt.slice(0, 10)} (${v.timesCooked} time${v.timesCooked === 1 ? '' : 's'}).`);
  lines.push(`id: ${v.id}`);
  return lines.join('\n');
}

/** "2 eggs, 100 g plain flour and 300 ml milk": the first few amounts at that scale. */
const amountsText = (v: RecipeView) => {
  const shown = v.ingredients.filter((i) => i.scales && i.shown).map((i) => i.label);
  return shown.length > 3 ? `${shown.slice(0, 3).join(', ')}…` : andList(shown);
};

export default defineModule({
  id: 'recipes',
  name: 'Recipes',
  description: 'Saves recipes the household liked (usually from an AI assistant), shows what\'s missing, scales them by ratios and presets, and takes ingredients out of stock after cooking once you confirm.',
  version: '1.1.0',
  setup(ctx) {
    const recipes = ctx.collection<Recipe>('recipes');
    const proposals = ctx.collection<Proposal>('proposals');
    const core = ctx.core;
    // Parsed, so recipes saved before presets or scenarios read as having none.
    const all = async () => (await recipes.list()).map((d) => Recipe.parse(d.data)).sort((a, b) => a.title.localeCompare(b.title));

    // Changes to a saved recipe one at a time, so a preset saved by an
    // assistant and an edit in the app at the same moment don't lose one another.
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    };

    // An item now counted in what's inside (2 boxes became 40 tea bags): what cooking takes of it follows.
    ctx.on('product.recounted', async (event) => {
      const { productId, factor } = event.data as { productId: string; factor: number };
      await serial(async () => {
        for (const r of await all()) {
          if (!r.ingredients.some((i) => i.productId === productId && i.quantity !== null)) continue;
          const ingredients = r.ingredients.map((i) => (i.productId === productId && i.quantity !== null ? { ...i, quantity: roundQty(i.quantity * factor) } : i));
          await recipes.put(r.id, Recipe.parse({ ...r, ingredients }));
        }
      });
    });

    async function get(id: string): Promise<Recipe> {
      const r = await recipes.get(id);
      if (!r) throw new NotFoundError('Recipe', id);
      // Saved before presets and ratios existed: fill in their defaults.
      return Recipe.parse(r);
    }

    /** By id, or by title with the same strict rules as items (so "egg" doesn't find "Veggie chilli"). */
    async function find(ref: string): Promise<Recipe> {
      const byId = await recipes.get(ref.trim());
      if (byId) return Recipe.parse(byId);
      return Recipe.parse(core.resolve.among('saved recipe', ref, (await all()).map((r) => ({ name: r.title, recipe: r }))).recipe);
    }

    /**
     * Link each ingredient to a Larder item: the one given, the link it already
     * had (re-saving keeps links), or its name (or `item`) when that clearly is
     * one. Unclear ones stay unlinked.
     */
    async function ingredientsFrom(input: RecipeInput['ingredients'], existing: Ingredient[] = []): Promise<Ingredient[]> {
      const out: Ingredient[] = [];
      const known = async (id: string | null | undefined) => (id ? ((await core.products.summary(id).catch(() => null))?.product.id ?? null) : null);
      for (const i of input ?? []) {
        let productId: string | null = null;
        if (i.productId !== undefined) productId = await known(i.productId);
        else if (i.item) productId = (await core.resolve.product(i.item).catch(() => null))?.id ?? null;
        else {
          const before = existing.find((e) => e.productId && sameName(e.name, i.name));
          productId = (await known(before?.productId)) ?? (await core.resolve.product(i.name).catch(() => null))?.id ?? null;
        }
        const ratio = i.ratio ?? null;
        out.push(Ingredient.parse({ name: i.name, productId, quantity: i.quantity ?? null, amount: i.amount ?? '', optional: i.optional ?? false, ratio, ratioUnit: ratio ? canonicalUnit(i.ratioUnit ?? '') : '' }));
      }
      return out;
    }

    function presetsFrom(list: z.input<typeof PresetInput>[]): Preset[] {
      const out: Preset[] = [];
      for (const p of list) {
        const name = p.name.trim();
        if (out.some((x) => sameName(x.name, name))) throw new ValidationError(`Two presets are called "${name}". Give each its own name.`);
        out.push({ name, times: roundTimes(p.times) });
      }
      return out;
    }

    async function save(input: RecipeInput, existing?: Recipe): Promise<Recipe> {
      const data = RecipeInput.parse(input);
      const now = core.now();
      const presets = data.presets !== undefined ? presetsFrom(data.presets) : (existing?.presets ?? []);
      const wanted = data.defaultPreset !== undefined ? data.defaultPreset || null : (existing?.defaultPreset ?? null);
      const defaultPreset = wanted === null ? null : (presets.find((p) => sameName(p.name, wanted))?.name ?? null);
      if (wanted !== null && !defaultPreset && data.defaultPreset !== undefined) {
        throw new ValidationError(`The default preset must be one of the recipe's presets${presets.length ? ` (${andList(presets.map((p) => `"${p.name}"`))})` : ', and it has none'}.`);
      }
      const scenarioIds = data.scenarioIds ?? existing?.scenarioIds ?? [];
      if (data.scenarioIds?.length) {
        const known = await scenarioNames(core);
        if (!core.modules.isEnabled('scenarios')) throw new ValidationError('Scenarios are switched off, so a recipe can\'t go in one.');
        if (data.scenarioIds.some((id) => !known.has(id))) throw new ValidationError('One of those scenarios no longer exists. Pick from the current scenarios.');
      }
      const scenarioOnly = data.scenarioOnly ?? existing?.scenarioOnly ?? false;
      if (scenarioOnly && !scenarioIds.length) throw new ValidationError('Pick the scenarios it shows in, or keep it on the main list.');
      const r = Recipe.parse({
        ...(existing ?? { id: newId(), createdAt: now, lastCookedAt: null, timesCooked: 0 }),
        // Left out keeps what it was; null clears it.
        title: data.title, serves: data.serves !== undefined ? data.serves : (existing?.serves ?? null), ingredients: await ingredientsFrom(data.ingredients, existing?.ingredients),
        method: data.method ?? existing?.method ?? '', notes: data.notes ?? existing?.notes ?? '', source: data.source ?? existing?.source ?? '', updatedAt: now,
        presets, defaultPreset, scenarioIds, scenarioOnly,
      });
      await recipes.put(r.id, r);
      ctx.publish('recipes.changed', { id: r.id });
      return r;
    }

    async function savePreset(id: string, input: PresetSave): Promise<{ recipe: Recipe; preset: Preset }> {
      return serial(async () => {
        const r = await get(id);
        const old = r.presets.find((p) => sameName(p.name, input.name));
        // "family" saves over "Family" and keeps its name.
        const name = old?.name ?? input.name.trim();
        const asked = input.times !== undefined || input.servings !== undefined || input.have !== undefined;
        if (!asked && !old) throw new ValidationError(`Say how much the "${name}" preset makes: times, servings, or what they have.`);
        const times = asked ? (await view(core, r, { times: input.times, servings: input.servings, have: input.have })).scale.times : old!.times;
        const preset = { name, times: roundTimes(times) };
        const presets = old ? r.presets.map((p) => (p === old ? preset : p)) : [...r.presets, preset];
        if (presets.length > MAX_PRESETS) throw new ValidationError(`${r.title} has ${MAX_PRESETS} presets already. Forget one first.`);
        let defaultPreset = r.defaultPreset;
        if (input.default === true) defaultPreset = name;
        else if (input.default === false && defaultPreset === name) defaultPreset = null;
        const saved = Recipe.parse({ ...r, presets, defaultPreset, updatedAt: core.now() });
        await recipes.put(saved.id, saved);
        ctx.publish('recipes.changed', { id: saved.id });
        return { recipe: saved, preset };
      });
    }

    async function forgetPreset(id: string, ref: string): Promise<{ recipe: Recipe; preset: Preset; wasDefault: boolean }> {
      return serial(async () => {
        const r = await get(id);
        const preset = presetCalled(core, r, ref);
        const wasDefault = r.defaultPreset === preset.name;
        const saved = Recipe.parse({ ...r, presets: r.presets.filter((p) => p !== preset), defaultPreset: wasDefault ? null : r.defaultPreset, updatedAt: core.now() });
        await recipes.put(saved.id, saved);
        ctx.publish('recipes.changed', { id: saved.id });
        return { recipe: saved, preset, wasDefault };
      });
    }

    async function propose(r: Recipe, scale: ScaleInput = {}): Promise<Proposal> {
      const v = await view(core, r, scale);
      const items: Proposal['items'] = [];
      const skipped: string[] = [];
      const notTaken: Proposal['notTaken'] = [];
      // One line per item: "butter 200 g" and "butter for greasing" add up.
      const wanted = new Map<string, { name: string; want: number; unit: string; inStock: number; names: string[] }>();
      for (const i of v.ingredients) {
        if (!i.productId || !i.need) {
          if (!i.optional) skipped.push(i.name);
          if (!i.optional && i.why) notTaken.push({ name: i.name, why: i.why });
          continue;
        }
        const w = wanted.get(i.productId);
        if (w) {
          w.want += i.need;
          w.names.push(i.name);
        } else wanted.set(i.productId, { name: i.item ?? i.name, want: i.need, unit: i.unit ?? 'each', inStock: i.inStock ?? 0, names: [i.name] });
      }
      for (const [productId, w] of wanted) {
        // Propose no more than there is; the person can change it before confirming.
        const qty = Math.min(roundQty(w.want), w.inStock);
        if (qty > 0) items.push({ productId, name: w.name, quantity: qty, unit: w.unit, inStock: w.inStock });
        else skipped.push(...w.names);
      }
      const s = v.scale;
      const p = Proposal.parse({
        id: newId(), recipeId: r.id, recipe: r.title, servings: s.servings, times: s.times, preset: s.preset, from: s.kind === 'have' ? s.by : '',
        items, skipped, notTaken, expiresAt: new Date(Date.parse(core.now()) + PROPOSAL_HOURS * 3_600_000).toISOString(),
      });
      // Forget old proposals as new ones are made.
      for (const old of await proposals.list()) if (Date.parse(old.data.expiresAt) < Date.parse(core.now())) await proposals.remove(old.id);
      await proposals.put(p.id, p);
      return p;
    }

    // Proposals being confirmed right now, so a double tap or a retry can't use stock twice.
    const confirming = new Set<string>();

    async function confirm(proposalId: string, changes?: Array<{ productId?: string; item?: string; quantity: number }>) {
      if (confirming.has(proposalId)) throw new LarderError('That proposal is already being confirmed.', 409, 'conflict');
      confirming.add(proposalId);
      try {
        const p = await proposals.get(proposalId);
        if (!p || Date.parse(p.expiresAt) < Date.parse(core.now())) throw new LarderError('That proposal has expired or was already used. Propose cooking it again.', 404, 'not_found');
        const quantities = new Map(p.items.map((i) => [i.productId, i.quantity]));
        for (const c of changes ?? []) {
          const product = c.productId ? null : c.item ? await core.resolve.product(c.item) : null;
          const id = c.productId ?? product?.id;
          if (!id) throw new ValidationError('Each change needs the item and its quantity.');
          // Changes adjust what was proposed; anything else used goes through use_stock.
          if (!quantities.has(id)) throw new ValidationError(`${product?.name ?? 'That item'} isn't in this proposal. Take it out of stock on its own (use_stock).`);
          quantities.set(id, c.quantity);
        }
        const uses = [...quantities].filter(([, q]) => q > 0).map(([productId, quantity]) => ({ productId, quantity, note: `Cooked ${p.recipe}` }));
        // A proposal works once: forget it before touching stock, and bring it back if that fails.
        await proposals.remove(p.id);
        let result: Awaited<ReturnType<typeof core.stock.useMany>>;
        try {
          result = uses.length ? await core.stock.useMany(uses) : [];
        } catch (err) {
          await proposals.put(p.id, p);
          throw err;
        }
        await serial(async () => {
          const r = await recipes.get(p.recipeId);
          if (!r) return;
          await recipes.put(r.id, { ...r, lastCookedAt: core.now(), timesCooked: r.timesCooked + 1 });
          ctx.publish('recipes.changed', { id: r.id });
        });
        return { used: uses.length, products: result };
      } finally {
        confirming.delete(proposalId);
      }
    }

    const proposalText = (units: Units, p: Proposal) => {
      const t = timesText(p.times);
      const how = p.preset ? ` (the "${p.preset}" preset, ${t})` : p.servings ? ` for ${p.servings}` : p.from ? ` from ${p.from} (${t})` : p.times !== 1 ? ` (${t})` : '';
      return [
        `Cooking ${p.recipe}${how} would take out of stock:`,
        ...(p.items.length ? p.items.map((i) => `- ${i.name}: ${amountText(units, i.quantity, i.unit)} (of ${amountText(units, i.inStock, i.unit)})`) : ['- nothing (no ingredient has an amount in Larder\'s units)']),
        ...(p.skipped.length ? [`Not taken: ${p.skipped.join(', ')}.`] : []),
        ...p.notTaken.map((x) => `- ${x.name}: ${x.why}`),
        `Proposal id: ${p.id}. Nothing has changed yet: ask the person to confirm or adjust, then call confirm_cooking.`,
      ].join('\n');
    };

    const scaleBody = ScaleInput.optional();
    const scaleOf = (body: unknown) => (body ?? {}) as ScaleInput;

    async function forget(r: Recipe): Promise<void> {
      await recipes.remove(r.id);
      ctx.publish('recipes.changed', { id: r.id });
    }

    /** The ingredients the house has none or too little of at that scale (not optional ones), put on the shopping list. */
    async function missingToList(r: Recipe, scale: ScaleInput = {}): Promise<string[]> {
      const v = await view(core, r, scale);
      const missing = v.ingredients.filter((i) => !i.optional && i.productId && (i.status === 'none' || i.status === 'short'));
      for (const i of missing) await core.products.setOnList(i.productId!, true);
      return missing.map((i) => i.item ?? i.name);
    }

    // A phone's offline copy: both lists, every recipe, and the lists on item and scenario pages that have any.
    ctx.addOfflinePaths(async () => {
      const list = await all();
      const products = new Set(list.flatMap((r) => r.ingredients.flatMap((i) => (i.productId ? [i.productId] : []))));
      const scenarios = new Set(list.flatMap((r) => r.scenarioIds));
      return [
        '/', '/?show=scenario-only', ...list.map((r) => `/${r.id}`),
        ...[...products].map((id) => `/?productId=${id}`), ...[...scenarios].map((id) => `/?scenarioId=${id}`),
      ];
    });

    ctx.addRoute({
      method: 'GET', path: '/', summary: 'Saved recipes, with what\'s missing for each (at its default preset)',
      description: 'Without a filter, the main list: recipes kept for their scenarios are left out (ask for them with `show`).',
      query: z.object({
        productId: Id.optional().describe('Only recipes that use this item (scenario-only ones too)'),
        scenarioId: Id.optional().describe('Only recipes in this scenario'),
        show: z.enum(['main', 'scenario-only', 'all']).optional().describe('Which recipes: the main list (default without a filter), those kept for scenarios, or all'),
      }),
      response: z.array(RecipeView),
      async handler({ query }) {
        const q = query as { productId?: string; scenarioId?: string; show?: 'main' | 'scenario-only' | 'all' };
        const known = await scenarioNames(core);
        const show = q.show ?? (q.productId || q.scenarioId ? 'all' : 'main');
        const views = await Promise.all((await all())
          .filter((r) => (!q.productId || r.ingredients.some((i) => i.productId === q.productId)) && (!q.scenarioId || r.scenarioIds.includes(q.scenarioId)))
          .map((r) => view(core, r, {}, known)));
        return views.filter((v) => show === 'all' || (show === 'main' ? !v.hidden : v.hidden));
      },
    });
    ctx.addRoute({
      method: 'POST', path: '/', summary: 'Save a recipe', description: 'Ingredients are linked to Larder items when their name (or `item`) clearly is one.',
      body: RecipeInput, response: RecipeView,
      handler: async ({ body }) => view(core, await save(body as RecipeInput)),
    });
    ctx.addRoute({
      method: 'GET', path: '/:id', summary: 'A recipe, with what\'s in the house, at its default preset', params: z.object({ id: Id }), response: RecipeView,
      handler: async ({ params }) => view(core, await get((params as { id: string }).id)),
    });
    ctx.addRoute({
      method: 'PUT', path: '/:id', summary: 'Replace a recipe', description: 'Presets and the default preset are kept unless given.', params: z.object({ id: Id }), body: RecipeInput, response: RecipeView,
      handler: async ({ params, body }) => view(core, await serial(async () => save(body as RecipeInput, await get((params as { id: string }).id)))),
    });
    ctx.addRoute({
      method: 'DELETE', path: '/:id', summary: 'Forget a recipe', params: z.object({ id: Id }), response: z.object({ ok: z.literal(true) }),
      async handler({ params }) {
        await forget(await get((params as { id: string }).id));
        return { ok: true as const };
      },
    });
    ctx.addRoute({
      method: 'POST', path: '/:id/scale', summary: 'A recipe worked out for another amount',
      description: 'Give one of: a preset, servings, times (2 doubles it), or `have` (how much there is of some ingredients; the rest follows from the ratios, so none needs more). None gives the default preset.',
      params: z.object({ id: Id }), body: scaleBody, response: RecipeView,
      handler: async ({ params, body }) => view(core, await get((params as { id: string }).id), scaleOf(body)),
    });
    ctx.addRoute({
      method: 'POST', path: '/:id/presets', summary: 'Save amounts as a preset, or change which is the default',
      description: 'How much is given as for /scale (times, servings or have). Saving an existing name replaces it; with no amount, only `default` changes.',
      params: z.object({ id: Id }), body: PresetSave, response: RecipeView,
      handler: async ({ params, body }) => view(core, (await savePreset((params as { id: string }).id, body as PresetSave)).recipe),
    });
    ctx.addRoute({
      method: 'DELETE', path: '/:id/presets/:name', summary: 'Forget a preset', description: 'If it was the default, the amounts as saved are used again.',
      params: z.object({ id: Id, name: z.string().min(1).max(60) }), response: RecipeView,
      handler: async ({ params }) => {
        const { id, name } = params as { id: string; name: string };
        return view(core, (await forgetPreset(id, name)).recipe);
      },
    });
    ctx.addRoute({
      method: 'POST', path: '/:id/missing-to-list', summary: 'Put the missing ingredients on the shopping list', description: 'At the default preset, or the amount given (as for /scale).',
      params: z.object({ id: Id }), body: scaleBody,
      response: z.object({ added: z.array(z.string()) }),
      handler: async ({ params, body }) => ({ added: await missingToList(await get((params as { id: string }).id), scaleOf(body)) }),
    });
    ctx.addRoute({
      method: 'POST', path: '/:id/cook', summary: 'Propose what cooking this takes out of stock (changes nothing yet)',
      description: 'At the default preset, or the amount given (as for /scale).',
      params: z.object({ id: Id }), body: scaleBody, response: Proposal,
      handler: async ({ params, body }) => propose(await get((params as { id: string }).id), scaleOf(body)),
    });
    ctx.addRoute({
      method: 'POST', path: '/proposals/:proposalId/confirm', summary: 'Confirm a cooking proposal, with quantities changed if wanted',
      description: 'All the uses happen together, or none do. A quantity of 0 leaves that item alone.',
      params: z.object({ proposalId: z.string() }), body: z.object({ items: z.array(z.object({ productId: Id, quantity: z.number().min(0) })).optional() }).optional(),
      response: z.object({ used: z.number() }),
      async handler({ params, body }) {
        const r = await confirm((params as { proposalId: string }).proposalId, (body as { items?: Array<{ productId: string; quantity: number }> } | undefined)?.items);
        return { used: r.used };
      },
    });

    ctx.addSearchSection({
      id: 'recipes', title: 'Saved recipes', order: 70,
      documents: async () => (await all()).map((r) => ({ id: `recipes:${r.id}`, type: 'recipes', refId: r.id, title: r.title, keywords: [...r.ingredients.map((i) => i.name), r.notes, r.source].filter(Boolean) })),
      async results(_q, hits) {
        const list = await all();
        const out = [];
        for (const h of hits) {
          const r = list.find((x) => x.id === h.refId);
          if (!r) continue;
          const v = await view(core, Recipe.parse(r));
          out.push({ type: 'recipe', id: r.id, title: r.title, subtitle: v.missing.length ? `Missing ${andList(v.missing)}` : 'You have everything', href: `/m/recipes/${r.id}` });
        }
        return out;
      },
    });

    /** Scenario names, as people say them, to ids (the same strict matching as items). */
    async function scenarioIdsFor(names: string[]): Promise<string[]> {
      if (!names.length) return [];
      if (!core.modules.isEnabled('scenarios')) throw new ValidationError('Scenarios are switched off, so a recipe can\'t go in one.');
      const list = [...(await scenarioNames(core))].map(([id, name]) => ({ id, name }));
      return names.map((n) => {
        try {
          return core.resolve.among('scenario', n, list).id;
        } catch (err) {
          if (err instanceof LarderError && err.code === 'not_found') {
            throw new LarderError(`There's no scenario called "${n}".${list.length ? ` The scenarios are ${andList(list.map((x) => x.name))}.` : ''} Ask if they want it made with make_scenario.`, 404, 'not_found');
          }
          throw err;
        }
      });
    }
    const ScenarioNames = z.array(z.string().min(1).max(60)).max(20).describe('Scenarios it belongs to, by name, e.g. ["Christmas"]');
    const ScenarioOnly = z.boolean().describe('True to show it only in those scenarios, not on the main recipe list (for seasonal recipes)');
    const ToolIngredient = z.object({
      name: z.string().min(1).max(120).describe('The ingredient, e.g. "chopped tomatoes"'),
      item: z.string().max(200).optional().describe('The Larder item, if its name is different'),
      quantity: z.number().positive().optional().describe('How much, in the Larder item\'s own unit (e.g. 1 tin, 0.2 kg)'),
      amount: z.string().max(60).optional().describe('How the recipe puts it, e.g. "400 g" or "a handful"'),
      optional: z.boolean().optional(),
      ratio: z.number().positive().max(1_000_000).optional().describe('How much goes in for the recipe as saved, in ratio_unit: 2 (eggs), 100 (g flour). Give the main ingredients one so the recipe can be scaled to what they have'),
      ratio_unit: z.string().max(20).optional().describe('The ratio\'s measure: g, kg, oz, lb, ml, l, tsp, tbsp, fl oz, pint, or a word like "slice"; leave out for a count (2 eggs)'),
    });
    type ToolIngredient = z.infer<typeof ToolIngredient>;
    const asInput = (e: Ingredient) => ({ name: e.name, productId: e.productId, quantity: e.quantity ?? undefined, amount: e.amount, optional: e.optional, ratio: e.ratio, ratioUnit: e.ratioUnit });
    /** Changing a saved recipe: what an ingredient leaves out stays as it was. */
    const merged = (i: ToolIngredient, before: Ingredient[]) => {
      const e = before.find((x) => sameName(x.name, i.name));
      return {
        name: i.name, ...(i.item !== undefined ? { item: i.item } : {}),
        quantity: i.quantity ?? e?.quantity ?? undefined, amount: i.amount ?? e?.amount, optional: i.optional ?? e?.optional,
        ratio: i.ratio ?? e?.ratio ?? null, ratioUnit: i.ratio !== undefined ? (i.ratio_unit ?? '') : (i.ratio_unit ?? e?.ratioUnit ?? ''),
      };
    };

    ctx.addTool({
      name: 'save_recipe', title: 'Save a recipe',
      description: 'Save a recipe the person liked, so it can be found and cooked again, or change a saved one (give its title as recipe). For each ingredient give its name, and if you can, the Larder item and the quantity in that item\'s unit (get_item shows the unit), e.g. { name: "chopped tomatoes", quantity: 1, amount: "400 g tin" }. Give the main ingredients a ratio too (eggs: ratio 2; flour: ratio 100, ratio_unit "g"), so it can be scaled to what they have.',
      input: z.object({
        recipe: z.string().min(1).max(120).optional().describe('To change a saved recipe (for example to add ratios), its title; leave out to save a new one'),
        title: z.string().min(1).max(120).optional().describe('Needed for a new recipe'),
        serves: z.number().int().positive().optional(),
        ingredients: z.array(ToolIngredient).max(60).optional().describe('Needed for a new recipe. When changing one, send every ingredient (any left out are dropped); what you leave out of an ingredient stays as it was'),
        method: z.string().max(20_000).optional().describe('The steps, as plain text. Needed for a new recipe'),
        notes: z.string().max(2000).optional(),
        scenarios: ScenarioNames.optional(),
        scenario_only: ScenarioOnly.optional(),
      }),
      async run({ scenarios, scenario_only, ...input }) {
        const scenarioIds = scenarios ? await scenarioIdsFor(scenarios) : undefined;
        const r = await serial(async () => {
          if (input.recipe) {
            const e = await find(input.recipe);
            const ingredients = input.ingredients ? input.ingredients.map((i) => merged(i, e.ingredients)) : e.ingredients.map(asInput);
            return save({ title: input.title ?? e.title, serves: input.serves, ingredients, method: input.method, notes: input.notes, scenarioIds, scenarioOnly: scenario_only }, await get(e.id));
          }
          if (!input.title) throw new ValidationError('Give the new recipe a title. To change a saved one, give its title as recipe.');
          if (!input.method) throw new ValidationError('Give the method (the steps) for a new recipe.');
          return save({ title: input.title, serves: input.serves, ingredients: (input.ingredients ?? []).map((i) => merged(i, [])), method: input.method, notes: input.notes, source: 'AI assistant', scenarioIds, scenarioOnly: scenario_only });
        });
        const v = await view(core, r, { times: 1 });
        const unlinked = v.ingredients.filter((i) => i.status === 'unknown').map((i) => i.name);
        const ratios = v.ingredients.filter((i) => i.ratio);
        const noRatio = v.ingredients.filter((i) => !i.ratio && !i.optional).map((i) => i.name);
        const scaling = ratios.length && noRatio.length ? ` No ratio for ${andList(noRatio)}, so ${noRatio.length === 1 ? 'it stays' : 'those stay'} as saved when it's scaled.` : '';
        return {
          text: `${input.recipe ? 'Changed' : 'Saved'} "${r.title}".${unlinked.length ? ` Not matched to Larder items: ${andList(unlinked)}.` : ''} ${v.missing.length ? `Missing now: ${andList(v.missing)}.` : 'Everything needed is in the house.'}${scaling}`,
          data: { id: r.id },
        };
      },
    });
    ctx.addTool({
      name: 'list_recipes', title: 'List saved recipes', readOnly: true,
      description: 'The household\'s saved recipes and what each is missing. Use it to suggest something they liked before. Recipes kept for a scenario (e.g. Christmas) say so: only suggest those for that occasion.',
      input: z.object({
        query: z.string().max(100).optional().describe('Only recipes whose title or ingredients mention this'),
        scenario: z.string().max(60).optional().describe('Only recipes in this scenario, e.g. "Christmas"'),
      }),
      async run({ query, scenario }) {
        const known = await scenarioNames(core);
        const only = scenario ? (await scenarioIdsFor([scenario]))[0]! : null;
        const views = await Promise.all((await all()).filter((r) => !only || r.scenarioIds.includes(only)).map((r) => view(core, r, {}, known)));
        const q = query?.trim().toLowerCase();
        const shown = q ? views.filter((v) => v.title.toLowerCase().includes(q) || v.ingredients.some((i) => i.name.toLowerCase().includes(q) || i.item?.toLowerCase().includes(q))) : views;
        if (!shown.length) return { text: q ? `No saved recipes mention "${query}".` : 'There are no saved recipes yet.', data: { recipes: [] } };
        const where = (v: RecipeView) => (v.scenarios.length ? ` (${v.hidden ? 'only for' : 'also in'} ${andList(v.scenarios.map((x) => x.name))})` : '');
        return {
          text: shown.map((v) => `- ${v.title}${where(v)}: ${v.missing.length ? `missing ${andList(v.missing)}` : 'everything in'}${v.presets.length ? ` (presets: ${v.presets.map((p) => p.name).join(', ')})` : ''}`).join('\n'),
          data: { recipes: shown.map((v) => ({ id: v.id, title: v.title, missing: v.missing, presets: v.presets.map((p) => p.name), defaultPreset: v.defaultPreset, scenarios: v.scenarios.map((x) => x.name), scenario_only: v.hidden })) },
        };
      },
    });
    ctx.addTool({
      name: 'get_recipe', title: 'Get a saved recipe', readOnly: true,
      description: 'A saved recipe: ingredients with what\'s in the house and what\'s missing, and the method. Amounts follow its default preset. For another amount give a preset, what they have of some ingredients (e.g. only 2 eggs: the rest is worked out from the ratios), servings or times. Give only one.',
      input: z.object({ recipe: z.string().min(1).max(120).describe('Its title, e.g. "traybake"'), ...ScaleInput.shape }),
      async run({ recipe, ...scale }) {
        const v = await view(core, await find(recipe), scale);
        return { text: recipeText(await core.units.list(), v), data: v as unknown as Record<string, unknown> };
      },
    });
    ctx.addTool({
      name: 'set_recipe_scenarios', title: 'Put a recipe in scenarios', destructive: true,
      description: 'Say which scenarios a saved recipe belongs to (e.g. a mince pie recipe in "Christmas"), and whether it shows only there. The list given replaces the old one; [] takes it out of every scenario.',
      input: z.object({ recipe: z.string().min(1).max(120).describe('Its title'), scenarios: ScenarioNames, only: ScenarioOnly.optional() }),
      async run({ recipe, scenarios, only }) {
        const { id } = await find(recipe);
        const scenarioIds = await scenarioIdsFor(scenarios);
        // Only the scenarios change; the rest of the recipe stays as it is.
        const next = await serial(async () => {
          const r = await get(id);
          const saved = Recipe.parse({ ...r, scenarioIds, scenarioOnly: scenarioIds.length ? (only ?? r.scenarioOnly) : false, updatedAt: core.now() });
          await recipes.put(saved.id, saved);
          ctx.publish('recipes.changed', { id: saved.id });
          return saved;
        });
        const v = await view(core, next);
        const names = andList(v.scenarios.map((x) => x.name));
        return { text: v.scenarios.length ? `${v.title} is in ${names}${v.hidden ? ', and only shows there' : ' and on the main list'}.` : `${v.title} isn't in any scenario.`, data: { id: v.id, scenarios: v.scenarios.map((x) => x.name), scenario_only: v.hidden } };
      },
    });
    ctx.addTool({
      name: 'recipe_to_shopping_list', title: 'Shop for a recipe',
      description: 'Put the ingredients a saved recipe needs that the house has none or too little of on the shopping list. At its default preset, or another amount as for get_recipe (a preset, servings, times or what they have).',
      input: z.object({ recipe: z.string().min(1).max(120).describe('Its title, e.g. "traybake"'), ...ScaleInput.shape }),
      async run({ recipe, ...scale }) {
        const r = await find(recipe);
        const added = await missingToList(r, scale);
        return { text: added.length ? `On the shopping list for ${r.title}: ${andList(added)}.` : `Everything ${r.title} needs is in the house.`, data: { id: r.id, added } };
      },
    });
    ctx.addTool({
      name: 'forget_recipe', title: 'Forget a saved recipe', destructive: true,
      description: 'Remove a saved recipe. Nothing in stock changes.',
      input: z.object({ recipe: z.string().min(1).max(120).describe('Its title') }),
      async run({ recipe }) {
        const r = await find(recipe);
        await forget(r);
        return { text: `Forgot ${r.title}.`, data: { id: r.id } };
      },
    });
    ctx.addTool({
      name: 'save_recipe_preset', title: 'Save a recipe\'s amounts as a preset',
      description: 'Keep amounts the person makes often under a name ("Family", "Just me") so get_recipe can use them again. Offer it after working out amounts they might want again. Say how much as for get_recipe (what they have, servings or times); default: true makes it the one used when no amount is asked for. With only a name and default, it changes which preset is the default.',
      input: z.object({ recipe: z.string().min(1).max(120).describe('The recipe\'s title'), ...PresetSave.shape }),
      async run({ recipe, ...input }) {
        const { recipe: r, preset } = await savePreset((await find(recipe)).id, input);
        const v = await view(core, r, { preset: preset.name });
        const amounts = amountsText(v);
        const isDefault = r.defaultPreset === preset.name;
        return {
          text: `Saved the "${preset.name}" preset for ${r.title}: ${timesText(preset.times)} the recipe as saved${amounts ? ` (${amounts})` : ''}. ${isDefault ? `It's the default, so ${r.title} uses it unless another amount is asked for.` : `To use it, call get_recipe with preset "${preset.name}".`}`,
          data: { id: r.id, preset, defaultPreset: r.defaultPreset },
        };
      },
    });
    ctx.addTool({
      name: 'forget_recipe_preset', title: 'Forget a recipe preset', destructive: true,
      description: 'Remove a saved preset from a recipe, when the person asks.',
      input: z.object({ recipe: z.string().min(1).max(120).describe('The recipe\'s title'), preset: z.string().min(1).max(60).describe('The preset\'s name') }),
      async run({ recipe, preset }) {
        const r = await forgetPreset((await find(recipe)).id, preset);
        return {
          text: `Forgot the "${r.preset.name}" preset for ${r.recipe.title}.${r.wasDefault ? ' It was the default, so the amounts as saved are used now.' : ''}`,
          data: { id: r.recipe.id, presets: r.recipe.presets.map((p) => p.name), defaultPreset: r.recipe.defaultPreset },
        };
      },
    });
    ctx.addTool({
      name: 'propose_cooking', title: 'Propose taking ingredients out of stock', readOnly: true,
      description: 'After the person has cooked a saved recipe: work out what to take out of stock. Changes nothing. Uses the default preset unless they made another amount (a preset, what they had, servings or times). Show the list, ask them to confirm or adjust, then call confirm_cooking.',
      input: z.object({
        recipe: z.string().min(1).max(120),
        ...ScaleInput.shape,
        servings: ScaleInput.shape.servings.describe('If they made more or fewer than the recipe serves'),
      }),
      async run({ recipe, ...scale }) {
        const p = await propose(await find(recipe), scale);
        return { text: proposalText(await core.units.list(), p), data: p as unknown as Record<string, unknown> };
      },
    });
    ctx.addTool({
      name: 'confirm_cooking', title: 'Confirm taking ingredients out of stock',
      description: 'Apply a proposal from propose_cooking once the person agrees. Pass changes for anything they used a different amount of (quantity 0 to leave an item alone).',
      input: z.object({
        proposal: z.string().min(1).describe('The proposal id from propose_cooking'),
        changes: z.array(z.object({ item: z.string().min(1).max(200), quantity: z.number().min(0) })).optional(),
      }),
      async run({ proposal, changes }) {
        const r = await confirm(proposal, changes);
        const units = await core.units.list();
        const lines = r.products.map((s) => `${s.product.name}: ${amountText(units, s.inStock, s.product.unit)} left${s.status.low ? ' (running low)' : ''}`);
        return { text: r.used ? `Done. ${lines.join('; ')}.` : 'Nothing was taken out of stock.', data: { used: r.used } };
      },
    });
  },

  async demo(ctx, seed) {
    const routes = ctx.core.modules.routes().filter((r) => r.moduleId === 'recipes');
    const post = routes.find((r) => r.route.method === 'POST' && r.route.path === '/')!.route;
    const id = (name: string) => seed.products[name];
    await post.handler({ body: {
      title: 'Chicken and spinach traybake', serves: 4, source: 'Claude',
      ingredients: [
        { name: 'chicken thighs', productId: id('Chicken thighs'), quantity: 1000, amount: '8' },
        { name: 'baby spinach', productId: id('Baby spinach'), quantity: 1, amount: '1 bag' },
        { name: 'chopped tomatoes', amount: '400 g tin' },
        { name: 'mature cheddar', productId: id('Mature cheddar'), quantity: 50, amount: '50 g', optional: true },
      ],
      method: '1. Heat the oven to 200°C.\n2. Brown the chicken thighs, skin down, in a roasting tin.\n3. Add the tomatoes and roast for 30 minutes.\n4. Stir in the spinach for the last 5 minutes. Grate cheddar over if you like.',
    }, query: {}, params: {}, userId: null });
    await post.handler({ body: {
      title: 'Cheesy beans on toast', serves: 2, source: 'Claude',
      ingredients: [
        { name: 'baked beans', productId: id('Baked beans'), quantity: 1, amount: '1 tin' },
        { name: 'mature cheddar', productId: id('Mature cheddar'), quantity: 60, amount: '60 g' },
        { name: 'bread', amount: '4 slices' },
      ],
      method: 'Warm the beans, toast the bread, pile on and grate the cheddar over. Grill for a minute if you like it melted.',
    }, query: {}, params: {}, userId: null });
    await post.handler({ body: {
      title: 'Pancakes', serves: 2, source: 'Claude',
      ingredients: [
        { name: 'plain flour', ratio: 100, ratioUnit: 'g' },
        { name: 'eggs', productId: id('Free-range eggs'), ratio: 2 },
        // No quantity: 300 ml of a 4 pint bottle is worked out by the core's converter.
        { name: 'milk', productId: id('Semi-skimmed milk'), ratio: 300, ratioUnit: 'ml' },
        { name: 'butter, for frying', amount: 'a little' },
      ],
      presets: [{ name: 'Just me', times: 0.5 }, { name: 'Family', times: 2 }],
      method: '1. Whisk the flour, eggs and milk into a smooth batter. Rest it for 30 minutes if you can.\n2. Heat a little butter in a frying pan until it sizzles.\n3. Pour in a thin layer of batter, cook for a minute, flip and cook for another minute.',
      notes: 'Lemon and sugar, or golden syrup.',
    }, query: {}, params: {}, userId: null });
  },
});
