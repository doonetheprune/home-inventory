/**
 * Recipes: the ones the household liked, saved (usually by an AI assistant)
 * so they can be found again and checked against what's in the house.
 *
 * Larder doesn't invent recipes; assistants do, from what's in stock and
 * what needs using soon. After cooking, Larder proposes what to take out of
 * stock and only does it once the person confirms (with quantities changed
 * if they like).
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
}).meta({ id: 'Recipe' });
export type Recipe = z.infer<typeof Recipe>;

const IngredientInput = z.object({
  name: z.string().min(1).max(120),
  item: z.string().max(200).optional().describe('The Larder item, if different from the name'),
  productId: Id.optional(),
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

async function view(core: CoreApi, r: Recipe): Promise<RecipeView> {
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
  return { ...r, ingredients, missing: ingredients.filter((i) => !i.optional && (i.status === 'none' || i.status === 'short')).map((i) => i.item ?? i.name) };
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

    /** By id or title (exact, or containing every word given). */
    async function find(ref: string): Promise<Recipe> {
      const byId = await recipes.get(ref.trim());
      if (byId) return byId;
      const list = await all();
      const q = ref.trim().toLowerCase();
      const exact = list.filter((r) => r.title.toLowerCase() === q);
      if (exact.length === 1) return exact[0]!;
      const words = q.split(/\s+/).filter(Boolean);
      const covering = list.filter((r) => words.length && words.every((w) => r.title.toLowerCase().includes(w)));
      if (covering.length === 1) return covering[0]!;
      if (covering.length > 1) throw new LarderError(`"${ref}" could be ${covering.map((r) => `"${r.title}"`).join(' or ')}.`, 409, 'ambiguous');
      throw new LarderError(`There's no saved recipe called "${ref}".`, 404, 'not_found');
    }

    /** Link each ingredient to a Larder item when its name (or `item`) clearly is one. Unclear ones stay unlinked. */
    async function ingredientsFrom(input: RecipeInput['ingredients']): Promise<Ingredient[]> {
      const out: Ingredient[] = [];
      for (const i of input ?? []) {
        let productId: string | null = null;
        if (i.productId) productId = (await core.products.summary(i.productId).catch(() => null))?.product.id ?? null;
        else productId = (await core.resolve.product(i.item ?? i.name).catch(() => null))?.id ?? null;
        out.push(Ingredient.parse({ name: i.name, productId, quantity: i.quantity ?? null, amount: i.amount ?? '', optional: i.optional ?? false }));
      }
      return out;
    }

    async function save(input: RecipeInput, existing?: Recipe): Promise<Recipe> {
      const data = RecipeInput.parse(input);
      const now = core.now();
      const r = Recipe.parse({
        ...(existing ?? { id: newId(), createdAt: now, lastCookedAt: null, timesCooked: 0 }),
        title: data.title, serves: data.serves ?? existing?.serves ?? null, ingredients: await ingredientsFrom(data.ingredients),
        method: data.method ?? existing?.method ?? '', notes: data.notes ?? existing?.notes ?? '', source: data.source ?? existing?.source ?? '', updatedAt: now,
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
      for (const i of v.ingredients) {
        if (!i.productId || !i.quantity) {
          if (!i.optional) skipped.push(i.name);
          continue;
        }
        const want = Math.round(i.quantity * scale * 1000) / 1000;
        // Propose no more than there is; the person can change it before confirming.
        const qty = Math.min(want, i.inStock ?? 0);
        if (qty > 0) items.push({ productId: i.productId, name: i.item ?? i.name, quantity: qty, unit: i.unit ?? 'each', inStock: i.inStock ?? 0 });
        else skipped.push(i.name);
      }
      const p = Proposal.parse({ id: newId(), recipeId: r.id, recipe: r.title, servings: servings ?? null, items, skipped, expiresAt: new Date(Date.parse(core.now()) + PROPOSAL_HOURS * 3_600_000).toISOString() });
      // Forget old proposals as new ones are made.
      for (const old of await proposals.list()) if (Date.parse(old.data.expiresAt) < Date.parse(core.now())) await proposals.remove(old.id);
      await proposals.put(p.id, p);
      return p;
    }

    async function confirm(proposalId: string, changes?: Array<{ productId?: string; item?: string; quantity: number }>) {
      const p = await proposals.get(proposalId);
      if (!p || Date.parse(p.expiresAt) < Date.parse(core.now())) throw new LarderError('That proposal has expired or was already used. Propose cooking it again.', 404, 'not_found');
      const quantities = new Map(p.items.map((i) => [i.productId, i.quantity]));
      for (const c of changes ?? []) {
        const id = c.productId ?? (c.item ? (await core.resolve.product(c.item)).id : null);
        if (!id) throw new ValidationError('Each change needs the item and its quantity.');
        quantities.set(id, c.quantity);
      }
      const uses = [...quantities].filter(([, q]) => q > 0).map(([productId, quantity]) => ({ productId, quantity, note: `Cooked ${p.recipe}` }));
      const result = uses.length ? await core.stock.useMany(uses) : [];
      await proposals.remove(p.id);
      const r = await recipes.get(p.recipeId);
      if (r) {
        await recipes.put(r.id, { ...r, lastCookedAt: core.now(), timesCooked: r.timesCooked + 1 });
        ctx.publish('recipes.changed', { id: r.id });
      }
      return { used: uses.length, products: result };
    }

    const proposalText = (p: Proposal) => [
      `Cooking ${p.recipe}${p.servings ? ` for ${p.servings}` : ''} would take out of stock:`,
      ...(p.items.length ? p.items.map((i) => `- ${i.name}: ${amount(i.quantity, i.unit)} (of ${amount(i.inStock, i.unit)})`) : ['- nothing (no ingredient has an amount in Larder\'s units)']),
      ...(p.skipped.length ? [`Not taken: ${p.skipped.join(', ')}.`] : []),
      `Proposal id: ${p.id}. Nothing has changed yet: ask the person to confirm or adjust, then call confirm_cooking.`,
    ].join('\n');

    ctx.addRoute({
      method: 'GET', path: '/', summary: 'Saved recipes, with what\'s missing for each', response: z.array(RecipeView),
      handler: async () => Promise.all((await all()).map((r) => view(core, r))),
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
        const r = await get((params as { id: string }).id);
        await recipes.remove(r.id);
        ctx.publish('recipes.changed', { id: r.id });
        return { ok: true as const };
      },
    });
    ctx.addRoute({
      method: 'POST', path: '/:id/missing-to-list', summary: 'Put the missing ingredients on the shopping list', params: z.object({ id: Id }),
      response: z.object({ added: z.array(z.string()) }),
      async handler({ params }) {
        const v = await view(core, await get((params as { id: string }).id));
        const missing = v.ingredients.filter((i) => !i.optional && i.productId && (i.status === 'none' || i.status === 'short'));
        for (const i of missing) await core.products.setOnList(i.productId!, true);
        return { added: missing.map((i) => i.item ?? i.name) };
      },
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
      }),
      async run(input) {
        const r = await save({ ...input, source: 'AI assistant' });
        const v = await view(core, r);
        const unlinked = v.ingredients.filter((i) => i.status === 'unknown').map((i) => i.name);
        return { text: `Saved "${r.title}".${unlinked.length ? ` Not matched to Larder items: ${andList(unlinked)}.` : ''} ${v.missing.length ? `Missing now: ${andList(v.missing)}.` : 'Everything needed is in the house.'}`, data: { id: r.id } };
      },
    });
    ctx.addTool({
      name: 'list_recipes', title: 'List saved recipes', readOnly: true,
      description: 'The household\'s saved recipes and what each is missing. Use it to suggest something they liked before.',
      input: z.object({ query: z.string().max(100).optional().describe('Only recipes whose title or ingredients mention this') }),
      async run({ query }) {
        const views = await Promise.all((await all()).map((r) => view(core, r)));
        const q = query?.trim().toLowerCase();
        const shown = q ? views.filter((v) => v.title.toLowerCase().includes(q) || v.ingredients.some((i) => i.name.toLowerCase().includes(q) || i.item?.toLowerCase().includes(q))) : views;
        if (!shown.length) return { text: q ? `No saved recipes mention "${query}".` : 'There are no saved recipes yet.', data: { recipes: [] } };
        return { text: shown.map((v) => `- ${v.title}: ${v.missing.length ? `missing ${andList(v.missing)}` : 'everything in'}`).join('\n'), data: { recipes: shown.map((v) => ({ id: v.id, title: v.title, missing: v.missing })) } };
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
      name: 'propose_cooking', title: 'Propose taking ingredients out of stock',
      description: 'After the person has cooked a saved recipe: work out what to take out of stock. Changes nothing. Show the list, ask them to confirm or adjust, then call confirm_cooking.',
      input: z.object({ recipe: z.string().min(1).max(120), servings: z.number().int().positive().optional().describe('If they made more or fewer than the recipe serves') }),
      async run({ recipe, servings }) {
        const p = await propose(await find(recipe), servings);
        return { text: proposalText(p), data: p as unknown as Record<string, unknown> };
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
