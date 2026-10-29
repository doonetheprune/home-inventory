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

  it('introduces Larder and lists a small set of clearly described tools', async () => {
    expect(client.getInstructions()).toContain('Never guess');
    expect(client.getServerVersion()).toMatchObject({ name: 'larder', title: 'Larder' });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['search', 'get_item', 'add_item', 'add_stock', 'use_stock', 'move_item', 'add_expected', 'mark_arrived', 'add_to_shopping_list', 'shopping_list', 'expiring', 'check_price', 'set_usual_price']);
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(tools.find((t) => t.name === 'search')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'add_stock')?.annotations?.readOnlyHint).toBe(false);
    // Clients may skip asking before tools that only add; ones that take away or overwrite say so.
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive).toEqual(['use_stock', 'move_item', 'mark_arrived', 'set_usual_price']);
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

  it('needs an access token', async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Any).message).toContain('Bearer');
    expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });
});
