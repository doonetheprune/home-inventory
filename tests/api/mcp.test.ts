import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pricing from '../../modules/pricing';
import { makeApp } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const text = (r: Any) => (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join('\n');

describe('MCP server', () => {
  let url: string;
  let token: string;
  let app: Awaited<ReturnType<typeof makeApp>>['app'];
  let client: Client;

  beforeAll(async () => {
    const made = await makeApp({ modules: [pricing] });
    app = made.app;
    await made.call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    token = (await made.call<Any>('POST', '/api/v1/auth/tokens', { name: 'Claude' })).body.token;
    await made.call('POST', '/api/v1/places', { name: 'Bathroom cupboard', code: 'B1' });
    await made.call('POST', '/api/v1/products', { name: 'Toilet roll', aliases: ['loo roll'], unit: 'roll', minQuantity: 9 });
    await made.call('POST', '/api/v1/products', { name: 'AA batteries' });
    await made.call('POST', '/api/v1/products', { name: 'AAA batteries' });
    await made.call('POST', '/api/v1/shops/presets', { name: 'Aldi' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
    client = new Client({ name: 'larder-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  });

  afterAll(async () => {
    await client.close();
    await app.close();
  });

  it('introduces Larder and lists clearly described tools', async () => {
    expect(client.getInstructions()).toContain('Never guess');
    expect(client.getServerVersion()).toMatchObject({ name: 'larder', title: 'Larder' });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'search', 'get_item', 'add_item', 'add_stock', 'use_stock', 'finish_item', 'move_item', 'add_expected', 'mark_arrived', 'confirm_order', 'cancel_order', 'add_to_shopping_list',
      'remove_from_shopping_list', 'put_back', 'mark_charged', 'renew', 'shopping_list', 'expiring',
      'list_shops', 'add_shop', 'change_shop', 'remove_shop', 'list_places', 'add_place', 'add_storage_grid', 'change_place', 'remove_place',
      'list_categories', 'add_category', 'change_category', 'remove_category', 'change_item', 'set_item_size', 'remove_item', 'add_brand', 'remove_brand',
      'correct_stock', 'deliveries', 'recent_changes', 'list_items', 'get_place', 'identify_code', 'bought',
      'check_price', 'set_usual_price', 'convert_price', 'get_price',
    ]);
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(tools.find((t) => t.name === 'search')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'add_stock')?.annotations?.readOnlyHint).toBe(false);
    // The Claude app asks before every call to a destructive tool, so only ones that remove or overwrite say so.
    // Everyday stock changes that the opposite tool undoes (and stock history records) don't, so talking to it doesn't stop at each one.
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive).toEqual([
      'cancel_order', 'change_shop', 'remove_shop', 'change_place', 'remove_place',
      'change_category', 'remove_category', 'change_item', 'set_item_size', 'remove_item', 'remove_brand', 'correct_stock', 'set_usual_price',
    ]);
    for (const name of ['use_stock', 'finish_item', 'move_item', 'mark_arrived', 'remove_from_shopping_list']) {
      const hints = tools.find((t) => t.name === name)?.annotations;
      expect(hints, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it('adds, finds and uses stock by name, answering in plain text', async () => {
    let r: Any = await client.callTool({ name: 'add_stock', arguments: { item: 'loo rolls', quantity: 12, place: 'b1' } });
    expect(text(r)).toBe('Toilet roll: added 12 rolls to Bathroom cupboard. 12 rolls in stock.');
    r = await client.callTool({ name: 'get_item', arguments: { item: 'toilet roll' } });
    expect(text(r)).toContain('In stock: 12 rolls.');
    expect(text(r)).toContain('- 12 rolls in Bathroom cupboard');
    expect(text(r)).toContain('Also called: loo roll.');
    r = await client.callTool({ name: 'use_stock', arguments: { item: 'loo roll', quantity: 4 } });
    expect(text(r)).toBe('Toilet roll: used 4 rolls. 8 rolls left, running low.');
    r = await client.callTool({ name: 'search', arguments: { query: 'bog rol' } });
    expect(text(r)).toBeTruthy();
    r = await client.callTool({ name: 'search', arguments: { query: 'loo' } });
    expect(text(r)).toContain('Toilet roll: 8 rolls, in Bathroom cupboard, running low');
  });

  it('asks instead of guessing, and reports problems as tool errors', async () => {
    let r: Any = await client.callTool({ name: 'use_stock', arguments: { item: 'batteries' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Say which one');
    expect(text(r)).toContain('AA batteries');
    r = await client.callTool({ name: 'use_stock', arguments: { item: 'unicorn horn' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("doesn't know");
    r = await client.callTool({ name: 'use_stock', arguments: { item: 'aaa batteries', quantity: 5 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("There's no AAA batteries left to use.");
  });

  it('adds new items, deliveries and shopping, and plans around what expires', async () => {
    let r: Any = await client.callTool({ name: 'add_item', arguments: { name: 'Chopped tomatoes', category: 'Food', unit: 'tin', shop: 'aldi', shop_code: '4088600214568', shelf_life_days: 300 } });
    expect(text(r)).toBe('Added Chopped tomatoes. It has no stock yet: use add_stock to say how many.');
    r = await client.callTool({ name: 'add_item', arguments: { name: 'Chopped tomatoes' } });
    expect(r.isError).toBe(true);
    r = await client.callTool({ name: 'add_item', arguments: { name: 'Gravy', category: 'Sauces' } });
    expect(text(r)).toContain('The categories are: Food');
    // A barcode that's taken fails before anything is made.
    await client.callTool({ name: 'add_item', arguments: { name: 'Baked beans', barcode: '5000157024671' } });
    r = await client.callTool({ name: 'add_item', arguments: { name: 'Spaghetti hoops', barcode: '5000157024671' } });
    expect(text(r)).toBe('Barcode 5000157024671 already belongs to Baked beans.');
    r = await client.callTool({ name: 'search', arguments: { query: 'spaghetti hoops' } });
    expect(text(r)).not.toContain('Spaghetti hoops');

    // From a photo of the pack: the brand is kept, and a shop Larder doesn't have is only added once the person says so.
    r = await client.callTool({ name: 'add_item', arguments: { name: 'Oat drink', brand: 'Oatly Barista Edition 1 L', shop: 'Waitrose', unit: 'carton' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Ask whether to add "Waitrose" as a shop, then call add_item again with new_shop: true');
    r = await client.callTool({ name: 'search', arguments: { query: 'oat drink' } });
    expect(text(r)).not.toContain('Oat drink');
    r = await client.callTool({ name: 'add_item', arguments: { name: 'Oat drink', brand: 'Oatly Barista Edition 1 L', shop: 'Waitrose', new_shop: true, unit: 'carton', category: 'Food' } });
    expect(text(r)).toBe('Added Oat drink. Added Waitrose to the shops. It has no stock yet: use add_stock to say how many.');
    r = await client.callTool({ name: 'get_item', arguments: { item: 'oat drink' } });
    expect(text(r)).toContain('Buy from: Waitrose.');
    expect(text(r)).toContain('Brands: Oatly Barista Edition 1 L.');
    r = await client.callTool({ name: 'search', arguments: { query: 'oatly' } });
    expect(text(r)).toContain('Oat drink');
    // A shop on the presets list comes with what it sells.
    r = await client.callTool({ name: 'add_item', arguments: { name: 'Lidl tea bags', shop: 'lidl', new_shop: true, brand: 'Lidl 80 Tea Bags' } });
    expect(text(r)).toContain('Added Lidl to the shops.');

    // Order emails mention shop codes.
    r = await client.callTool({ name: 'add_expected', arguments: { item: '4088600214568', quantity: 4, source: 'Aldi order', eta: '2026-11-01' } });
    expect(text(r)).toBe('Chopped tomatoes: 4 tins expected from Aldi order.');
    r = await client.callTool({ name: 'mark_arrived', arguments: { source: 'Aldi order' } });
    expect(text(r)).toBe('Arrived: Chopped tomatoes.');

    r = await client.callTool({ name: 'shopping_list', arguments: {} });
    expect(text(r)).toContain('Aldi:');
    r = await client.callTool({ name: 'add_to_shopping_list', arguments: { item: 'chopped tomatoes' } });
    r = await client.callTool({ name: 'shopping_list', arguments: { shop: 'aldi' } });
    expect(text(r)).toContain('Chopped tomatoes');

    r = await client.callTool({ name: 'expiring', arguments: { days: 365 } });
    expect(text(r)).toMatch(/Chopped tomatoes: expires \d{4}-\d{2}-\d{2} \(in \d+ days\), 4 tins/);
  });

  it('checks a pack price against the usual price', async () => {
    let r: Any = await client.callTool({ name: 'set_usual_price', arguments: { item: 'toilet roll', quantity: 9, price: 3.25 } });
    expect(text(r)).toContain('£0.361 a roll');
    r = await client.callTool({ name: 'check_price', arguments: { item: 'loo roll', quantity: 24, price: 8 } });
    expect(text(r)).toBe("That's £0.333 a roll against the usual £0.361: 8% cheaper, saving about £0.67 on this pack.");
  });

  it('offers to add a shop that isn\'t set up, instead of leaving it out', async () => {
    let r: Any = await client.callTool({ name: 'add_item', arguments: { name: 'Cling film', category: 'Household', unit: 'roll', shop: 'Tesco' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Larder doesn\'t know a shop called "Tesco". The shops are Aldi, Waitrose and Lidl. Ask whether to add "Tesco" as a shop, then call add_item again with new_shop: true, or leave the shop out.');
    r = await client.callTool({ name: 'search', arguments: { query: 'cling film' } });
    expect(text(r)).not.toContain('Cling film');
    r = await client.callTool({ name: 'add_shop', arguments: { name: 'tesco' } });
    expect(text(r)).toBe('Added Tesco, which sells Food, Household, Toiletries, Medicine, Pets and Batteries.');
    r = await client.callTool({ name: 'add_item', arguments: { name: 'Cling film', category: 'Household', unit: 'roll', shop: 'Tesco' } });
    expect(text(r)).toContain('Added Cling film.');
    r = await client.callTool({ name: 'get_item', arguments: { item: 'cling film' } });
    expect(text(r)).toContain('Buy from: Tesco.');
    r = await client.callTool({ name: 'add_item', arguments: { name: 'Gravy granules', usual_place: 'pantry' } });
    expect(text(r)).toContain('Ask if they want it added with add_place');
    r = await client.callTool({ name: 'add_shop', arguments: { name: 'Corner shop', sells: ['Food', 'Snacks'] } });
    expect(text(r)).toContain('There\'s no category called "Snacks". The categories are: Food, Household');
    expect(text(r)).toContain('add_category');
  });

  it('changes anything about an item after it was added', async () => {
    await client.callTool({ name: 'add_item', arguments: { name: 'Porridge oats', category: 'Food', unit: 'bag' } });
    // "porridge oats", as "oats" could be the oat drink too.
    let r: Any = await client.callTool({ name: 'change_item', arguments: { item: 'porridge oats', minimum: 2, shops: ['aldi', 'tesco'] } });
    expect(text(r)).toBe('Porridge oats is updated: bought from Aldi and Tesco, low below 2 bags.');
    r = await client.callTool({ name: 'get_item', arguments: { item: 'porridge oats' } });
    expect(text(r)).toContain('Running low below 2 bags: it is low now.');
    r = await client.callTool({ name: 'add_place', arguments: { name: 'Pantry', code: 'P1' } });
    expect(text(r)).toBe('Added Pantry (code P1).');
    r = await client.callTool({ name: 'add_place', arguments: { name: 'Top shelf', inside: 'pantry' } });
    expect(text(r)).toBe('Added Pantry › Top shelf.');
    r = await client.callTool({ name: 'change_item', arguments: { item: 'porridge oats', usual_place: 'top shelf', shops: [], minimum: null, aliases: ['oats'], name: 'Oats' } });
    expect(text(r)).toBe('Oats is updated: from any shop that sells it, usually lives in Pantry › Top shelf, never counts as low.');
    r = await client.callTool({ name: 'add_stock', arguments: { item: 'oats', quantity: 1 } });
    expect(text(r)).toContain('Oats: added 1 bag');
    r = await client.callTool({ name: 'get_item', arguments: { item: 'oats' } });
    expect(text(r)).toContain('- 1 bag in Pantry › Top shelf');
    r = await client.callTool({ name: 'change_item', arguments: { item: 'oats', name: 'Toilet roll' } });
    expect(text(r)).toBe('There\'s already an item called Toilet roll.');
  });

  it('keeps shops, places, categories, brands and stock like the app does', async () => {
    let r: Any = await client.callTool({ name: 'list_shops', arguments: {} });
    expect(text(r)).toContain('- Tesco: sells Food, Household');
    r = await client.callTool({ name: 'change_shop', arguments: { shop: 'tesco', sells: ['Food'], notes: 'Big one on the ring road' } });
    expect(text(r)).toBe('Tesco sells Food.');
    r = await client.callTool({ name: 'add_category', arguments: { name: 'Garden', warn_days: 14 } });
    expect(text(r)).toBe('Added the Garden category.');
    r = await client.callTool({ name: 'change_category', arguments: { category: 'garden', name: 'Garden & outdoors' } });
    expect(text(r)).toBe('Garden & outdoors is updated.');
    r = await client.callTool({ name: 'list_categories', arguments: {} });
    expect(text(r)).toContain('- Garden & outdoors: 0 items, warns 14 days before expiry');
    r = await client.callTool({ name: 'remove_category', arguments: { category: 'Household' } });
    expect(text(r)).toBe('1 item uses this category. Move them to another category first.');
    r = await client.callTool({ name: 'remove_category', arguments: { category: 'garden & outdoors' } });
    expect(text(r)).toBe('Removed the Garden & outdoors category.');

    r = await client.callTool({ name: 'add_storage_grid', arguments: { name: 'Racking', inside: 'pantry', prefix: 'R', rows: 2, columns: 3 } });
    expect(text(r)).toBe('Added Pantry › Racking with 6 spots, R1-1 to R2-3.');
    r = await client.callTool({ name: 'change_place', arguments: { place: 'top shelf', name: 'High shelf', code: 'P2' } });
    expect(text(r)).toBe('Pantry › High shelf (code P2) is updated.');
    r = await client.callTool({ name: 'list_places', arguments: {} });
    expect(text(r)).toContain('- Pantry (P1): 1 item\n  - High shelf (P2): 1 item');
    r = await client.callTool({ name: 'remove_place', arguments: { place: 'p2' } });
    expect(text(r)).toBe('High shelf still has things in it. Move them somewhere else first.');
    r = await client.callTool({ name: 'remove_place', arguments: { place: 'r2-3' } });
    expect(text(r)).toBe('Removed Pantry › Racking › Shelf 2, box 3.');

    r = await client.callTool({ name: 'add_brand', arguments: { item: 'oats', name: 'Scott\'s 1 kg', barcode: '5000108020523' } });
    expect(text(r)).toBe('Added Scott\'s 1 kg to Oats with barcode 5000108020523.');
    r = await client.callTool({ name: 'get_item', arguments: { item: '5000108020523' } });
    expect(text(r)).toContain('Brands: Scott\'s 1 kg (barcode 5000108020523).');
    r = await client.callTool({ name: 'remove_brand', arguments: { item: 'oats', brand: '5000108020523' } });
    expect(text(r)).toBe('Removed Scott\'s 1 kg from Oats.');

    await client.callTool({ name: 'add_stock', arguments: { item: 'oats', quantity: 2, place: 'R1-1', expires_on: '2027-03-01' } });
    r = await client.callTool({ name: 'correct_stock', arguments: { item: 'oats', quantity: 3 } });
    expect(text(r)).toBe('Oats has 2 batches. Say which by place or expiry date. Candidates: 2 bags in Pantry › Racking › Shelf 1, box 1, expires 2027-03-01; 1 bag in Pantry › High shelf.');
    r = await client.callTool({ name: 'correct_stock', arguments: { item: 'oats', place: 'r1-1', quantity: 3, new_expiry: '2027-04-01' } });
    expect(text(r)).toBe('Oats: corrected. 4 bags in stock.');
    r = await client.callTool({ name: 'correct_stock', arguments: { item: 'oats', expires_on: '2027-04-01', remove: true } });
    expect(text(r)).toBe('Oats: removed the batch of 3 bags in Pantry › Racking › Shelf 1, box 1, expires 2027-04-01. 1 bag in stock.');
    r = await client.callTool({ name: 'recent_changes', arguments: { item: 'oats', limit: 3 } });
    expect(text(r)).toMatch(/Oats removed 3 bags[\s\S]*Oats corrected by \+1 bag/);

    r = await client.callTool({ name: 'remove_from_shopping_list', arguments: { item: 'chopped tomatoes' } });
    expect(text(r)).toContain('Chopped tomatoes is off the shopping list');
    r = await client.callTool({ name: 'deliveries', arguments: {} });
    expect(text(r)).toBe('Nothing is on the way.');
    r = await client.callTool({ name: 'remove_item', arguments: { item: 'oats' } });
    expect(text(r)).toBe('Removed Oats and its 1 bag in stock.');
    r = await client.callTool({ name: 'remove_shop', arguments: { shop: 'tesco' } });
    expect(text(r)).toBe('Removed Tesco.');
    r = await client.callTool({ name: 'get_item', arguments: { item: 'cling film' } });
    expect(text(r)).not.toContain('Tesco');
  });

  it('needs an access token', async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Any).message).toContain('Bearer');
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });
});
