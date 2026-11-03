/**
 * The two AI services the module can use to read a photo: Claude (Anthropic)
 * and Gemini (Google). Each lists the models that can read photos and turns a
 * photo into a `Reading`. Both reach the internet only through the `fetch`
 * they're given, so tests can stand in for them.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { LarderError } from '@larder/core';

export type ProviderId = 'claude' | 'gemini';
export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude', gemini: 'Gemini' };

/** What the AI read from the photo. Field names are snake_case because that's what the models are asked for. */
export const Reading = z.object({
  readable: z.boolean().describe('False if the photo does not show a product you can make out'),
  name: z.string().describe('Plain generic name without brand or size, e.g. "Baked beans"'),
  title: z.string().nullable().describe('The product as named on the pack, with its brand, e.g. "Heinz Baked Beanz"'),
  size: z.string().nullable().describe('Pack size as printed, e.g. "415 g", "4 x 415 g", "9 rolls"'),
  unit: z.string().describe('What one of these is counted in at home, e.g. tin, roll, bottle, each'),
  category: z.string().nullable().describe('One of the household\'s categories, exactly as given'),
  shelf_life_days: z.number().nullable().describe('Roughly how many whole days it keeps unopened, for things that go off'),
  shop: z.string().nullable().describe('The shop, if this is a shop\'s own brand, e.g. "Tesco"'),
  other_names: z.array(z.string()).describe('Up to three other names people use for it'),
});
export type Reading = z.infer<typeof Reading>;

export interface Photo {
  /** Base64, no data: prefix. */
  data: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export interface ModelChoice {
  id: string;
  name: string;
}

export const UNITS = ['each', 'pack', 'roll', 'tin', 'bottle', 'bag', 'box', 'jar', 'carton', 'tablet', 'dose', 'pair', 'battery', 'L', 'ml', 'kg', 'g', 'm'];

const SYSTEM = 'You read photos of things being put away at home, for a UK household inventory app called Larder. Read the packaging and say what the item is. Use UK English and UK product names.';

/** The request that goes with the photo. The household's own categories, so the answer uses one of them. */
export function instructions(categories: string[]): string {
  return [
    'What is this? Fill in each field:',
    '- name: a plain generic name a person would search for, without brand or size, in sentence case, e.g. "Baked beans", "Toilet roll", "AA batteries", "Dog food".',
    '- title: the product as named on the pack, with its brand, e.g. "Heinz Baked Beanz in Tomato Sauce". Null if no brand or product name is visible.',
    '- size: the pack size as printed, e.g. "415 g", "4 x 415 g", "9 rolls", "1 L". Null if it is not visible.',
    `- unit: what one of these is counted in at home. One of: ${UNITS.join(', ')}. A multipack of tins is counted in tins.`,
    `- category: exactly one of: ${categories.map((c) => `"${c}"`).join(', ')}. Null if none fit.`,
    '- shelf_life_days: roughly how many days it keeps unopened from the day it is bought, for food, drink, medicine and other things that go off. Null for things that do not go off.',
    '- shop: the shop, only if this is a shop\'s own brand (e.g. "Tesco", "Sainsbury\'s", "Aldi", "Boots"). Null for other brands.',
    '- other_names: up to three other names people use for it, e.g. ["beans"]. Empty if none.',
    '- readable: false if the photo does not show a product you can make out. Then give your best guess for the rest.',
  ].join('\n');
}

export interface Provider {
  id: ProviderId;
  name: string;
  /** Used when no model has been picked yet. */
  defaultModel(models: ModelChoice[]): string;
  /** Models that can read photos, newest first. Also checks the key works. */
  listModels(apiKey: string): Promise<ModelChoice[]>;
  read(apiKey: string, model: string, photo: Photo, categories: string[]): Promise<Reading>;
}

const failed = (message: string, status = 502, code = 'ai_failed') => new LarderError(message, status, code);
const timeoutMs = 60_000;

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

export function claude(doFetch: typeof fetch): Provider {
  // Whether each model takes `effort` (newer ones do), learnt once per model from the Models API.
  const effort = new Map<string, boolean>();
  const client = (apiKey: string) => new Anthropic({ apiKey, authToken: null, baseURL: 'https://api.anthropic.com', fetch: doFetch, maxRetries: 1, timeout: timeoutMs });

  function explain(err: unknown): LarderError {
    if (err instanceof LarderError) return err;
    if (err instanceof Anthropic.APIConnectionError) return failed("Couldn't reach Claude. Check Larder's internet connection and try again.");
    if (err instanceof Anthropic.APIError) {
      const said = (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
      if (err instanceof Anthropic.AuthenticationError) return failed("Claude didn't accept the API key. Check it in Settings → AI.", 400, 'ai_key');
      if (err instanceof Anthropic.PermissionDeniedError) return failed(`Claude refused the API key: ${said}`, 400, 'ai_key');
      if (err instanceof Anthropic.NotFoundError) return failed(`Claude doesn't have that model. Pick another in Settings → AI. (${said})`, 400, 'ai_model');
      if (err instanceof Anthropic.RateLimitError) return failed(`Claude is busy or the account's limit is reached. Try again in a minute. (${said})`, 429, 'ai_busy');
      return failed(`Claude couldn't read the photo: ${said}`);
    }
    return failed(`Claude couldn't read the photo: ${err instanceof Error ? err.message : String(err)}`);
  }

  async function takesEffort(c: Anthropic, model: string): Promise<boolean> {
    const known = effort.get(model);
    if (known !== undefined) return known;
    const info = await c.models.retrieve(model).catch(() => null);
    const yes = !!info?.capabilities?.effort?.supported;
    if (info) effort.set(model, yes);
    return yes;
  }

  return {
    id: 'claude',
    name: 'Claude',
    defaultModel: () => 'claude-haiku-5-5',
    async listModels(apiKey) {
      try {
        const out: ModelChoice[] = [];
        for await (const m of client(apiKey).models.list({ limit: 100 })) {
          const caps = m.capabilities;
          if (caps && (!caps.image_input?.supported || !caps.structured_outputs?.supported)) continue;
          if (caps) effort.set(m.id, !!caps.effort?.supported);
          out.push({ id: m.id, name: m.display_name || m.id });
        }
        return out;
      } catch (err) {
        throw explain(err);
      }
    },
    async read(apiKey, model, photo, categories) {
      const c = client(apiKey);
      try {
        const res = await c.messages.parse({
          model,
          max_tokens: 16000,
          system: SYSTEM,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: photo.mediaType, data: photo.data } },
              { type: 'text', text: instructions(categories) },
            ],
          }],
          // Reading a label is a quick job: low effort keeps it fast and cheap where the model offers it.
          output_config: { format: zodOutputFormat(Reading), ...((await takesEffort(c, model)) ? { effort: 'low' as const } : {}) },
        });
        if (res.stop_reason === 'refusal') throw failed("Claude wouldn't read that photo. Try another, or fill it in by hand.", 422, 'ai_refused');
        if (res.stop_reason === 'max_tokens') throw failed("Claude's answer was cut short. Try again.");
        if (!res.parsed_output) throw failed("Claude's answer didn't make sense. Try again.");
        return res.parsed_output;
      } catch (err) {
        throw explain(err);
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

/** Reading as a Gemini response schema (an OpenAPI subset). */
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    readable: { type: 'BOOLEAN' },
    name: { type: 'STRING' },
    title: { type: 'STRING', nullable: true },
    size: { type: 'STRING', nullable: true },
    unit: { type: 'STRING' },
    category: { type: 'STRING', nullable: true },
    shelf_life_days: { type: 'INTEGER', nullable: true },
    shop: { type: 'STRING', nullable: true },
    other_names: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['readable', 'name', 'title', 'size', 'unit', 'category', 'shelf_life_days', 'shop', 'other_names'],
};

/** Gemini models that only make pictures, speech or embeddings, or need a live connection. */
const NOT_FOR_PHOTOS = /(embedding|tts|image|live|audio|native|robotics|computer-use|aqa|veo|imagen|learnlm)/;

/**
 * The newest plain "Flash" model: quick, cheap and good at reading labels.
 * "gemini-3.6-flash" beats "gemini-3.5-flash"; stable beats preview; Flash beats Flash-Lite and Pro.
 */
export function bestGemini(models: ModelChoice[]): string {
  const version = (id: string) => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  const rank = (id: string) => (/^gemini-[\d.]+-flash$/.test(id) ? 3 : /-flash(-preview|-\d|$)/.test(id) && !id.includes('lite') ? 2 : id.includes('flash') ? 1 : 0);
  const sorted = [...models].sort((a, b) => rank(b.id) - rank(a.id) || version(b.id) - version(a.id));
  return sorted[0]?.id ?? 'gemini-flash-latest';
}

export function gemini(doFetch: typeof fetch): Provider {
  async function call<T>(apiKey: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${GEMINI}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-goog-api-key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw failed("Couldn't reach Gemini. Check Larder's internet connection and try again.");
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
    if (!res.ok) {
      const said = data.error?.message ?? `HTTP ${res.status}`;
      if (/api key/i.test(said) || res.status === 401) throw failed("Gemini didn't accept the API key. Check it in Settings → AI.", 400, 'ai_key');
      if (res.status === 403) throw failed(`Gemini refused the API key: ${said}`, 400, 'ai_key');
      if (res.status === 404) throw failed(`Gemini doesn't have that model. Pick another in Settings → AI. (${said})`, 400, 'ai_model');
      if (res.status === 429) throw failed(`Gemini is busy or the account's limit is reached. Try again in a minute. (${said})`, 429, 'ai_busy');
      throw failed(`Gemini couldn't read the photo: ${said}`);
    }
    return data as T;
  }

  return {
    id: 'gemini',
    name: 'Gemini',
    defaultModel: bestGemini,
    async listModels(apiKey) {
      const out: ModelChoice[] = [];
      let page = '';
      // A handful of pages at most; Google lists a few dozen models.
      for (let i = 0; i < 5; i++) {
        const r = await call<{ models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>; nextPageToken?: string }>(apiKey, `/models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
        for (const m of r.models ?? []) {
          const id = m.name.replace(/^models\//, '');
          if (!id.startsWith('gemini') || NOT_FOR_PHOTOS.test(id) || !m.supportedGenerationMethods?.includes('generateContent')) continue;
          out.push({ id, name: m.displayName || id });
        }
        if (!r.nextPageToken) break;
        page = r.nextPageToken;
      }
      return out.sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
    },
    async read(apiKey, model, photo, categories) {
      const r = await call<{
        promptFeedback?: { blockReason?: string };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      }>(apiKey, `/models/${encodeURIComponent(model)}:generateContent`, {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: photo.mediaType, data: photo.data } }, { text: instructions(categories) }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA },
      });
      if (r.promptFeedback?.blockReason) throw failed("Gemini wouldn't read that photo. Try another, or fill it in by hand.", 422, 'ai_refused');
      const cand = r.candidates?.[0];
      const text = (cand?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
      if (!text) {
        if (cand?.finishReason && cand.finishReason !== 'STOP') throw failed("Gemini wouldn't read that photo. Try another, or fill it in by hand.", 422, 'ai_refused');
        throw failed("Gemini didn't answer. Try again.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw failed("Gemini's answer didn't make sense. Try again.");
      }
      const ok = Reading.safeParse(parsed);
      if (!ok.success) throw failed("Gemini's answer didn't make sense. Try again.");
      return ok.data;
    },
  };
}
