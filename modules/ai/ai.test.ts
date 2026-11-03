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
  title: 'Tesco Baked Beans in Tomato Sauce',
  size: '4 x 400 g',
  unit: 'tin',
  category: 'food',
  shelf_life_days: 730,
  shop: 'Tesco',
  other_names: ['beans', 'Baked beans'],
};

interface Sent { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }

/** Pretend Claude and Gemini. Records every request; `status` makes every answer fail with that HTTP status. */
function internet(o: { reading?: Reading; status?: number; message?: string; claudeModels?: unknown[]; geminiModels?: unknown[] } = {}) {
  const sent: Sent[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    sent.push({ url, method: init?.method ?? 'GET', headers, body });
    const u = new URL(url);
    if (o.status) return Response.json({ type: 'error', error: { type: 'authentication_error', message: o.message ?? 'invalid x-api-key', status: 'INVALID_ARGUMENT' } }, { status: o.status });
    if (u.hostname === 'api.anthropic.com') {
      if (u.pathname === '/v1/models') {
        return Response.json({ data: o.claudeModels ?? [], has_more: false, first_id: null, last_id: null });
      }
      if (u.pathname.startsWith('/v1/models/')) {
        return Response.json({ id: u.pathname.split('/').pop(), type: 'model', display_name: 'Claude', created_at: '2026-01-01T00:00:00Z', capabilities: { effort: { supported: true }, image_input: { supported: true }, structured_outputs: { supported: true } } });
      }
      if (u.pathname === '/v1/messages') {
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
      provider: null, ready: false,
      claude: { keySet: false, keyHint: null, keyFrom: null, model: null },
      gemini: { keySet: false, keyHint: null, keyFrom: null, model: null },
    });
    await expect(call(core, 'POST', '/identify', { body: { image: JPEG } })).rejects.toMatchObject({ status: 409, code: 'ai_not_set_up' });
  });

  it('keeps a key and model for each AI, and never sends a key back', async () => {
    const core = await makeCore({ modules: [ai] });
    await call(core, 'PUT', '/settings', { body: { provider: 'claude', claude: { apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5' }, gemini: { apiKey: GEMINI_KEY } } });
    const s = await call(core, 'GET', '/');
    expect(s).toMatchObject({
      provider: 'claude', ready: true,
      claude: { keySet: true, keyHint: '…wxyz', keyFrom: 'app', model: 'claude-sonnet-5-5' },
      gemini: { keySet: true, keyHint: '…9876', keyFrom: 'app', model: null },
    });
    expect(JSON.stringify(s)).not.toContain(CLAUDE_KEY);
    expect(JSON.stringify(s)).not.toContain(GEMINI_KEY);

    // Switching AI keeps the other's key and model; null forgets one.
    await call(core, 'PUT', '/settings', { body: { provider: 'gemini', claude: { model: null } } });
    expect(await call(core, 'GET', '/')).toMatchObject({ provider: 'gemini', ready: true, claude: { keySet: true, model: null } });
    await call(core, 'PUT', '/settings', { body: { gemini: { apiKey: null } } });
    expect(await call(core, 'GET', '/')).toMatchObject({ provider: 'gemini', ready: false, gemini: { keySet: false } });
  });

  it('takes a key from the environment when none is saved', async () => {
    const core = await makeCore({ modules: [ai], env: { LARDER_MODULE_AI_GEMINI_API_KEY: GEMINI_KEY } });
    await call(core, 'PUT', '/settings', { body: { provider: 'gemini' } });
    expect(await call(core, 'GET', '/')).toMatchObject({ ready: true, gemini: { keySet: true, keyFrom: 'env', keyHint: '…9876' } });
  });

  it('turns away keys and model names that are obviously wrong', async () => {
    const core = await makeCore({ modules: [ai] });
    const route = core.modules.routes().find((r) => r.moduleId === 'ai' && r.route.path === '/settings')!.route;
    expect(route.admin).toBe(true);
    expect(route.body!.safeParse({ claude: { apiKey: 'short' } }).success).toBe(false);
    expect(route.body!.safeParse({ claude: { apiKey: 'has a space in it' } }).success).toBe(false);
    expect(route.body!.safeParse({ claude: { model: 'claude; rm -rf' } }).success).toBe(false);
    expect(route.body!.safeParse({ provider: 'openai' }).success).toBe(false);
  });
});

describe('AI module: Claude', () => {
  it('reads a photo with the default model and puts the answer in Larder\'s terms', async () => {
    const net = internet();
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { provider: 'claude', claude: { apiKey: CLAUDE_KEY } } });
    const food = (await core.categories.list()).find((c) => c.name === 'Food')!;

    const out = await call(core, 'POST', '/identify', { body: { image: JPEG } });
    expect(out).toEqual({
      readable: true,
      name: 'Baked beans',
      brand: 'Tesco Baked Beans in Tomato Sauce 4 x 400 g',
      unit: 'tin',
      categoryId: food.id,
      shelfLifeDays: 730,
      aliases: ['beans'],
      shop: { name: 'Tesco', id: null, preset: true },
      provider: 'claude',
      model: 'claude-haiku-5-5',
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
    await call(core, 'PUT', '/settings', { body: { provider: 'claude', claude: { apiKey: CLAUDE_KEY, model: 'claude-sonnet-5-5' } } });
    const out = await call<{ shop: unknown; brand: string | null; categoryId: string | null; model: string }>(core, 'POST', '/identify', { body: { image: PNG } });
    expect(out.shop).toEqual({ name: "Sainsbury's", id: shop.id, preset: false });
    expect(out.brand).toBe('1 L');
    expect(out.categoryId).toBeNull();
    expect(out.model).toBe('claude-sonnet-5-5');

    // A size the title already gives isn't repeated.
    const again = await makeCore({ modules: [ai], fetch: internet({ reading: { ...BEANS, title: 'Heinz Beanz 415g', size: '415 g' } }).fetch });
    await call(again, 'PUT', '/settings', { body: { provider: 'claude', claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' } } });
    expect((await call<{ brand: string }>(again, 'POST', '/identify', { body: { image: JPEG } })).brand).toBe('Heinz Beanz 415g');
    const msg = net.sent.find((r) => r.url.endsWith('/v1/messages'))!;
    expect(((msg.body!.messages as Array<{ content: Array<{ source?: { media_type: string } }> }>)[0]!.content[0]!.source!.media_type)).toBe('image/png');
  });

  it('says plainly when Claude turns the key down', async () => {
    const core = await makeCore({ modules: [ai], fetch: internet({ status: 401 }).fetch });
    await call(core, 'PUT', '/settings', { body: { provider: 'claude', claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' } } });
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
    await call(core, 'PUT', '/settings', { body: { provider: 'gemini', gemini: { apiKey: GEMINI_KEY } } });
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
    await call(core, 'PUT', '/settings', { body: { provider: 'gemini', gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
    await expect(call(core, 'POST', '/identify', { body: { image: JPEG } })).rejects.toMatchObject({ status: 400, code: 'ai_key' });
    // Anything else comes back with what Gemini said.
    const other = await makeCore({ modules: [ai], fetch: internet({ status: 500, message: 'Internal error' }).fetch });
    await call(other, 'PUT', '/settings', { body: { provider: 'gemini', gemini: { apiKey: GEMINI_KEY, model: 'gemini-3.6-flash' } } });
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

describe('AI module: photos', () => {
  it('only sends real photos', async () => {
    const net = internet();
    const core = await makeCore({ modules: [ai], fetch: net.fetch });
    await call(core, 'PUT', '/settings', { body: { provider: 'claude', claude: { apiKey: CLAUDE_KEY, model: 'claude-haiku-5-5' } } });
    const text = Buffer.from('<html>'.padEnd(200, 'x')).toString('base64');
    await expect(call(core, 'POST', '/identify', { body: { image: text } })).rejects.toMatchObject({ status: 400 });
    await expect(call(core, 'POST', '/identify', { body: { image: `${JPEG}$$$` } })).rejects.toMatchObject({ status: 400 });
    // A data: address is fine.
    await expect(call(core, 'POST', '/identify', { body: { image: `data:image/jpeg;base64,${JPEG}` } })).resolves.toMatchObject({ name: 'Baked beans' });
    expect(net.sent.filter((r) => r.url.endsWith('/v1/messages'))).toHaveLength(1);
  });
});
