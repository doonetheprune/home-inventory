import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../../src/adapters/storage-memory';
import { makeCore, saveAs092 } from '../../tests/helpers';
import pricing from '../pricing/index';
import ai from './index';
import { householdItems, type ReceiptReading } from './receipts';

type Core = Awaited<ReturnType<typeof makeCore>>;
const route = (core: Core, moduleId: string, method: string, path: string) =>
  core.modules.routes().find((r) => r.moduleId === moduleId && r.route.method === method && r.route.path === path)!.route;
const call = <T = unknown>(core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}) => {
  const r = route(core, 'ai', method, path);
  return r.handler({ body: r.body ? r.body.parse(body) : body, query: {}, params, userId: null }) as Promise<T>;
};

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]).toString('base64');

/** Pretend Claude and Gemini, answering every photo with `answer`. Records every request. */
function internet(answer: () => ReceiptReading) {
  const sent: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    sent.push({ url, body });
    const u = new URL(url);
    if (u.hostname === 'api.anthropic.com' && u.pathname.startsWith('/v1/models/')) {
      return Response.json({ id: u.pathname.split('/').pop(), type: 'model', display_name: 'Claude', created_at: '2026-01-01T00:00:00Z', capabilities: { effort: { supported: true }, image_input: { supported: true }, structured_outputs: { supported: true } } });
    }
    if (u.hostname === 'api.anthropic.com' && u.pathname === '/v1/messages') {
      return Response.json({
        id: 'msg_1', type: 'message', role: 'assistant', model: String(body?.model), stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(answer()) }], usage: { input_tokens: 3000, output_tokens: 400 },
      });
    }
    if (u.hostname === 'generativelanguage.googleapis.com' && u.pathname.endsWith(':generateContent')) {
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(answer()) }] } }] });
    }
    throw new Error(`No network in tests (${url})`);
  }) as unknown as typeof fetch;
  const prompts = () => sent.filter((r) => r.url.endsWith('/v1/messages')).map((r) => String((r.body!.messages as Array<{ content: Array<{ text?: string }> }>)[0]!.content[1]!.text));
  return { fetch: fake, sent, prompts };
}

const line = (l: Partial<ReceiptReading['lines'][number]> & { text: string }): ReceiptReading['lines'][number] => ({ count: 1, price: null, item: null, quantity: null, sure: true, ...l });

/** A household with beans, milk and toilet roll (listed to the AI in that order), and Tesco. */
async function household(answer: () => ReceiptReading) {
  const net = internet(answer);
  const storage = createMemoryStorage();
  const core = await makeCore({ modules: [ai, pricing], fetch: net.fetch, storage });
  await call(core, 'PUT', '/settings', { claude: { apiKey: 'sk-ant-test-0000-wxyz', model: 'claude-haiku-5-5' } });
  const beans = await core.products.create({ name: 'Baked beans', unit: 'tin', aliases: ['beans'] });
  const milk = await core.products.create({ name: 'Semi-skimmed milk', unit: 'bottle' });
  const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll', aliases: ['loo roll'] });
  await core.products.addVariant(loo.id, { name: 'Andrex Classic Clean 9 rolls' });
  await core.products.create({ name: 'Garden gnome', wish: true });
  const tesco = await core.shops.addPreset('Tesco');
  return { core, net, beans, milk, loo, tesco, storage };
}

const TESCO: ReceiptReading = {
  readable: true,
  shop: 'TESCO',
  date: '2026-11-02',
  total: 12.6,
  lines: [
    line({ text: 'HNZ BKD BNZ 4X415G', price: 3.5, item: 1, quantity: 4 }),
    line({ text: 'ANDREX CLASSIC 9PK', count: 2, price: 6.5, item: 3, quantity: 18 }),
    line({ text: 'TESCO SEMI SKMD 4PT', price: 1.6, item: 2, quantity: 4, sure: false }),
    line({ text: 'TESCO GARLIC BREAD', price: 1, item: null }),
    line({ text: 'MYSTERY LINE', item: 99, quantity: 3 }),
  ],
};

describe('AI module: receipts', () => {
  it('reads a receipt and matches each line to an item the household has, or to none', async () => {
    const { core, net, beans, milk, loo, tesco } = await household(() => TESCO);
    const out = await call(core, 'POST', '/receipt', { image: JPEG });
    expect(out).toEqual({
      readable: true,
      shop: { name: 'Tesco', id: tesco.id, preset: false },
      date: '2026-11-02',
      total: 12.6,
      lines: [
        { text: 'HNZ BKD BNZ 4X415G', count: 1, price: 3.5, item: { id: beans.id, name: 'Baked beans', unit: 'tin' }, quantity: 4, match: 'sure' },
        { text: 'ANDREX CLASSIC 9PK', count: 2, price: 6.5, item: { id: loo.id, name: 'Toilet roll', unit: 'roll' }, quantity: 18, match: 'sure' },
        { text: 'TESCO SEMI SKMD 4PT', count: 1, price: 1.6, item: { id: milk.id, name: 'Semi-skimmed milk', unit: 'bottle' }, quantity: 4, match: 'guess' },
        { text: 'TESCO GARLIC BREAD', count: 1, price: 1, item: null, quantity: 1, match: 'none' },
        // An item number that isn't on the list is no match, not a crash.
        { text: 'MYSTERY LINE', count: 1, price: null, item: null, quantity: 1, match: 'none' },
      ],
      addedBefore: null,
      receiptKey: 'tesco:2026-11-02:12.60',
      provider: 'claude',
      model: 'claude-haiku-5-5',
      skipped: [],
    });

    // The AI is shown the household's items with their other names and brands, numbered; not the wish list.
    const prompt = net.prompts()[0]!;
    expect(prompt).toContain('1. Baked beans (bought in tins; also beans)');
    expect(prompt).toContain('2. Semi-skimmed milk (bought in bottles)');
    expect(prompt).toContain('3. Toilet roll (bought in rolls; also loo roll; brands Andrex Classic Clean 9 rolls)');
    expect(prompt).not.toContain('Garden gnome');
    expect(prompt).toContain('never pick the nearest one just to have one');
    const msg = net.sent.find((r) => r.url.endsWith('/v1/messages'))!;
    expect(msg.body).toMatchObject({ output_config: { effort: 'medium', format: { type: 'json_schema' } } });
    // A receipt is read, never looked up on the web.
    expect(msg.body).not.toHaveProperty('tools');
  });

  it('adds what was kept in one go, records the prices paid, and learns the shop\'s names for next time', async () => {
    let answer = TESCO;
    const { core, net, beans, milk, loo, tesco, storage } = await household(() => answer);
    const r = await call<{ receiptKey: string }>(core, 'POST', '/receipt', { image: JPEG });
    const out = await call(core, 'POST', '/receipt/add', {
      shopId: tesco.id,
      receiptKey: r.receiptKey,
      lines: [
        { productId: beans.id, quantity: 4, price: 3.5, text: 'HNZ BKD BNZ 4X415G' },
        { productId: loo.id, quantity: 18, price: 6.5, text: 'ANDREX CLASSIC 9PK', count: 2 },
        // Picked by hand in the app: the AI only guessed.
        { productId: milk.id, quantity: 4, price: 1.6, text: 'TESCO SEMI SKMD 4PT' },
      ],
    });
    expect(out).toEqual({ added: 3, message: 'Added 3 things from Tesco to stock.' });
    expect((await core.products.summary(loo.id)).inStock).toBe(18);
    expect((await core.products.summary(beans.id)).inStock).toBe(4);

    // The pricing module keeps the prices paid; the first becomes the usual price.
    await new Promise((res) => setTimeout(res, 10));
    expect(((await core.products.summary(loo.id)).product.fields.pricing as { usualUnitPrice: number }).usualUnitPrice).toBeCloseTo(6.5 / 18, 4);
    const history = route(core, 'pricing', 'GET', '/history/:productId');
    expect(await history.handler({ body: undefined, query: {}, params: { productId: milk.id }, userId: null })).toMatchObject([{ shopId: tesco.id, price: 1.6, quantity: 4 }]);

    // Next time the AI can't place the toilet roll or the milk, but Larder remembers Tesco's names (and 9 rolls a pack).
    answer = {
      ...TESCO,
      date: '2026-11-09',
      lines: [line({ text: 'ANDREX CLASSIC 9PK', count: 3, price: 9.75 }), line({ text: 'TESCO SEMI SKMD 4PT', item: 1, quantity: 1, sure: false })],
    };
    const again = await call<{ lines: Array<{ item: { id: string } | null; quantity: number; match: string }>; addedBefore: string | null }>(core, 'POST', '/receipt', { image: JPEG });
    expect(again.lines).toMatchObject([{ item: { id: loo.id }, quantity: 27, match: 'learnt' }, { item: { id: milk.id }, quantity: 4, match: 'learnt' }]);
    expect(again.addedBefore).toBeNull();
    expect(net.prompts()[1]).toContain('"ANDREX CLASSIC 9PK" at Tesco is item 3, 9 rolls for each one bought');

    // Saved by 0.9.2 as counted in rolls, in packs of 9: the upgrade buys it in packs, so what Tesco's names were learnt as follows.
    await saveAs092(storage, (await core.products.summary(loo.id)).product, { unit: 'roll', pack: { name: 'pack', holds: 9 } });
    const upgraded = await makeCore({ modules: [ai, pricing], fetch: net.fetch, storage });
    await new Promise((res) => setTimeout(res, 10));
    const recounted = await call<{ lines: Array<{ item: { id: string } | null; quantity: number; match: string }> }>(upgraded, 'POST', '/receipt', { image: JPEG });
    expect(recounted.lines[0]).toMatchObject({ item: { id: loo.id }, quantity: 3, match: 'learnt' });
  });

  it('says when the same receipt was added before', async () => {
    const { core, beans, tesco } = await household(() => TESCO);
    const r = await call<{ receiptKey: string }>(core, 'POST', '/receipt', { image: JPEG });
    await call(core, 'POST', '/receipt/add', { shopId: tesco.id, receiptKey: r.receiptKey, lines: [{ productId: beans.id, quantity: 4 }] });
    expect(await call(core, 'POST', '/receipt', { image: JPEG })).toMatchObject({ addedBefore: '2026-10-28T09:00:00.000Z' });
  });

  it('adds lines for the same item together, and adds nothing if one isn\'t an item', async () => {
    const { core, beans } = await household(() => TESCO);
    expect(await call(core, 'POST', '/receipt/add', { lines: [{ productId: beans.id, quantity: 2, price: 1 }, { productId: beans.id, quantity: 1, price: 0.5 }] }))
      .toEqual({ added: 1, message: 'Added Baked beans to stock.' });
    expect((await core.products.summary(beans.id)).inStock).toBe(3);
    await expect(call(core, 'POST', '/receipt/add', { lines: [{ productId: beans.id, quantity: 1 }, { productId: 'nope', quantity: 1 }] })).rejects.toMatchObject({ status: 404 });
    expect((await core.products.summary(beans.id)).inStock).toBe(3);
  });

  it('copes with a photo that isn\'t a receipt, and a shop Larder doesn\'t have', async () => {
    const { core } = await household(() => ({ readable: false, shop: 'Sainsburys', date: 'last Tuesday', total: null, lines: [] }));
    expect(await call(core, 'POST', '/receipt', { image: JPEG })).toMatchObject({
      readable: false, shop: { name: "Sainsbury's", id: null, preset: true }, date: null, lines: [], receiptKey: null, addedBefore: null,
    });
  });

  it('reads receipts with Gemini too', async () => {
    const net = internet(() => TESCO);
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { gemini: { apiKey: 'AIza-test-key-9876', model: 'gemini-3.6-flash' } });
    expect(await call(core, 'POST', '/receipt', { image: JPEG })).toMatchObject({ provider: 'gemini', lines: [{ match: 'none' }, { match: 'none' }, { match: 'none' }, { match: 'none' }, { match: 'none' }] });
    const gen = net.sent.find((r) => r.url.endsWith(':generateContent'))!;
    expect(gen.body).toMatchObject({ generationConfig: { responseSchema: { properties: { lines: { type: 'ARRAY', items: { type: 'OBJECT' } } } } } });
    expect(gen.body).not.toHaveProperty('tools');
  });

  it('lets an assistant add a receipt it has read, by item names', async () => {
    const { core, beans, loo } = await household(() => TESCO);
    const r = await core.assistant.call('add_receipt', {
      shop: 'tesco',
      lines: [{ item: 'beans', quantity: 4, price: 3.5, text: 'HNZ BKD BNZ 4X415G' }, { item: 'loo roll', quantity: 18, price: 6.5, text: 'ANDREX CLASSIC 9PK', count: 2 }],
    });
    expect(r.text).toBe('Added 2 things from Tesco to stock.');
    expect((await core.products.summary(loo.id)).inStock).toBe(18);
    // A line that isn't an item in Larder stops it, so the assistant can leave it out.
    await expect(core.assistant.call('add_receipt', { lines: [{ item: 'beans', quantity: 1 }, { item: 'garlic bread', quantity: 1 }] })).rejects.toThrow('Nothing was added');
    expect((await core.products.summary(beans.id)).inStock).toBe(4);
    // A shop Larder doesn't have doesn't stop it.
    expect((await core.assistant.call('add_receipt', { shop: 'Lidl', lines: [{ item: 'beans', quantity: 1 }] })).text).toBe("Added Baked beans to stock. Larder doesn't have a shop called Lidl, so the prices were kept without one.");
  });

  it('tells the AI what an item is bought in and what one contains, so a box of 80 tea bags is 1 box', () => {
    const lines = householdItems([{ id: 't', name: 'Yorkshire tea', unit: 'box', one: 'box', many: 'boxes', contains: '80 tea bags', aliases: [], brands: [] }], [], () => null);
    expect(lines).toContain('1. Yorkshire tea (bought in boxes, each containing 80 tea bags)');
  });
});
