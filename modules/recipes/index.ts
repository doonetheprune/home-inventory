/**
 * Recipes: the ones the household liked, saved (usually by an AI assistant)
 * so they can be found again and checked against what's in the house.
 *
 * Larder doesn't invent recipes; assistants do, from what's in stock and
 * what needs using soon. After cooking, Larder proposes what to take out of
 * stock and only does it once the person confirms (with quantities changed
 * if they like).
 *
 * A recipe can belong to scenarios (Christmas, Halloween), by their ids from
 * the scenarios module, and can be kept for those scenarios only, so a
 * seasonal recipe doesn't crowd the main list.
 */
import { z } from 'zod';
import { amount, andList, defineModule, Id, LarderError, newId, NotFoundError, ValidationError, type CoreApi, type ProductSummary } from '@larder/core';

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
});
export type Ingredient = z.infer<typeof Ingredient>;

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
});
const RecipeInput = z.object({
  title: z.string().trim().min(1).max(120),
  serves: z.number().int().positive().nullable().optional(),
  ingredients: z.array(IngredientInput).max(60).default([]),
  method: z.string().max(20_000).optional(),
  notes: z.string().max(2000).optional(),
  source: z.string().max(60).optional(),
  /** Every scenario it belongs to (replaces the old list). Left out keeps them. */
  scenarioIds: z.array(Id).max(20).optional(),
  scenarioOnly: z.boolean().optional(),
});
type RecipeInput = z.input<typeof RecipeInput>;

const Have = z.object({
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
});
export const RecipeView = Recipe.extend({
  ingredients: z.array(Have),
  /** Required linked ingredients that are short or none. */
  missing: z.array(z.string()),
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
  items: z.array(z.object({ productId: z.string(), name: z.string(), quantity: z.number(), unit: z.string(), inStock: z.number() })),
  /** Ingredients that can't be taken from stock (not linked, or no amount). */
  skipped: z.array(z.string()),
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

async function view(core: CoreApi, r: Recipe, known?: Map<string, string>): Promise<RecipeView> {
  const names = known ?? (await scenarioNames(core));
  const scenarios = r.scenarioIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! }));
  const summaries = new Map<string, ProductSummary>();
  for (const i of r.ingredients) {
    if (i.productId && !summaries.has(i.productId)) {
      const s = await core.products.summary(i.productId).catch(() => null);
      if (s) summaries.set(i.productId, s);
    }
  }
  const ingredients = r.ingredients.map((i) => {
    const s = i.productId ? summaries.get(i.productId) : undefined;
    const need = i.quantity ?? 0;
    const status = !s ? 'unknown' : s.inStock <= 0 ? 'none' : s.inStock + 1e-9 < need ? 'short' : 'have';
    return { name: i.name, productId: s ? i.productId : null, item: s?.product.name ?? null, amount: i.amount, quantity: i.quantity, unit: s?.product.unit ?? null, inStock: s ? s.inStock : null, status, optional: i.optional } as const;
  });
  return { ...r, ingredients, missing: ingredients.filter((i) => !i.optional && (i.status === 'none' || i.status === 'short')).map((i) => i.item ?? i.name), scenarios, hidden: r.scenarioOnly && scenarios.length > 0 };
}

export function recipeText(v: RecipeView): string {
  const lines = [`${v.title}${v.serves ? ` (serves ${v.serves})` : ''}`];
  lines.push('Ingredients:');
  for (const i of v.ingredients) {
    const how = i.amount || (i.quantity && i.unit ? amount(i.quantity, i.unit) : '');
    const state = i.status === 'have' ? 'in the house' : i.status === 'short' ? `only ${amount(i.inStock ?? 0, i.unit ?? 'each')} in` : i.status === 'none' ? 'none in' : 'not tracked in Larder';
    lines.push(`- ${how ? `${how} ` : ''}${i.name}${i.optional ? ' (optional)' : ''}: ${state}`);
  }
  lines.push(v.missing.length ? `Missing: ${andList(v.missing)}.` : 'Everything needed is in the house.');
  if (v.scenarios.length) lines.push(`${v.hidden ? 'Only shown in' : 'Also in'} ${andList(v.scenarios.map((x) => x.name))}.`);
  if (v.method) lines.push('Method:', v.method);
  if (v.notes) lines.push(`Notes: ${v.notes}`);
  if (v.lastCookedAt) lines.push(`Last cooked ${v.lastCookedAt.slice(0, 10)} (${v.timesCooked} time${v.timesCooked === 1 ? '' : 's'}).`);
  lines.push(`id: ${v.id}`);
  return lines.join('\n');
}

export default defineModule({
  id: 'recipes',
  name: 'Recipes',
  description: 'Saves recipes the household liked (usually from an AI assistant), shows what\'s missing, and takes ingredients out of stock after cooking once you confirm.',
  version: '1.0.0',
  setup(ctx) {
    const recipes = ctx.collection<Recipe>('recipes');
    const proposals = ctx.collection<Proposal>('proposals');
    const core = ctx.core;
    const all = async () => (await recipes.list()).map((d) => d.data).sort((a, b) => a.title.localeCompare(b.title));

    async function get(id: string): Promise<Recipe> {
      const r = await recipes.get(id);
      if (!r) throw new NotFoundError('Recipe', id);
      return r;
    }

    /** By id, or by title with the same strict rules as items (so "egg" doesn't find "Veggie chilli"). */
    async function find(ref: string): Promise<Recipe> {
      const byId = await recipes.get(ref.trim());
      if (byId) return byId;
      return core.resolve.among('saved recipe', ref, (await all()).map((r) => ({ name: r.title, recipe: r }))).recipe;
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
          const before = existing.find((e) => e.productId && e.name.trim().toLowerCase() === i.name.trim().toLowerCase());
          productId = (await known(before?.productId)) ?? (await core.resolve.product(i.name).catch(() => null))?.id ?? null;
        }
        out.push(Ingredient.parse({ name: i.name, productId, quantity: i.quantity ?? null, amount: i.amount ?? '', optional: i.optional ?? false }));
      }
      return out;
    }

    async function save(input: RecipeInput, existing?: Recipe): Promise<Recipe> {
      const data = RecipeInput.parse(input);
      const now = core.now();
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
        scenarioIds, scenarioOnly,
      });
      await recipes.put(r.id, r);
      ctx.publish('recipes.changed', { id: r.id });
      return r;
    }

    async function propose(r: Recipe, servings?: number | null): Promise<Proposal> {
      const scale = servings && r.serves ? servings / r.serves : 1;
      const v = await view(core, r);
      const items: Proposal['items'] = [];
      const skipped: string[] = [];
      // One line per item: "butter 200 g" and "butter for greasing" add up.
      const wanted = new Map<string, { name: string; want: number; unit: string; inStock: number; names: string[] }>();
      for (const i of v.ingredients) {
        if (!i.productId || !i.quantity) {
          if (!i.optional) skipped.push(i.name);
          continue;
        }
        const w = wanted.get(i.productId);
        if (w) {
          w.want += i.quantity * scale;
          w.names.push(i.name);
        } else wanted.set(i.productId, { name: i.item ?? i.name, want: i.quantity * scale, unit: i.unit ?? 'each', inStock: i.inStock ?? 0, names: [i.name] });
      }
      for (const [productId, w] of wanted) {
        // Propose no more than there is; the person can change it before confirming.
        const qty = Math.min(Math.round(w.want * 1000) / 1000, w.inStock);
        if (qty > 0) items.push({ productId, name: w.name, quantity: qty, unit: w.unit, inStock: w.inStock });
        else skipped.push(...w.names);
      }
      const p = Proposal.parse({ id: newId(), recipeId: r.id, recipe: r.title, servings: servings ?? null, items, skipped, expiresAt: new Date(Date.parse(core.now()) + PROPOSAL_HOURS * 3_600_000).toISOString() });
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
        const r = await recipes.get(p.recipeId);
        if (r) {
          await recipes.put(r.id, { ...r, lastCookedAt: core.now(), timesCooked: r.timesCooked + 1 });
          ctx.publish('recipes.changed', { id: r.id });
        }
        return { used: uses.length, products: result };
      } finally {
        confirming.delete(proposalId);
      }
    }

    const proposalText = (p: Proposal) => [
      `Cooking ${p.recipe}${p.servings ? ` for ${p.servings}` : ''} would take out of stock:`,
      ...(p.items.length ? p.items.map((i) => `- ${i.name}: ${amount(i.quantity, i.unit)} (of ${amount(i.inStock, i.unit)})`) : ['- nothing (no ingredient has an amount in Larder\'s units)']),
      ...(p.skipped.length ? [`Not taken: ${p.skipped.join(', ')}.`] : []),
      `Proposal id: ${p.id}. Nothing has changed yet: ask the person to confirm or adjust, then call confirm_cooking.`,
    ].join('\n');

    async function forget(r: Recipe): Promise<void> {
      await recipes.remove(r.id);
      ctx.publish('recipes.changed', { id: r.id });
    }

    /** The ingredients the house has none or too little of (not optional ones), put on the shopping list. */
    async function missingToList(r: Recipe): Promise<string[]> {
      const v = await view(core, r);
      const missing = v.ingredients.filter((i) => !i.optional && i.productId && (i.status === 'none' || i.status === 'short'));
      for (const i of missing) await core.products.setOnList(i.productId!, true);
      return missing.map((i) => i.item ?? i.name);
    }

    ctx.addRoute({
      method: 'GET', path: '/', summary: 'Saved recipes, with what\'s missing for each',
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
          .map((r) => view(core, r, known)));
        return views.filter((v) => show === 'all' || (show === 'main' ? !v.hidden : v.hidden));
      },
    });
    ctx.addRoute({
      method: 'POST', path: '/', summary: 'Save a recipe', description: 'Ingredients are linked to Larder items when their name (or `item`) clearly is one.',
      body: RecipeInput, response: RecipeView,
      handler: async ({ body }) => view(core, await save(body as RecipeInput)),
    });
    ctx.addRoute({
      method: 'GET', path: '/:id', summary: 'A recipe, with what\'s in the house', params: z.object({ id: Id }), response: RecipeView,
      handler: async ({ params }) => view(core, await get((params as { id: string }).id)),
    });
    ctx.addRoute({
      method: 'PUT', path: '/:id', summary: 'Replace a recipe', params: z.object({ id: Id }), body: RecipeInput, response: RecipeView,
      handler: async ({ params, body }) => view(core, await save(body as RecipeInput, await get((params as { id: string }).id))),
    });
    ctx.addRoute({
      method: 'DELETE', path: '/:id', summary: 'Forget a recipe', params: z.object({ id: Id }), response: z.object({ ok: z.literal(true) }),
      async handler({ params }) {
        await forget(await get((params as { id: string }).id));
        return { ok: true as const };
      },
    });
    ctx.addRoute({
      method: 'POST', path: '/:id/missing-to-list', summary: 'Put the missing ingredients on the shopping list', params: z.object({ id: Id }),
      response: z.object({ added: z.array(z.string()) }),
      handler: async ({ params }) => ({ added: await missingToList(await get((params as { id: string }).id)) }),
    });
    ctx.addRoute({
      method: 'POST', path: '/:id/cook', summary: 'Propose what cooking this takes out of stock (changes nothing yet)',
      params: z.object({ id: Id }), body: z.object({ servings: z.number().int().positive().optional() }).optional(), response: Proposal,
      handler: async ({ params, body }) => propose(await get((params as { id: string }).id), (body as { servings?: number } | undefined)?.servings),
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
          const v = await view(core, r);
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

    ctx.addTool({
      name: 'save_recipe', title: 'Save a recipe',
      description: 'Save a recipe the person liked, so it can be found and cooked again. For each ingredient give its name, and if you can, the Larder item and the quantity in that item\'s unit (get_item shows the unit), e.g. { name: "chopped tomatoes", quantity: 1, amount: "400 g tin" }.',
      input: z.object({
        title: z.string().min(1).max(120),
        serves: z.number().int().positive().optional(),
        ingredients: z.array(z.object({
          name: z.string().min(1).max(120).describe('The ingredient, e.g. "chopped tomatoes"'),
          item: z.string().max(200).optional().describe('The Larder item, if its name is different'),
          quantity: z.number().positive().optional().describe('How much, in the Larder item\'s own unit (e.g. 1 tin, 0.2 kg)'),
          amount: z.string().max(60).optional().describe('How the recipe puts it, e.g. "400 g" or "a handful"'),
          optional: z.boolean().optional(),
        })).max(60),
        method: z.string().max(20_000).describe('The steps, as plain text'),
        notes: z.string().max(2000).optional(),
        scenarios: ScenarioNames.optional(),
        scenario_only: ScenarioOnly.optional(),
      }),
      async run({ scenarios, scenario_only, ...input }) {
        const r = await save({ ...input, source: 'AI assistant', scenarioIds: await scenarioIdsFor(scenarios ?? []), scenarioOnly: scenario_only });
        const v = await view(core, r);
        const unlinked = v.ingredients.filter((i) => i.status === 'unknown').map((i) => i.name);
        return { text: `Saved "${r.title}".${unlinked.length ? ` Not matched to Larder items: ${andList(unlinked)}.` : ''} ${v.missing.length ? `Missing now: ${andList(v.missing)}.` : 'Everything needed is in the house.'}`, data: { id: r.id } };
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
        const views = await Promise.all((await all()).filter((r) => !only || r.scenarioIds.includes(only)).map((r) => view(core, r, known)));
        const q = query?.trim().toLowerCase();
        const shown = q ? views.filter((v) => v.title.toLowerCase().includes(q) || v.ingredients.some((i) => i.name.toLowerCase().includes(q) || i.item?.toLowerCase().includes(q))) : views;
        if (!shown.length) return { text: q ? `No saved recipes mention "${query}".` : 'There are no saved recipes yet.', data: { recipes: [] } };
        const where = (v: RecipeView) => (v.scenarios.length ? ` (${v.hidden ? 'only for' : 'also in'} ${andList(v.scenarios.map((x) => x.name))})` : '');
        return {
          text: shown.map((v) => `- ${v.title}${where(v)}: ${v.missing.length ? `missing ${andList(v.missing)}` : 'everything in'}`).join('\n'),
          data: { recipes: shown.map((v) => ({ id: v.id, title: v.title, missing: v.missing, scenarios: v.scenarios.map((x) => x.name), scenario_only: v.hidden })) },
        };
      },
    });
    ctx.addTool({
      name: 'get_recipe', title: 'Get a saved recipe', readOnly: true,
      description: 'A saved recipe: ingredients with what\'s in the house and what\'s missing, and the method.',
      input: z.object({ recipe: z.string().min(1).max(120).describe('Its title, e.g. "traybake"') }),
      async run({ recipe }) {
        const v = await view(core, await find(recipe));
        return { text: recipeText(v), data: v as unknown as Record<string, unknown> };
      },
    });
    ctx.addTool({
      name: 'set_recipe_scenarios', title: 'Put a recipe in scenarios', destructive: true,
      description: 'Say which scenarios a saved recipe belongs to (e.g. a mince pie recipe in "Christmas"), and whether it shows only there. The list given replaces the old one; [] takes it out of every scenario.',
      input: z.object({ recipe: z.string().min(1).max(120).describe('Its title'), scenarios: ScenarioNames, only: ScenarioOnly.optional() }),
      async run({ recipe, scenarios, only }) {
        const r = await find(recipe);
        const scenarioIds = await scenarioIdsFor(scenarios);
        // Only the scenarios change; the rest of the recipe stays as it is.
        const next = Recipe.parse({ ...r, scenarioIds, scenarioOnly: scenarioIds.length ? (only ?? r.scenarioOnly) : false, updatedAt: core.now() });
        await recipes.put(next.id, next);
        ctx.publish('recipes.changed', { id: next.id });
        const v = await view(core, next);
        const names = andList(v.scenarios.map((x) => x.name));
        return { text: v.scenarios.length ? `${v.title} is in ${names}${v.hidden ? ', and only shows there' : ' and on the main list'}.` : `${v.title} isn't in any scenario.`, data: { id: v.id, scenarios: v.scenarios.map((x) => x.name), scenario_only: v.hidden } };
      },
    });
    ctx.addTool({
      name: 'recipe_to_shopping_list', title: 'Shop for a recipe',
      description: 'Put the ingredients a saved recipe needs that the house has none or too little of on the shopping list.',
      input: z.object({ recipe: z.string().min(1).max(120).describe('Its title, e.g. "traybake"') }),
      async run({ recipe }) {
        const r = await find(recipe);
        const added = await missingToList(r);
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
      name: 'propose_cooking', title: 'Propose taking ingredients out of stock',
      description: 'After the person has cooked a saved recipe: work out what to take out of stock. Changes nothing. Show the list, ask them to confirm or adjust, then call confirm_cooking.',
      input: z.object({ recipe: z.string().min(1).max(120), servings: z.number().int().positive().optional().describe('If they made more or fewer than the recipe serves') }),
      async run({ recipe, servings }) {
        const p = await propose(await find(recipe), servings);
        return { text: proposalText(p), data: p as unknown as Record<string, unknown> };
      },
    });
    ctx.addTool({
      name: 'confirm_cooking', title: 'Confirm taking ingredients out of stock', destructive: true,
      description: 'Apply a proposal from propose_cooking once the person agrees. Pass changes for anything they used a different amount of (quantity 0 to leave an item alone).',
      input: z.object({
        proposal: z.string().min(1).describe('The proposal id from propose_cooking'),
        changes: z.array(z.object({ item: z.string().min(1).max(200), quantity: z.number().min(0) })).optional(),
      }),
      async run({ proposal, changes }) {
        const r = await confirm(proposal, changes);
        const lines = r.products.map((s) => `${s.product.name}: ${amount(s.inStock, s.product.unit)} left${s.status.low ? ' (running low)' : ''}`);
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
        { name: 'chicken thighs', productId: id('Chicken thighs'), quantity: 1, amount: '8' },
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
  },
});
