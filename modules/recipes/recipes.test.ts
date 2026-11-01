import { describe, expect, it } from 'vitest';
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
