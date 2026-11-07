import { describe, expect, it } from 'vitest';
import { makeCore } from '../../tests/helpers';
import ai from './index';
import { bestGemini, type Reading } from './providers';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = <T = unknown>(core: Core, method: string, path: string, opts: { body?: unknown; query?: unknown } = {}) =>
  core.modules.routes().find((r) => r.moduleId === 'ai' && r.route.method === method && r.route.path === path)!.route
    .handler({ body: opts.body, query: opts.query ?? {}, params: {}, userId: null }) as Promise<T>;

/** A tiny "JPEG": the right first bytes, then padding. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(7)]).toString('base64');

const BEANS: Reading = {
  readable: true,
  name: 'baked beans',
  kind: 'Baked beans',
  title: 'Tesco Baked Beans in Tomato Sauce',
  size: '4 x 400 g',
  unit: 'tin',
  pack: 'Pack',
  pack_holds: 4,
  category: 'food',
  shelf_life_days: 730,
  shop: 'Tesco',
  other_names: ['beans', 'Baked beans'],
};

interface Sent { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }

type Reply = { status: number; json: unknown } | Record<string, unknown> | undefined;

/**
 * Pretend Claude and Gemini. Records every request; `status` makes every answer fail with that HTTP status.
 * `claude` and `gemini` can answer a request themselves (the nth to that AI, from 0); `claudeCaps` are what the Models API says a model can do.
 */
function internet(o: {
  reading?: Reading; status?: number; message?: string; broken?: Partial<Record<'claude' | 'gemini', { status: number; message: string }>>; claudeModels?: unknown[]; geminiModels?: unknown[];
  claude?: (body: Record<string, unknown>, n: number) => Reply; gemini?: (body: Record<string, unknown>, n: number) => Reply; claudeCaps?: Record<string, unknown>;
} = {}) {
  let claudeAsked = 0;
  let geminiAsked = 0;
  const reply = (r: NonNullable<Reply>) => ('status' in r && 'json' in r && typeof r.status === 'number' ? Response.json(r.json, { status: r.status }) : Response.json(r));
  const sent: Sent[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    sent.push({ url, method: init?.method ?? 'GET', headers, body });
    const u = new URL(url);
    if (o.status) return Response.json({ type: 'error', error: { type: 'authentication_error', message: o.message ?? 'invalid x-api-key', status: 'INVALID_ARGUMENT' } }, { status: o.status });
    const broken = o.broken?.[u.hostname === 'api.anthropic.com' ? 'claude' : 'gemini'];
    if (broken) return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: broken.message } }, { status: broken.status });
    if (u.hostname === 'api.anthropic.com') {
      if (u.pathname === '/v1/models') {
        return Response.json({ data: o.claudeModels ?? [], has_more: false, first_id: null, last_id: null });
      }
      if (u.pathname.startsWith('/v1/models/')) {
        return Response.json({ id: u.pathname.split('/').pop(), type: 'model', display_name: 'Claude', created_at: '2026-01-01T00:00:00Z', capabilities: o.claudeCaps ?? { effort: { supported: true }, image_input: { supported: true }, structured_outputs: { supported: true } } });
      }
      if (u.pathname === '/v1/messages') {
        const mine = o.claude?.(body!, claudeAsked++);
        if (mine) return reply(mine);
        return Response.json({
          id: 'msg_1', type: 'message', role: 'assistant', model: String(body?.model), stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: JSON.stringify(o.reading ?? BEANS) }],
          usage: { input_tokens: 1800, output_tokens: 120 },
        });
      }
    }
    if (u.hostname === 'generativelanguage.googleapis.com') {
      if (u.pathname === '/v1beta/models') return Response.json({ models: o.geminiModels ?? [] });
      if (u.pathname.endsWith(':generateContent')) {
        const mine = o.gemini?.(body!, geminiAsked++);
        if (mine) return reply(mine);
        return Response.json({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(o.reading ?? BEANS) }] } }] });
      }
    }
    throw new Error(`No network in tests (${url})`);
  }) as unknown as typeof fetch;
  return { fetch: fake, sent };
}

const CLAUDE_KEY = 'sk-ant-test-0000-wxyz';
const GEMINI_KEY = 'AIza-test-key-9876';

describe('AI module: settings', () => {
  it('starts with nothing set up', async () => {
    const core = await makeCore({ modules: [ai] });
    expect(await call(core, 'GET', '/')).toEqual({
      ready: false, order: ['claude', 'gemini'], first: null, search: true, barcodes: true,
      claude: { enabled: true, keySet: false, keyHint: null, keyFrom: null, model: null },
      gemini: { enabled: true, keySet: false, keyHint: null, keyFrom: null, model: null },
    });
    await expect(call(core, 'POST', '/identify', { body: { image: JPEG } })).rejects.toMatchObject({ status: 409, code: 'ai_not_set_up' });
  });

  it('keeps a key and model for each AI, and never sends a key back', async () => {
    const core = await makeCore({ modules: [ai] });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5' }, gemini: { apiKey: GEMINI_KEY } } });
    const s = await call(core, 'GET', '/');
    expect(s).toMatchObject({
      ready: true, first: 'claude',
      claude: { enabled: true, keySet: true, keyHint: '…wxyz', keyFrom: 'app', model: 'claude-sonnet-5-5' },
      gemini: { enabled: true, keySet: true, keyHint: '…9876', keyFrom: 'app', model: null },
    });
    expect(JSON.stringify(s)).not.toContain(CLAUDE_KEY);
    expect(JSON.stringify(s)).not.toContain(GEMINI_KEY);
    // null forgets a model or a key.
    await call(core, 'PUT', '/settings', { body: { claude: { model: null }, gemini: { apiKey: null } } });
    expect(await call(core, 'GET', '/')).toMatchObject({ claude: { keySet: true, model: null }, gemini: { keySet: false } });
  });

  it('asks the AIs in the household\'s order, and an AI switched off keeps its key and model', async () => {
    const core = await makeCore({ modules: [ai] });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5' }, gemini: { apiKey: GEMINI_KEY } } });
    expect(await call(core, 'PUT', '/settings', { body: { order: ['gemini'] } })).toMatchObject({ order: ['gemini', 'claude'], first: 'gemini' });

    await call(core, 'PUT', '/settings', { body: { gemini: { enabled: false } } });
    expect(await call(core, 'GET', '/')).toMatchObject({ ready: true, order: ['gemini', 'claude'], first: 'claude', gemini: { enabled: false, keySet: true } });
    await call(core, 'PUT', '/settings', { body: { claude: { enabled: false } } });
    expect(await call(core, 'GET', '/')).toMatchObject({ ready: false, first: null, claude: { enabled: false, keySet: true, model: 'claude-sonnet-5-5' } });
    await expect(call(core, 'POST', '/identify', { body: { image: JPEG } })).rejects.toMatchObject({ status: 409, code: 'ai_not_set_up' });

    await call(core, 'PUT', '/settings', { body: { claude: { enabled: true }, gemini: { enabled: true } } });
    expect(await call(core, 'GET', '/')).toMatchObject({ ready: true, first: 'gemini', claude: { enabled: true, keyHint: '…wxyz', model: 'claude-sonnet-5-5' } });
  });

  it('skips an AI without a key', async () => {
    const core = await makeCore({ modules: [ai] });
    await call(core, 'PUT', '/settings', { body: { gemini: { apiKey: GEMINI_KEY } } });
    expect(await call(core, 'GET', '/')).toMatchObject({ ready: true, order: ['claude', 'gemini'], first: 'gemini' });
  });

  it('takes a key from the environment when none is saved', async () => {
    const core = await makeCore({ modules: [ai], env: { LARDER_MODULE_AI_GEMINI_API_KEY: GEMINI_KEY } });
    expect(await call(core, 'GET', '/')).toMatchObject({ ready: true, first: 'gemini', gemini: { keySet: true, keyFrom: 'env', keyHint: '…9876' } });
  });

  it('turns away keys, model names and orders that are obviously wrong', async () => {
    const core = await makeCore({ modules: [ai] });
    const route = core.modules.routes().find((r) => r.moduleId === 'ai' && r.route.path === '/settings')!.route;
    expect(route.admin).toBe(true);
    expect(route.body!.safeParse({ claude: { apiKey: 'short' } }).success).toBe(false);
    expect(route.body!.safeParse({ claude: { apiKey: 'has a space in it' } }).success).toBe(false);
    expect(route.body!.safeParse({ claude: { model: 'claude; rm -rf' } }).success).toBe(false);
    expect(route.body!.safeParse({ order: ['openai'] }).success).toBe(false);
    expect(route.body!.safeParse({ order: ['claude', 'claude'] }).success).toBe(false);
    expect(route.body!.safeParse({ order: [] }).success).toBe(false);
  });
});

describe('AI module: when one AI can\'t', () => {
  it('asks the next, and says which couldn\'t and why', async () => {
    const net = internet({ broken: { claude: { status: 400, message: 'Your credit balance is too low to access the Anthropic API.' } } });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' }, gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
    const out = await call<{ provider: string; model: string; skipped: Array<{ provider: string; message: string }> }>(core, 'POST', '/identify', { body: { image: JPEG } });
    expect(out.provider).toBe('gemini');
    expect(out.model).toBe('gemini-3.6-flash');
    expect(out.skipped).toEqual([{ provider: 'claude', message: expect.stringContaining('credit balance is too low') }]);
    expect(net.sent.map((r) => new URL(r.url).hostname)).toEqual(['api.anthropic.com', 'api.anthropic.com', 'generativelanguage.googleapis.com']);
  });

  it('doesn\'t ask the next once one has answered, or one that\'s switched off', async () => {
    const net = internet();
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { order: ['gemini'], claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' }, gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
    expect(await call(core, 'POST', '/identify', { body: { image: JPEG } })).toMatchObject({ provider: 'gemini', skipped: [] });
    expect(net.sent.every((r) => r.url.includes('googleapis'))).toBe(true);

    const off = internet({ broken: { gemini: { status: 500, message: 'Internal error' } } });
    const core2 = await makeCore({ modules: [ai], fetch: off.fetch });
    await call(core2, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, enabled: false }, gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
    await expect(call(core2, 'POST', '/identify', { body: { image: JPEG } })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Internal error') });
    expect(off.sent.some((r) => r.url.includes('anthropic'))).toBe(false);
  });

  it('says what each said when none can', async () => {
    const net = internet({ broken: { claude: { status: 529, message: 'Overloaded' }, gemini: { status: 429, message: 'Quota exceeded' } } });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' }, gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
    const err = (await call(core, 'POST', '/identify', { body: { image: JPEG } }).catch((e: unknown) => e)) as { status: number; message: string };
    expect(err.message).toContain('Overloaded');
    expect(err.message).toContain('Quota exceeded');
    expect(err.status).toBe(429);
  });

  it('never asks any AI about something that isn\'t a photo', async () => {
    const net = internet();
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY }, gemini: { apiKey: GEMINI_KEY } } });
    await expect(call(core, 'POST', '/identify', { body: { image: Buffer.from('<html>'.padEnd(200, 'x')).toString('base64') } })).rejects.toMatchObject({ status: 400 });
    expect(net.sent).toHaveLength(0);
  });
});

describe('AI module: Claude', () => {
  it('reads a photo with the default model and puts the answer in Larder\'s terms', async () => {
    const net = internet();
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY } } });
    const food = (await core.categories.list()).find((c) => c.name === 'Food')!;

    const out = await call(core, 'POST', '/identify', { body: { image: JPEG } });
    expect(out).toEqual({
      readable: true,
      name: 'Baked beans',
      // The same as the name, so no kind; no name twice among the other names either.
      kind: null,
      brand: 'Tesco Baked Beans in Tomato Sauce 4 x 400 g',
      unit: 'tin',
      pack: { name: 'pack', holds: 4 },
      categoryId: food.id,
      shelfLifeDays: 730,
      aliases: ['beans'],
      shop: { name: 'Tesco', id: null, preset: true },
      provider: 'claude',
      model: 'claude-haiku-5-5',
      sources: [],
      skipped: [],
    });

    const msg = net.sent.find((r) => r.url.endsWith('/v1/messages'))!;
    expect(msg.headers.authorization).toBe(`Bearer ${CLAUDE_KEY}`);
    expect(msg.body).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'low', format: { type: 'json_schema' } } });
    const content = (msg.body!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } });
    expect(String(content[1]!.text)).toContain('"Food"');
    // The default model is remembered.
    expect(await call(core, 'GET', '/')).toMatchObject({ claude: { model: 'claude-haiku-5-5' } });
  });

  it('matches a shop the household already has, and uses the chosen model', async () => {
    const net = internet({ reading: { ...BEANS, shop: 'sainsburys', title: null, size: '1 L', category: 'Nonsense' } });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    const shop = await core.shops.addPreset("Sainsbury's");
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5' } } });
    const out = await call<{ shop: unknown; brand: string | null; categoryId: string | null; model: string }>(core, 'POST', '/identify', { body: { image: PNG } });
    expect(out.shop).toEqual({ name: "Sainsbury's", id: shop.id, preset: false });
    expect(out.brand).toBe('1 L');
    expect(out.categoryId).toBeNull();
    expect(out.model).toBe('claude-sonnet-5-5');

    // A size the title already gives isn't repeated.
    const again = await makeCore({ modules: [ai], fetch: internet({ reading: { ...BEANS, title: 'Heinz Beanz 415g', size: '415 g' } }).fetch });
    await call(again, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' } } });
    expect((await call<{ brand: string }>(again, 'POST', '/identify', { body: { image: JPEG } })).brand).toBe('Heinz Beanz 415g');
    const msg = net.sent.find((r) => r.url.endsWith('/v1/messages'))!;
    expect(((msg.body!.messages as Array<{ content: Array<{ source?: { media_type: string } }> }>)[0]!.content[0]!.source!.media_type)).toBe('image/png');
  });

  it('says plainly when Claude turns the key down', async () => {
    const core = await makeCore({ modules: [ai], fetch: internet({ status: 401 }).fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' } } });
    await expect(call(core, 'POST', '/identify', { body: { image: JPEG } })).rejects.toMatchObject({ status: 400, code: 'ai_key', message: expect.stringContaining('Settings → AI') });
  });

  it('lists only the models that can read photos', async () => {
    const yes = { image_input: { supported: true }, structured_outputs: { supported: true }, effort: { supported: true } };
    const net = internet({
      claudeModels: [
        { id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', capabilities: yes },
        { id: 'claude-haiku-5-5', type: 'model', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z', capabilities: yes },
        { id: 'claude-text-only', type: 'model', display_name: 'Text only', created_at: '2026-01-01T00:00:00Z', capabilities: { ...yes, image_input: { supported: false } } },
      ],
    });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await expect(call(core, 'GET', '/models', { query: { provider: 'claude' } })).rejects.toMatchObject({ status: 409 });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY } } });
    expect(await call(core, 'GET', '/models', { query: { provider: 'claude' } })).toEqual({
      models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }],
      default: 'claude-haiku-5-5',
    });
  });
});

describe('AI module: Gemini', () => {
  const MODELS = [
    { name: 'models/gemini-3.5-pro', displayName: 'Gemini 3.5 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-3.6-flash-lite', displayName: 'Gemini 3.6 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.6-flash-image', displayName: 'Nano Banana', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-002', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/imagen-5', displayName: 'Imagen', supportedGenerationMethods: ['predict'] },
  ];

  it('picks the newest Flash model, reads the photo and remembers the model', async () => {
    const net = internet({ geminiModels: MODELS });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { order: ['gemini'], gemini: { apiKey: GEMINI_KEY } } });
    const out = await call<{ name: string; model: string; provider: string }>(core, 'POST', '/identify', { body: { image: JPEG } });
    expect(out).toMatchObject({ name: 'Baked beans', provider: 'gemini', model: 'gemini-3.6-flash' });

    const gen = net.sent.find((r) => r.url.endsWith(':generateContent'))!;
    expect(gen.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    expect(gen.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    expect(gen.url).not.toContain(GEMINI_KEY);
    expect(gen.body).toMatchObject({
      contents: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: JPEG } }, { text: expect.stringContaining('"Food"') }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } },
    });
    expect(await call(core, 'GET', '/')).toMatchObject({ gemini: { model: 'gemini-3.6-flash' } });
  });

  it('lists models that can read photos, newest first', async () => {
    const core = await makeCore({ modules: [ai], fetch: internet({ geminiModels: MODELS }).fetch });
    await call(core, 'PUT', '/settings', { body: { gemini: { apiKey: GEMINI_KEY } } });
    const r = await call<{ models: Array<{ id: string }>; default: string }>(core, 'GET', '/models', { query: { provider: 'gemini' } });
    expect(r.models.map((m) => m.id)).toEqual(['gemini-3.6-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-pro']);
    expect(r.default).toBe('gemini-3.6-flash');
  });

  it('says plainly when Gemini turns the key down', async () => {
    // Google answers a bad key with 400 "API key not valid".
    const core = await makeCore({ modules: [ai], fetch: internet({ status: 400, message: 'API key not valid. Please pass a valid API key.' }).fetch });
    await call(core, 'PUT', '/settings', { body: { order: ['gemini'], gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
    await expect(call(core, 'POST', '/identify', { body: { image: JPEG } })).rejects.toMatchObject({ status: 400, code: 'ai_key' });
    // Anything else comes back with what Gemini said.
    const other = await makeCore({ modules: [ai], fetch: internet({ status: 500, message: 'Internal error' }).fetch });
    await call(other, 'PUT', '/settings', { body: { order: ['gemini'], gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
    await expect(call(other, 'POST', '/identify', { body: { image: JPEG } })).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Internal error') });
  });

  it('chooses sensibly among model names it has never seen', () => {
    const m = (...ids: string[]) => ids.map((id) => ({ id, name: id }));
    expect(bestGemini(m('gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash'))).toBe('gemini-2.5-flash');
    expect(bestGemini(m('gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'))).toBe('gemini-3-flash-preview');
    expect(bestGemini(m('gemini-4-flash', 'gemini-3.6-flash', 'gemini-4-flash-lite'))).toBe('gemini-4-flash');
    expect(bestGemini([])).toBe('gemini-flash-latest');
  });
});

describe('AI module: barcodes found online', () => {
  const PG: Reading = {
    readable: true, name: 'PG Tips tea bags', kind: 'Black tea', title: 'PG Tips Original', size: '80 tea bags 232 g', unit: 'tea bag', pack: 'Boxes', pack_holds: 80,
    category: 'Food', shelf_life_days: 540, shop: null, other_names: ['tea bags'],
  };
  const FOUND = { barcode: '8720608023402', name: 'PG tips original 80 pyramid tea bags', brand: 'PG Tips', quantityText: '232 g', categories: ['Beverages', 'Teas', 'Black teas'] };

  it('works out what a barcode is from what was found: counted in tea bags, comes in a box of 80', async () => {
    const net = internet({ reading: PG });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY } } });
    const out = await call(core, 'POST', '/describe', { body: FOUND });
    expect(out).toMatchObject({ name: 'PG Tips tea bags', unit: 'tea bag', pack: { name: 'box', holds: 80 }, brand: 'PG Tips Original 80 tea bags 232 g', shelfLifeDays: 540, provider: 'claude' });

    // What was found goes as text, before the request; no photo.
    const msg = net.sent.find((r) => r.url.endsWith('/v1/messages'))!;
    const content = (msg.body!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    expect(content[0]).toEqual({ type: 'text', text: 'Barcode: 8720608023402\nName: PG tips original 80 pyramid tea bags\nBrand: PG Tips\nQuantity: 232 g\nCategories: Beverages, Teas, Black teas' });
    const prompt = String(content[1]!.text);
    expect(prompt).toContain('an online product database says the above about it');
    expect(prompt).toContain('a box of tea bags is counted in tea bags');
    expect(prompt).toContain('You can search the web, at most 2 times, for the barcode or the product');
  });

  it('can be switched off, and leaves out a pack that holds one or is what it is counted in', async () => {
    let reading: Reading = { ...PG, unit: 'box', pack: 'box', pack_holds: 80 };
    const net = internet({ claude: () => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: JSON.stringify(reading) }], usage: { input_tokens: 1, output_tokens: 1 } }) });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await expect(call(core, 'POST', '/describe', { body: FOUND })).rejects.toThrow('Switch on Claude or Gemini in Settings → AI, with an API key, to read barcode results.');
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY } } });
    expect(await call(core, 'POST', '/describe', { body: FOUND })).toMatchObject({ unit: 'box', pack: null });
    reading = { ...PG, pack_holds: 1 };
    expect(await call(core, 'POST', '/describe', { body: FOUND })).toMatchObject({ unit: 'tea bag', pack: null });

    expect(await call(core, 'PUT', '/settings', { body: { barcodes: false } })).toMatchObject({ barcodes: false });
    await expect(call(core, 'POST', '/describe', { body: FOUND })).rejects.toThrow('Read barcode results with AI is off in Settings → AI.');
  });

  it('counts what is inside a box when reading a photo too', async () => {
    const net = internet();
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY } } });
    await call(core, 'POST', '/identify', { body: { image: JPEG } });
    const msg = net.sent.find((r) => r.url.endsWith('/v1/messages'))!;
    const prompt = String((msg.body!.messages as Array<{ content: Array<{ text?: string }> }>)[0]!.content[1]!.text);
    expect(prompt).toContain('This is a photo of something being put away at home.');
    expect(prompt).toContain("Never a box, multipack or case of separate things: count what's inside it");
    expect(prompt).toContain('- pack_holds: how many of unit one pack holds');
  });
});

describe('AI module: looking it up online', () => {
  const SLEEP: Reading = {
    readable: true, name: 'Twinings Sleep tea bags', kind: 'Herbal tea', title: 'Twinings Sleep', size: '20 tea bags', unit: 'tea bag', pack: 'box', pack_holds: 20,
    category: 'food', shelf_life_days: 540, shop: null, other_names: ['sleep tea'],
  };
  const TWININGS = 'https://www.twinings.co.uk/products/sleep';
  const TESCO = 'https://www.tesco.com/groceries/en-GB/products/123';
  const searched = (id: string) => [
    { type: 'server_tool_use', id, name: 'web_search', input: { query: 'Twinings Sleep tea bags' } },
    {
      type: 'web_search_tool_result', tool_use_id: id, content: [
        { type: 'web_search_result', url: TWININGS, title: 'Sleep | Twinings', encrypted_content: 'abc', page_age: null },
        { type: 'web_search_result', url: TESCO, title: 'Twinings Sleep 20 Tea Bags', encrypted_content: 'def', page_age: null },
        { type: 'web_search_result', url: 'https://www.example.com/tea', title: 'Tea', encrypted_content: 'ghi', page_age: null },
      ],
    },
  ];
  const message = (content: unknown[], stop = 'end_turn') => ({
    id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: stop, stop_sequence: null, content,
    usage: { input_tokens: 9000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } },
  });
  const messages = (net: ReturnType<typeof internet>) => net.sent.filter((r) => r.url.endsWith('/v1/messages')).map((r) => r.body!);
  const promptOf = (body: Record<string, unknown>) => String((body.messages as Array<{ content: Array<{ text?: string }> }>)[0]!.content[1]!.text);

  it('lets Claude search the web, and reads a cited answer that comes in pieces after the search', async () => {
    const json = JSON.stringify(SLEEP);
    const net = internet({
      claude: () => message([
        { type: 'text', text: "I'll check the pack size." },
        ...searched('srvtoolu_1'),
        { type: 'text', text: json.slice(0, 40), citations: null },
        { type: 'text', text: json.slice(40, 90), citations: [{ type: 'web_search_result_location', url: TWININGS, title: 'Sleep | Twinings', encrypted_index: 'x', cited_text: '20 tea bags' }] },
        { type: 'text', text: json.slice(90), citations: null },
      ]),
    });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY } } });
    const out = await call(core, 'POST', '/identify', { body: { image: JPEG } });
    expect(out).toMatchObject({
      name: 'Twinings Sleep tea bags',
      kind: 'Herbal tea',
      brand: 'Twinings Sleep 20 tea bags',
      unit: 'tea bag',
      pack: { name: 'box', holds: 20 },
      aliases: ['Herbal tea', 'sleep tea'],
      shop: null,
      sources: [{ name: 'twinings.co.uk', url: TWININGS }],
    });

    const [body] = messages(net);
    expect(body!.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 2, user_location: { type: 'approximate', country: 'GB', timezone: 'Europe/London' } }]);
    expect(promptOf(body!)).toContain('You can search the web, at most 2 times');
    expect(promptOf(body!)).toContain('never only the kind of thing ("Herbal tea"');
    expect(promptOf(body!)).toContain('"Twinings Sleep tea bags"');
  });

  it('carries on a search Claude paused, and names the pages it found when it cited none', async () => {
    const net = internet({
      claude: (_, n) => (n === 0 ? message(searched('srvtoolu_2'), 'pause_turn') : message([{ type: 'text', text: JSON.stringify(SLEEP) }])),
    });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' } } });
    const out = await call<{ name: string; sources: unknown[] }>(core, 'POST', '/identify', { body: { image: JPEG } });
    expect(out.name).toBe('Twinings Sleep tea bags');
    expect(out.sources).toEqual([{ name: 'twinings.co.uk', url: TWININGS }, { name: 'tesco.com', url: TESCO }]);

    const sent = messages(net);
    expect(sent).toHaveLength(2);
    // The paused turn goes back as it came, with the same tools, and nothing added.
    expect(sent[1]!.messages).toEqual([(sent[0]!.messages as unknown[])[0], { role: 'assistant', content: searched('srvtoolu_2') }]);
    expect(sent[1]!.tools).toEqual(sent[0]!.tools);
  });

  it('reads the photo without searching when Claude turns the search down, and doesn\'t ask that model to search again', async () => {
    const net = internet({
      claude: (body) => (body.tools ? { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'Web search is not enabled for this organization.' } } } : undefined),
    });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' } } });
    expect(await call(core, 'POST', '/identify', { body: { image: JPEG } })).toMatchObject({ name: 'Baked beans', sources: [], skipped: [] });
    await call(core, 'POST', '/identify', { body: { image: JPEG } });

    const sent = messages(net);
    expect(sent.map((b) => !!b.tools)).toEqual([true, false, false]);
    expect(promptOf(sent[1]!)).not.toContain('search the web');
    expect(promptOf(sent[1]!)).toContain('never only the kind of thing');
  });

  it('doesn\'t offer Claude a search its model can\'t do', async () => {
    const net = internet({ claudeCaps: { effort: { supported: true }, image_input: { supported: true }, structured_outputs: { supported: true }, server_tools: { supported: true, code_execution: { supported: false }, web_search: { supported: false } } } });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-older' } } });
    await call(core, 'POST', '/identify', { body: { image: JPEG } });
    expect(messages(net)[0]).not.toHaveProperty('tools');
  });

  it('lets Gemini search with Google, and names each site once', async () => {
    const redirect = (x: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${x}`;
    const net = internet({
      gemini: () => ({
        candidates: [{
          finishReason: 'STOP',
          content: { role: 'model', parts: [{ text: JSON.stringify(SLEEP) }] },
          groundingMetadata: { groundingChunks: [{ web: { uri: redirect('a'), title: 'twinings.co.uk' } }, { web: { uri: redirect('b'), title: 'twinings.co.uk' } }, { web: { uri: redirect('c'), title: 'tesco.com' } }] },
        }],
      }),
    });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { order: ['gemini'], gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
    expect(await call(core, 'POST', '/identify', { body: { image: JPEG } })).toMatchObject({
      name: 'Twinings Sleep tea bags', provider: 'gemini', sources: [{ name: 'twinings.co.uk', url: redirect('a') }, { name: 'tesco.com', url: redirect('c') }],
    });
    const gen = net.sent.find((r) => r.url.endsWith(':generateContent'))!;
    expect(gen.body).toMatchObject({ tools: [{ google_search: {} }], generationConfig: { responseMimeType: 'application/json' } });
  });

  it('reads the photo without searching on a Gemini model that can\'t search and answer in a schema at once', async () => {
    const net = internet({
      gemini: (body) => (body.tools ? { status: 400, json: { error: { code: 400, message: "Tool use with a response mime type: 'application/json' is unsupported", status: 'INVALID_ARGUMENT' } } } : undefined),
    });
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { order: ['gemini'], gemini: { apiKey: GEMINI_KEY, model: 'gemini-2.5-flash' } } });
    expect(await call(core, 'POST', '/identify', { body: { image: JPEG } })).toMatchObject({ name: 'Baked beans', provider: 'gemini', sources: [], skipped: [] });
    await call(core, 'POST', '/identify', { body: { image: JPEG } });
    expect(net.sent.filter((r) => r.url.endsWith(':generateContent')).map((r) => !!r.body!.tools)).toEqual([true, false, false]);
  });

  it('never searches once the household switches it off', async () => {
    const net = internet();
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' }, gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
    expect(await call(core, 'PUT', '/settings', { body: { search: false } })).toMatchObject({ search: false, first: 'claude' });
    // Changing something else keeps it off.
    expect(await call(core, 'PUT', '/settings', { body: { order: ['gemini'] } })).toMatchObject({ search: false });
    await call(core, 'POST', '/identify', { body: { image: JPEG } });
    await call(core, 'PUT', '/settings', { body: { order: ['claude'] } });
    await call(core, 'POST', '/identify', { body: { image: JPEG } });

    const gen = net.sent.find((r) => r.url.endsWith(':generateContent'))!;
    expect(gen.body).not.toHaveProperty('tools');
    expect(JSON.stringify(gen.body)).not.toContain('search the web');
    const [msg] = messages(net);
    expect(msg).not.toHaveProperty('tools');
    expect(promptOf(msg!)).not.toContain('search the web');

    expect(await call(core, 'PUT', '/settings', { body: { search: true } })).toMatchObject({ search: true });
  });
});

describe('AI module: photos', () => {
  it('only sends real photos', async () => {
    const net = internet();
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' } } });
    const text = Buffer.from('<html>'.padEnd(200, 'x')).toString('base64');
    await expect(call(core, 'POST', '/identify', { body: { image: text } })).rejects.toMatchObject({ status: 400 });
    await expect(call(core, 'POST', '/identify', { body: { image: `${JPEG}$$$` } })).rejects.toMatchObject({ status: 400 });
    // A data: address is fine.
    await expect(call(core, 'POST', '/identify', { body: { image: `data:image/jpeg;base64,${JPEG}` } })).resolves.toMatchObject({ name: 'Baked beans' });
    expect(net.sent.filter((r) => r.url.endsWith('/v1/messages'))).toHaveLength(1);
  });
});
