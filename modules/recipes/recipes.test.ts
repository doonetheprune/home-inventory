import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
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
});
