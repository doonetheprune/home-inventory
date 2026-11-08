import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../../src/adapters/storage-memory';
import { makeCore } from '../../tests/helpers';
import scenarios from '../scenarios';
import recipes, { type Proposal, type RecipeView } from './index';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = (core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'recipes' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params, userId: null });

async function kitchen() {
  const core = await makeCore({ modules: [recipes] });
  const chicken = await core.products.create({ name: 'Chicken thighs', unit: 'pack' });
  const spinach = await core.products.create({ name: 'Baby spinach', unit: 'bag' });
  const cheddar = await core.products.create({ name: 'Mature cheddar', unit: 'g', minQuantity: 200 });
  await core.stock.add({ productId: chicken.id, quantity: 2 });
  await core.stock.add({ productId: cheddar.id, quantity: 300 });
  const r = (await call(core, 'POST', '/', {
    title: 'Chicken and spinach traybake', serves: 4,
    ingredients: [
      { name: 'chicken thighs', quantity: 1, amount: '8 thighs' },
      { name: 'baby spinach', quantity: 1 },
      { name: 'chopped tomatoes', amount: '400 g' },
      { name: 'cheese', item: 'mature cheddar', quantity: 50, optional: true },
    ],
    method: 'Roast it all.',
  })) as RecipeView;
  return { core, r, ids: { chicken: chicken.id, spinach: spinach.id, cheddar: cheddar.id } };
}

describe('recipes module', () => {
  it('links ingredients to items and says what is missing', async () => {
    const { r } = await kitchen();
    expect(r.ingredients.map((i) => [i.name, i.item, i.status])).toEqual([
      ['chicken thighs', 'Chicken thighs', 'have'],
      ['baby spinach', 'Baby spinach', 'none'],
      ['chopped tomatoes', null, 'unknown'],
      ['cheese', 'Mature cheddar', 'have'],
    ]);
    expect(r.missing).toEqual(['Baby spinach']);
  });

  it('proposes what to take out of stock, and only takes it when confirmed (with changes)', async () => {
    const { core, r, ids } = await kitchen();
    await core.stock.add({ productId: ids.spinach, quantity: 1 });
    const p = (await call(core, 'POST', '/:id/cook', { servings: 8 }, { id: r.id })) as Proposal;
    // Doubled for 8, but never more than there is.
    expect(p.items.map((i) => [i.name, i.quantity])).toEqual([['Chicken thighs', 2], ['Baby spinach', 1], ['Mature cheddar', 100]]);
    expect(p.skipped).toEqual(['chopped tomatoes']);
    expect((await core.products.summary(ids.chicken)).inStock).toBe(2);

    await call(core, 'POST', '/proposals/:proposalId/confirm', { items: [{ productId: ids.cheddar, quantity: 0 }] }, { proposalId: p.id });
    expect((await core.products.summary(ids.chicken)).inStock).toBe(0);
    expect((await core.products.summary(ids.cheddar)).inStock).toBe(300);
    const after = (await call(core, 'GET', '/:id', undefined, { id: r.id })) as RecipeView;
    expect(after.timesCooked).toBe(1);
    // A proposal is used once.
    await expect(call(core, 'POST', '/proposals/:proposalId/confirm', {}, { proposalId: p.id })).rejects.toMatchObject({ status: 404 });
  });

  it('confirming takes everything or nothing', async () => {
    const { core, r, ids } = await kitchen();
    await core.stock.add({ productId: ids.spinach, quantity: 1 });
    const p = (await call(core, 'POST', '/:id/cook', {}, { id: r.id })) as Proposal;
    // Someone used the spinach in the meantime.
    await core.stock.use({ productId: ids.spinach, quantity: 1 });
    await expect(call(core, 'POST', '/proposals/:proposalId/confirm', {}, { proposalId: p.id })).rejects.toThrow('Baby spinach');
    expect((await core.products.summary(ids.chicken)).inStock).toBe(2);
    // The proposal is still there to try again.
    await core.stock.add({ productId: ids.spinach, quantity: 1 });
    await call(core, 'POST', '/proposals/:proposalId/confirm', {}, { proposalId: p.id });
    expect((await core.products.summary(ids.chicken)).inStock).toBe(1);
  });

  it('adds up two lines for the same item, and only adjusts what was proposed', async () => {
    const { core } = await kitchen();
    const butter = await core.products.create({ name: 'Butter', unit: 'g' });
    await core.stock.add({ productId: butter.id, quantity: 500 });
    const r = (await call(core, 'POST', '/', { title: 'Shortbread', ingredients: [{ name: 'butter', quantity: 200 }, { name: 'butter for greasing', item: 'butter', quantity: 50 }] })) as RecipeView;
    const p = (await call(core, 'POST', '/:id/cook', {}, { id: r.id })) as Proposal;
    expect(p.items.map((i) => [i.name, i.quantity])).toEqual([['Butter', 250]]);
    await expect(core.assistant.call('confirm_cooking', { proposal: p.id, changes: [{ item: 'chicken thighs', quantity: 1 }] })).rejects.toThrow("Chicken thighs isn't in this proposal");
    await call(core, 'POST', '/proposals/:proposalId/confirm', {}, { proposalId: p.id });
    expect((await core.products.summary(butter.id)).inStock).toBe(250);
  });

  it('takes stock once when a proposal is confirmed twice at the same moment', async () => {
    const { core, r, ids } = await kitchen();
    const p = (await call(core, 'POST', '/:id/cook', {}, { id: r.id })) as Proposal;
    const confirm = () => call(core, 'POST', '/proposals/:proposalId/confirm', {}, { proposalId: p.id });
    const results = await Promise.allSettled([confirm(), confirm()]);
    expect(results.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await core.products.summary(ids.chicken)).inStock).toBe(1);
  });

  it('keeps ingredient links when a recipe is saved again, and can clear "serves"', async () => {
    const { core } = await kitchen();
    await core.products.create({ name: 'Tinned tomatoes', unit: 'tin' });
    const saved = await core.assistant.call('save_recipe', { title: 'Chilli', serves: 4, method: 'Simmer.', ingredients: [{ name: 'chopped tomatoes', item: 'Tinned tomatoes', quantity: 1 }] });
    const id = saved.data!.id as string;
    // The web editor sends the ingredient back by name, with only the method changed.
    let v = (await call(core, 'PUT', '/:id', { title: 'Chilli', method: 'Simmer for an hour.', ingredients: [{ name: 'chopped tomatoes', quantity: 1 }] }, { id })) as RecipeView;
    expect(v.ingredients[0]!.item).toBe('Tinned tomatoes');
    expect(v.serves).toBe(4);
    v = (await call(core, 'PUT', '/:id', { title: 'Chilli', serves: null, ingredients: [{ name: 'chopped tomatoes', productId: null }] }, { id })) as RecipeView;
    expect(v.ingredients[0]!.item).toBeNull();
    expect(v.serves).toBeNull();
  });

  it('finds recipes by whole words of the title, never part of a word', async () => {
    const { core } = await kitchen();
    await core.assistant.call('save_recipe', { title: 'Veggie chilli', method: 'Simmer.', ingredients: [] });
    expect((await core.assistant.call('get_recipe', { recipe: 'chilli' })).text).toContain('Veggie chilli');
    await expect(core.assistant.call('get_recipe', { recipe: 'egg' })).rejects.toMatchObject({ status: 404 });
    await expect(core.assistant.call('get_recipe', { recipe: 'chil' })).rejects.toThrow('Did you mean "Veggie chilli"?');
  });

  it('works for AI assistants end to end, and puts missing things on the list', async () => {
    const { core, ids } = await kitchen();
    const saved = await core.assistant.call('save_recipe', {
      title: 'Cheese on toast', serves: 1, method: 'Grill it.',
      ingredients: [{ name: 'mature cheddar', quantity: 60, amount: '60 g' }, { name: 'bread', amount: '2 slices' }],
    });
    expect(saved.text).toBe('Saved "Cheese on toast". Not matched to Larder items: bread. Everything needed is in the house.');
    expect((await core.assistant.call('list_recipes', { query: 'cheddar' })).text).toContain('- Cheese on toast: everything in');
    expect((await core.assistant.call('get_recipe', { recipe: 'toast' })).text).toContain('- 60 g mature cheddar: in the house');
    const proposed = await core.assistant.call('propose_cooking', { recipe: 'cheese on toast' });
    expect(proposed.text).toContain('- Mature cheddar: 60 g (of 300 g)');
    const id = /Proposal id: (\S+)\./.exec(proposed.text)![1]!;
    const done = await core.assistant.call('confirm_cooking', { proposal: id, changes: [{ item: 'mature cheddar', quantity: 120 }] });
    expect(done.text).toBe('Done. Mature cheddar: 180 g left (running low).');

    const list = (await call(core, 'GET', '/')) as RecipeView[];
    const traybake = list.find((x) => x.title.startsWith('Chicken'))!;
    expect(await call(core, 'POST', '/:id/missing-to-list', undefined, { id: traybake.id })).toEqual({ added: ['Baby spinach'] });
    expect((await core.products.summary(ids.spinach)).product.onShoppingList).toBe(true);
    expect((await core.search.query('traybake')).find((s) => s.id === 'recipes')?.results[0]?.subtitle).toBe('Missing Baby spinach');
  });

  it('lets assistants shop for a recipe and forget one', async () => {
    const { core, ids } = await kitchen();
    expect((await core.assistant.call('recipe_to_shopping_list', { recipe: 'traybake' })).text).toBe('On the shopping list for Chicken and spinach traybake: Baby spinach.');
    expect((await core.products.summary(ids.spinach)).product.onShoppingList).toBe(true);
    await core.stock.add({ productId: ids.spinach, quantity: 1 });
    expect((await core.assistant.call('recipe_to_shopping_list', { recipe: 'traybake' })).text).toBe('Everything Chicken and spinach traybake needs is in the house.');
    expect((await core.assistant.call('forget_recipe', { recipe: 'traybake' })).text).toBe('Forgot Chicken and spinach traybake.');
    expect((await core.assistant.call('list_recipes', {})).text).toBe('There are no saved recipes yet.');
  });

  describe('with scenarios', () => {
    async function seasons() {
      const core = await makeCore({ modules: [recipes, scenarios] });
      const scenario = (method: string, path: string, body?: unknown) =>
        core.modules.routes().find((r) => r.moduleId === 'scenarios' && r.route.method === method && r.route.path === path)!.route.handler({ body, query: {}, params: {}, userId: null });
      const christmas = (await scenario('POST', '/', { name: 'Christmas' })) as { id: string };
      const halloween = (await scenario('POST', '/', { name: 'Halloween' })) as { id: string };
      const pumpkin = await core.products.create({ name: 'Pumpkin' });
      const save = (body: unknown) => call(core, 'POST', '/', body) as Promise<RecipeView>;
      const soup = await save({ title: 'Pumpkin soup', ingredients: [{ name: 'pumpkin', quantity: 1 }], scenarioIds: [halloween.id], scenarioOnly: true });
      const pie = await save({ title: 'Pumpkin pie', ingredients: [{ name: 'pumpkin', quantity: 1 }], scenarioIds: [halloween.id, christmas.id] });
      await save({ title: 'Toast', ingredients: [{ name: 'bread' }] });
      const titles = async (query: Record<string, string> = {}) =>
        ((await core.modules.routes().find((r) => r.moduleId === 'recipes' && r.route.method === 'GET' && r.route.path === '/')!.route.handler({ body: undefined, query, params: {}, userId: null })) as RecipeView[]).map((r) => r.title);
      return { core, christmas, halloween, pumpkin, soup, pie, titles, scenario };
    }

    it('keeps scenario-only recipes off the main list, and shows them in their scenario and on their items', async () => {
      const { halloween, christmas, pumpkin, soup, titles } = await seasons();
      expect(soup).toMatchObject({ scenarios: [{ id: halloween.id, name: 'Halloween' }], hidden: true });
      expect(await titles()).toEqual(['Pumpkin pie', 'Toast']);
      expect(await titles({ show: 'scenario-only' })).toEqual(['Pumpkin soup']);
      expect(await titles({ scenarioId: halloween.id })).toEqual(['Pumpkin pie', 'Pumpkin soup']);
      expect(await titles({ scenarioId: christmas.id })).toEqual(['Pumpkin pie']);
      expect(await titles({ productId: pumpkin.id })).toEqual(['Pumpkin pie', 'Pumpkin soup']);
    });

    it('brings a recipe back to the main list when its scenarios go, and refuses unknown ones', async () => {
      const { core, halloween, soup, titles, scenario } = await seasons();
      await expect(call(core, 'POST', '/', { title: 'Mince pies', scenarioOnly: true })).rejects.toThrow('Pick the scenarios it shows in');
      await expect(call(core, 'POST', '/', { title: 'Mince pies', scenarioIds: ['7c6e7f0e-9d7b-4a43-9d1e-6a8b5f1b2c3d'] })).rejects.toThrow('no longer exists');
      await core.modules.setEnabled('scenarios', false);
      expect(await titles()).toContain('Pumpkin soup');
      await core.modules.setEnabled('scenarios', true);
      expect(await titles()).not.toContain('Pumpkin soup');
      await core.modules.routes().find((r) => r.moduleId === 'scenarios' && r.route.method === 'DELETE')!.route.handler({ body: undefined, query: {}, params: { id: halloween.id }, userId: null });
      expect(await titles()).toContain('Pumpkin soup');
      expect(((await call(core, 'GET', '/:id', undefined, { id: soup.id })) as RecipeView).scenarios).toEqual([]);
      void scenario;
    });

    it('lets assistants put recipes in scenarios by name', async () => {
      const { core } = await seasons();
      const saved = await core.assistant.call('save_recipe', { title: 'Mince pies', ingredients: [], method: 'Bake.', scenarios: ['christmas'], scenario_only: true });
      expect(saved.text).toContain('Saved "Mince pies".');
      expect((await core.assistant.call('list_recipes', {})).text).toBe([
        '- Mince pies (only for Christmas): everything in',
        '- Pumpkin pie (also in Halloween and Christmas): missing Pumpkin',
        '- Pumpkin soup (only for Halloween): missing Pumpkin',
        '- Toast: everything in',
      ].join('\n'));
      expect((await core.assistant.call('list_recipes', { scenario: 'halloween' })).text).not.toContain('Toast');
      const moved = await core.assistant.call('set_recipe_scenarios', { recipe: 'pumpkin soup', scenarios: ['Halloween', 'Christmas'], only: false });
      expect(moved.text).toBe('Pumpkin soup is in Halloween and Christmas and on the main list.');
      expect((await core.assistant.call('get_recipe', { recipe: 'pumpkin soup' })).text).toContain('- 1 pumpkin');
      expect((await core.assistant.call('set_recipe_scenarios', { recipe: 'mince pies', scenarios: [] })).text).toBe('Mince pies isn\'t in any scenario.');
      await expect(core.assistant.call('save_recipe', { title: 'Trifle', ingredients: [], method: '', scenarios: ['easter'] })).rejects.toThrow('The scenarios are');
    });
  });
});

/** Pancakes by ratio: 100 g flour to 3 eggs to 300 ml milk, and a pinch of salt. */
async function pancakes() {
  const core = await makeCore({ modules: [recipes] });
  const eggs = await core.products.create({ name: 'Free-range eggs', aliases: ['eggs'], unit: 'egg' });
  const milk = await core.products.create({ name: 'Milk', unit: 'ml' });
  await core.stock.add({ productId: eggs.id, quantity: 6 });
  await core.stock.add({ productId: milk.id, quantity: 2000 });
  const saved = await core.assistant.call('save_recipe', {
    title: 'Pancakes', serves: 2, method: 'Whisk, rest, fry.',
    ingredients: [
      { name: 'plain flour', ratio: 100, ratio_unit: 'grams' },
      { name: 'eggs', ratio: 3 },
      { name: 'milk', ratio: 300, ratio_unit: 'ml' },
      { name: 'salt', amount: 'a pinch' },
    ],
  });
  return { core, saved, id: saved.data!.id as string, ids: { eggs: eggs.id, milk: milk.id } };
}

describe('recipes by ratio, and presets', () => {
  it('saves ratios and says which ingredients have none', async () => {
    const { core, saved, id } = await pancakes();
    expect(saved.text).toBe('Saved "Pancakes". Not matched to Larder items: plain flour and salt. Everything needed is in the house. No ratio for salt, so it stays as saved when it\'s scaled.');
    const v = (await call(core, 'GET', '/:id', undefined, { id })) as RecipeView;
    expect(v.ingredients.map((i) => [i.name, i.ratio, i.ratioUnit, i.shown])).toEqual([
      ['plain flour', 100, 'g', '100 g'], ['eggs', 3, '', '3'], ['milk', 300, 'ml', '300 ml'], ['salt', null, '', 'a pinch'],
    ]);
    expect(v.scale).toMatchObject({ kind: 'saved', times: 1 });
  });

  it('works out the rest from what they have', async () => {
    const { core } = await pancakes();
    const text = (await core.assistant.call('get_recipe', { recipe: 'pancakes', have: [{ ingredient: 'egg', amount: 2 }] })).text;
    expect(text).toContain('Amounts worked out from 2 eggs (×0.67).');
    expect(text).toContain('- 67 g plain flour: not tracked in Larder');
    expect(text).toContain('- 2 eggs: in the house');
    expect(text).toContain('- 200 ml milk: in the house');
    expect(text).toContain('- a pinch salt (not scaled): not tracked in Larder');
    expect(text).toContain('offer to save them as a preset (save_recipe_preset)');

    // Given more than one, whichever runs out first sets the amounts.
    const both = (await core.assistant.call('get_recipe', { recipe: 'pancakes', have: [{ ingredient: 'eggs', amount: 6 }, { ingredient: 'flour', amount: 0.15, unit: 'kg' }] })).text;
    expect(both).toContain('Amounts worked out from 6 eggs and 0.15 kg plain flour (×1.5). Limited by the plain flour.');
    expect(both).toContain('- 4.5 eggs: in the house');
    expect((await core.assistant.call('get_recipe', { recipe: 'pancakes', have: [{ ingredient: 'milk', amount: 1, unit: 'pint' }] })).text).toContain('- 189 g plain flour');
  });

  it('says what it needs when the amount given does not fit', async () => {
    const { core } = await pancakes();
    const have = (ingredient: string, amount: number, unit?: string) => core.assistant.call('get_recipe', { recipe: 'pancakes', have: [{ ingredient, amount, unit }] });
    await expect(have('eggs', 100, 'g')).rejects.toThrow('Pancakes counts the eggs, so give how many, with no unit.');
    await expect(have('flour', 2, 'eggs')).rejects.toThrow('Pancakes measures the plain flour by weight, so give it in g, kg, oz or lb.');
    await expect(have('milk', 200, 'g')).rejects.toThrow('by volume, so give it in ml, cl, litres, tsp, tbsp, fl oz or pints.');
    await expect(have('salt', 1)).rejects.toThrow("Pancakes has no ratio for salt, so the rest can't be worked out from it. It can from plain flour, eggs and milk.");
    await expect(have('bacon', 2)).rejects.toMatchObject({ status: 404 });
    await expect(core.assistant.call('get_recipe', { recipe: 'pancakes', times: 2, servings: 4 })).rejects.toThrow('Give one of preset, servings, times or have, not servings and times.');
  });

  it('keeps presets, uses the default one, and asks when there is none', async () => {
    const { core } = await pancakes();
    const weekday = await core.assistant.call('save_recipe_preset', { recipe: 'pancakes', name: 'Weekday', have: [{ ingredient: 'eggs', amount: 2 }] });
    expect(weekday.text).toBe('Saved the "Weekday" preset for Pancakes: ×0.67 the recipe as saved (67 g plain flour, 2 eggs and 200 ml milk). To use it, call get_recipe with preset "Weekday".');
    let text = (await core.assistant.call('get_recipe', { recipe: 'pancakes' })).text;
    expect(text).toContain('Amounts as saved.\nPresets: Weekday (×0.67). None is the default: ask which they\'d like, or use the amounts as saved.');
    expect(text).not.toContain('offer to save');

    const family = await core.assistant.call('save_recipe_preset', { recipe: 'pancakes', name: 'Family', servings: 4, default: true });
    expect(family.text).toContain("It's the default, so Pancakes uses it unless another amount is asked for.");
    text = (await core.assistant.call('get_recipe', { recipe: 'pancakes' })).text;
    expect(text).toContain('Amounts for the "Family" preset (the default, ×2).\nPresets: Weekday (×0.67), Family (×2, the default).');
    expect(text).toContain('- 6 eggs: in the house');
    expect((await core.assistant.call('get_recipe', { recipe: 'pancakes', preset: 'weekday' })).text).toContain('- 2 eggs: in the house');
    expect((await core.assistant.call('get_recipe', { recipe: 'pancakes', times: 1 })).text).toContain('Amounts as saved.\nPresets: Weekday (×0.67), Family (×2, the default).\n');
    await expect(core.assistant.call('get_recipe', { recipe: 'pancakes', preset: 'huge' })).rejects.toThrow('Pancakes has no preset called "huge". Its presets are "Weekday" and "Family".');
    expect((await core.assistant.call('list_recipes', {})).text).toBe('- Pancakes: everything in (presets: Weekday, Family)');

    // Only a name and default: same amounts, same name, different default.
    await core.assistant.call('save_recipe_preset', { recipe: 'pancakes', name: 'weekday', default: true });
    text = (await core.assistant.call('get_recipe', { recipe: 'pancakes' })).text;
    expect(text).toContain('Amounts for the "Weekday" preset (the default, ×0.67).');
    await expect(core.assistant.call('save_recipe_preset', { recipe: 'pancakes', name: 'Brunch' })).rejects.toThrow('Say how much the "Brunch" preset makes');

    const forgot = await core.assistant.call('forget_recipe_preset', { recipe: 'pancakes', preset: 'weekday' });
    expect(forgot.text).toBe('Forgot the "Weekday" preset for Pancakes. It was the default, so the amounts as saved are used now.');
    expect((await core.assistant.call('get_recipe', { recipe: 'pancakes' })).text).toContain('Amounts as saved.\nPresets: Family (×2). None is the default');
  });

  it('cooks the default preset unless told otherwise, taking ratios from stock in its own unit', async () => {
    const { core, ids } = await pancakes();
    await core.assistant.call('save_recipe_preset', { recipe: 'pancakes', name: 'Family', times: 2, default: true });
    const p = await core.assistant.call('propose_cooking', { recipe: 'pancakes' });
    expect(p.text).toContain('Cooking Pancakes (the "Family" preset, ×2) would take out of stock:\n- Free-range eggs: 6 eggs (of 6 eggs)\n- Milk: 600 ml (of 2000 ml)\nNot taken: plain flour, salt.');
    const fewer = await core.assistant.call('propose_cooking', { recipe: 'pancakes', have: [{ ingredient: 'eggs', amount: 2 }] });
    expect(fewer.text).toContain('Cooking Pancakes from 2 eggs (×0.67) would take out of stock:\n- Free-range eggs: 2 eggs (of 6 eggs)\n- Milk: 200 ml (of 2000 ml)');
    await core.assistant.call('confirm_cooking', { proposal: /Proposal id: (\S+)\./.exec(fewer.text)![1]! });
    expect((await core.products.summary(ids.eggs)).inStock).toBe(4);
    expect((await core.products.summary(ids.milk)).inStock).toBe(1800);
    // Twice the recipe needs 6 eggs, and there are 4 now.
    expect((await core.assistant.call('list_recipes', {})).text).toBe('- Pancakes: missing Free-range eggs (presets: Family)');
  });

  it('scales, saves and forgets presets over the API, and keeps them when the recipe is edited', async () => {
    const { core, id } = await pancakes();
    let v = (await call(core, 'POST', '/:id/presets', { name: 'Big batch', times: 3 }, { id })) as RecipeView;
    expect(v.presets).toEqual([{ name: 'Big batch', times: 3 }]);
    v = (await call(core, 'POST', '/:id/scale', { preset: 'big batch' }, { id })) as RecipeView;
    expect(v.scale).toMatchObject({ kind: 'preset', preset: 'Big batch', times: 3 });
    expect(v.ingredients[0]!.shown).toBe('300 g');

    // The web editor sends the recipe back without presets: they stay.
    v = (await call(core, 'PUT', '/:id', { title: 'Pancakes', ingredients: [{ name: 'eggs', ratio: 2 }] }, { id })) as RecipeView;
    expect(v.presets.map((p) => p.name)).toEqual(['Big batch']);
    v = (await call(core, 'PUT', '/:id', { title: 'Pancakes', ingredients: [{ name: 'eggs', ratio: 2 }], presets: [{ name: 'Small', times: 0.5 }, { name: 'Big batch', times: 3 }], defaultPreset: 'small' }, { id })) as RecipeView;
    expect([v.defaultPreset, v.scale.preset, v.ingredients[0]!.shown]).toEqual(['Small', 'Small', '1']);
    await expect(call(core, 'PUT', '/:id', { title: 'Pancakes', presets: [{ name: 'Small', times: 1 }, { name: 'small', times: 2 }] }, { id })).rejects.toThrow('Two presets are called "small"');
    await expect(call(core, 'PUT', '/:id', { title: 'Pancakes', defaultPreset: 'Huge' }, { id })).rejects.toThrow('The default preset must be one of the recipe\'s presets ("Small" and "Big batch").');

    v = (await call(core, 'DELETE', '/:id/presets/:name', undefined, { id, name: 'Small' })) as RecipeView;
    expect([v.presets.map((p) => p.name), v.defaultPreset, v.scale.kind]).toEqual([['Big batch'], null, 'saved']);
    const p = (await call(core, 'POST', '/:id/cook', { have: [{ ingredient: 'eggs', amount: 1 }] }, { id })) as Proposal;
    expect([p.times, p.from, p.items.map((i) => [i.name, i.quantity])]).toEqual([0.5, '1 egg', [['Free-range eggs', 1]]]);
  });

  it('adds ratios to a recipe saved without them, keeping everything else', async () => {
    const { core } = await kitchen();
    await core.products.create({ name: 'Tinned tomatoes', unit: 'tin' });
    await core.assistant.call('save_recipe', { title: 'Chilli', serves: 4, method: 'Simmer.', ingredients: [{ name: 'chopped tomatoes', item: 'Tinned tomatoes', quantity: 2, amount: '2 tins' }, { name: 'onion', amount: '1 large' }] });
    const changed = await core.assistant.call('save_recipe', { recipe: 'chilli', ingredients: [{ name: 'chopped tomatoes', ratio: 800, ratio_unit: 'g' }, { name: 'onion', ratio: 1 }] });
    expect(changed.text).toBe('Changed "Chilli". Not matched to Larder items: onion. Missing now: Tinned tomatoes.');
    const v = (await core.assistant.call('get_recipe', { recipe: 'chilli', servings: 2 })).data as unknown as RecipeView;
    expect(v.ingredients.map((i) => [i.name, i.item, i.quantity, i.amount, i.shown])).toEqual([['chopped tomatoes', 'Tinned tomatoes', 2, '2 tins', '400 g'], ['onion', null, null, '1 large', '0.5']]);
    expect([v.serves, v.method]).toEqual([4, 'Simmer.']);
    // Without ingredients, only what's given changes.
    await core.assistant.call('save_recipe', { recipe: 'chilli', serves: 6 });
    expect(((await core.assistant.call('get_recipe', { recipe: 'chilli' })).data as unknown as RecipeView).ingredients).toHaveLength(2);
    await expect(core.assistant.call('save_recipe', { title: 'Soup' })).rejects.toThrow('Give the method (the steps) for a new recipe.');
  });

  it('reads recipes saved before ratios and presets, and scales them by their stock quantities', async () => {
    const storage = createMemoryStorage();
    const core = await makeCore({ modules: [recipes], storage });
    const chicken = await core.products.create({ name: 'Chicken thighs', unit: 'g' });
    await core.stock.add({ productId: chicken.id, quantity: 2000 });
    const now = '2026-10-01T09:00:00.000Z';
    await storage.documents('recipes:recipes').put('old', {
      id: 'old', title: 'Roast chicken', serves: 4, ingredients: [{ name: 'chicken thighs', productId: chicken.id, quantity: 1000, amount: '8', optional: false }],
      method: 'Roast.', notes: '', source: '', createdAt: now, updatedAt: now, lastCookedAt: null, timesCooked: 0,
    });
    const v = (await core.assistant.call('get_recipe', { recipe: 'roast chicken', have: [{ ingredient: 'chicken', amount: 500, unit: 'g' }] })).data as unknown as RecipeView;
    expect([v.presets, v.defaultPreset, v.scale.times, v.ingredients[0]!.shown]).toEqual([[], null, 0.5, '500 g']);
    await core.assistant.call('save_recipe_preset', { recipe: 'roast chicken', name: 'Two of us', servings: 2 });
    expect((await call(core, 'GET', '/:id', undefined, { id: 'old' }) as RecipeView).presets).toEqual([{ name: 'Two of us', times: 0.5 }]);
  });
});
