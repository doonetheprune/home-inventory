import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import recipes from '../../modules/recipes';
import { makeApp } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const text = (r: Any) => (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');

/** Recipes by ratio over MCP: "I've only got 2 eggs", then keeping it as a preset. */
describe('MCP recipe ratios and presets', () => {
  let app: Awaited<ReturnType<typeof makeApp>>['app'];
  let client: Client;

  beforeAll(async () => {
    const made = await makeApp({ modules: [recipes] });
    app = made.app;
    await made.call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    const token = (await made.call<Any>('POST', '/api/v1/auth/tokens', { name: 'Claude' })).body.token;
    const eggs = (await made.call<Any>('POST', '/api/v1/products', { name: 'Free-range eggs', aliases: ['eggs'], unit: 'egg' })).body;
    await made.call('POST', '/api/v1/stock/add', { productId: eggs.id, quantity: 6 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    client = new Client({ name: 'larder-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  });

  afterAll(async () => {
    await client.close();
    await app.close();
  });

  it('serves the recipe tools, with forgetting marked destructive and proposing read-only', async () => {
    const { tools } = await client.listTools();
    const mine = tools.filter((t) => /recipe|cooking/.test(t.name));
    expect(mine.map((t) => t.name)).toEqual(['save_recipe', 'list_recipes', 'get_recipe', 'set_recipe_scenarios', 'recipe_to_shopping_list', 'forget_recipe', 'save_recipe_preset', 'forget_recipe_preset', 'propose_cooking', 'confirm_cooking']);
    expect(mine.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)).toEqual(['set_recipe_scenarios', 'forget_recipe', 'forget_recipe_preset']);
    // propose_cooking only works out a list; confirm_cooking applies it once the person has agreed in the chat, so neither asks again.
    expect(mine.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(['list_recipes', 'get_recipe', 'propose_cooking']);
    const get = tools.find((t) => t.name === 'get_recipe')!.inputSchema as Any;
    expect(Object.keys(get.properties)).toEqual(['recipe', 'preset', 'servings', 'times', 'have']);
    expect(get.properties.have.items.required).toEqual(['ingredient', 'amount']);
  });

  it('works out the rest from what they have, then keeps it as the default preset', async () => {
    let r: Any = await client.callTool({ name: 'save_recipe', arguments: {
      title: 'Pancakes', serves: 2, method: 'Whisk and fry.',
      ingredients: [{ name: 'plain flour', ratio: 100, ratio_unit: 'g' }, { name: 'eggs', ratio: 2 }, { name: 'milk', ratio: 300, ratio_unit: 'ml' }],
    } });
    expect(r.isError).toBeFalsy();

    r = await client.callTool({ name: 'get_recipe', arguments: { recipe: 'pancakes', have: [{ ingredient: 'eggs', amount: 3 }] } });
    expect(text(r)).toContain('Amounts worked out from 3 eggs (×1.5).');
    expect(text(r)).toContain('- 150 g plain flour: not tracked in Larder');
    expect(text(r)).toContain('- 450 ml milk: not tracked in Larder');
    expect(text(r)).toContain('offer to save them as a preset (save_recipe_preset)');

    r = await client.callTool({ name: 'save_recipe_preset', arguments: { recipe: 'pancakes', name: 'Sunday', have: [{ ingredient: 'eggs', amount: 3 }], default: true } });
    expect(text(r)).toContain('Saved the "Sunday" preset for Pancakes: ×1.5 the recipe as saved');

    r = await client.callTool({ name: 'get_recipe', arguments: { recipe: 'pancakes' } });
    expect(text(r)).toContain('Amounts for the "Sunday" preset (the default, ×1.5).');

    r = await client.callTool({ name: 'get_recipe', arguments: { recipe: 'pancakes', preset: 'sunday', times: 2 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Give one of preset, servings, times or have');
  });
});
