/**
 * AI: add things by photo. Claude or Gemini, with the household's own API
 * key, reads the packaging and fills in the item's details. The key and the
 * model for each are chosen in Settings. Nothing is saved from a reading:
 * the app shows it on the Add item page to check first.
 */
import { z } from 'zod';
import { defineModule, LarderError, photoType, SHOP_PRESETS } from '@larder/core';
import { claude, gemini, PROVIDER_NAMES, type Photo, type Provider, type ProviderId, type Reading } from './providers';

const ProviderName = z.enum(['claude', 'gemini']);

interface Saved {
  provider: ProviderId | null;
  keys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
}

const ProviderStatus = z.object({
  /** Whether there's a key, without ever sending it back. */
  keySet: z.boolean(),
  /** The key's last four characters, e.g. "…a1b2", so people can tell which one it is. */
  keyHint: z.string().nullable(),
  /** "app" when saved in Settings, "env" when it comes from LARDER_MODULE_AI_<PROVIDER>_API_KEY. */
  keyFrom: z.enum(['app', 'env']).nullable(),
  /** The chosen model, or null for the default. */
  model: z.string().nullable(),
});

const Status = z.object({
  provider: ProviderName.nullable(),
  /** A provider is chosen and has a key: Add by photo works. */
  ready: z.boolean(),
  claude: ProviderStatus,
  gemini: ProviderStatus,
});

const ApiKey = z.string().trim().min(10, 'That API key is too short. Copy the whole key.').max(300).regex(/^\S+$/, 'An API key has no spaces in it.');
const ModelId = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:@/-]+$/, "That isn't a model name.");
const ProviderPatch = z.object({
  /** A new key, or null to forget the saved one. Leave out to keep it. */
  apiKey: ApiKey.nullable().optional(),
  /** A model id, or null for the default. */
  model: ModelId.nullable().optional(),
});

const Model = z.object({ id: z.string(), name: z.string() });

export const Identified = z.object({
  /** False when the AI couldn't make out a product; the rest is its best guess. */
  readable: z.boolean(),
  /** Generic name, e.g. "Baked beans". */
  name: z.string(),
  /** Brand and pack, e.g. "Heinz Baked Beanz 415 g", saved as the item's brand. */
  brand: z.string().nullable(),
  unit: z.string(),
  categoryId: z.string().nullable(),
  shelfLifeDays: z.number().int().nullable(),
  aliases: z.array(z.string()),
  /** The shop, for a shop's own brand: `id` is null when Larder doesn't have it yet. */
  shop: z.object({ name: z.string(), id: z.string().nullable(), preset: z.boolean() }).nullable(),
  provider: ProviderName,
  model: z.string(),
});
export type Identified = z.infer<typeof Identified>;

/** Base64 of a resized photo; the app sends about 200–500 KB. The server takes 2 MB bodies. */
const MAX_PHOTO_CHARS = 1_900_000;

function photoFrom(base64: string): Photo {
  const data = base64.replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new LarderError("That photo didn't come through. Take it again.", 400, 'invalid');
  const head = Uint8Array.from(atob(data.slice(0, 24)), (c) => c.charCodeAt(0));
  const type = photoType(head);
  if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'image/webp' && type !== 'image/gif') {
    throw new LarderError('That isn\'t a photo the AI can read. Use a JPEG, PNG, WebP or GIF.', 400, 'invalid');
  }
  return { data, mediaType: type };
}

const cap = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default defineModule({
  id: 'ai',
  name: 'AI',
  description: 'Add things by photo: Claude or Gemini reads the packaging and fills in the details. Needs your own API key (Settings → AI).',
  version: '1.0.0',
  defaultEnabled: true,
  setup(ctx) {
    const store = ctx.collection<Saved>('settings');
    const providers: Record<ProviderId, Provider> = { claude: claude(ctx.fetch), gemini: gemini(ctx.fetch) };

    async function saved(): Promise<Saved> {
      return (await store.get('ai')) ?? { provider: null, keys: {}, models: {} };
    }
    const envKey = (p: ProviderId) => ctx.config[`${p}_api_key`]?.trim() || null;
    const keyFor = (s: Saved, p: ProviderId) => s.keys[p] ?? envKey(p);

    function status(s: Saved): z.infer<typeof Status> {
      const one = (p: ProviderId) => {
        const key = keyFor(s, p);
        return { keySet: !!key, keyHint: key ? `…${key.slice(-4)}` : null, keyFrom: s.keys[p] ? 'app' as const : key ? 'env' as const : null, model: s.models[p] ?? null };
      };
      return { provider: s.provider, ready: !!s.provider && !!keyFor(s, s.provider), claude: one('claude'), gemini: one('gemini') };
    }

    function needKey(s: Saved, p: ProviderId): string {
      const key = keyFor(s, p);
      if (!key) throw new LarderError(`Add a ${PROVIDER_NAMES[p]} API key in Settings → AI first.`, 409, 'ai_not_set_up');
      return key;
    }

    ctx.addRoute({
      method: 'GET',
      path: '/',
      summary: 'Which AI is used for Add by photo, and whether it is set up (never the keys)',
      response: Status,
      handler: async () => status(await saved()),
    });

    ctx.addRoute({
      method: 'PUT',
      path: '/settings',
      summary: 'Choose the AI, and set or forget an API key or model for Claude or Gemini',
      admin: true,
      body: z.object({ provider: ProviderName.nullable().optional(), claude: ProviderPatch.optional(), gemini: ProviderPatch.optional() }),
      response: Status,
      async handler({ body }) {
        const s = await saved();
        const next: Saved = { provider: body.provider === undefined ? s.provider : body.provider, keys: { ...s.keys }, models: { ...s.models } };
        for (const p of ['claude', 'gemini'] as const) {
          const patch = body[p];
          if (!patch) continue;
          if (patch.apiKey === null) delete next.keys[p];
          else if (patch.apiKey !== undefined) next.keys[p] = patch.apiKey;
          if (patch.model === null) delete next.models[p];
          else if (patch.model !== undefined) next.models[p] = patch.model;
        }
        await store.put('ai', next);
        ctx.log.info('AI settings changed', { provider: next.provider });
        return status(next);
      },
    });

    ctx.addRoute({
      method: 'GET',
      path: '/models',
      summary: 'The models Claude or Gemini offers that can read photos, using the saved key (also checks the key works)',
      admin: true,
      query: z.object({ provider: ProviderName }),
      response: z.object({ models: z.array(Model), default: z.string() }),
      async handler({ query }) {
        const p = query.provider as ProviderId;
        const models = await providers[p].listModels(needKey(await saved(), p));
        return { models, default: providers[p].defaultModel(models) };
      },
    });

    ctx.addRoute({
      method: 'POST',
      path: '/identify',
      summary: 'Read a photo of something with the chosen AI and say what it is (nothing is saved)',
      description: 'Send a photo as base64 (JPEG, PNG, WebP or GIF; resize it to about 1600 pixels first). The answer fills in the Add item page: check it, then save it as usual.',
      body: z.object({ image: z.string().min(100).max(MAX_PHOTO_CHARS) }),
      response: Identified,
      async handler({ body }) {
        const s = await saved();
        if (!s.provider) throw new LarderError('Choose Claude or Gemini in Settings → AI to add things by photo.', 409, 'ai_not_set_up');
        const p = s.provider;
        const key = needKey(s, p);
        const provider = providers[p];
        let model = s.models[p];
        if (!model) {
          // Gemini's model names change often, so its default comes from the list; Claude's is fixed.
          model = p === 'gemini' ? provider.defaultModel(await provider.listModels(key)) : provider.defaultModel([]);
          await store.put('ai', { ...s, models: { ...s.models, [p]: model } });
        }
        const categories = await ctx.core.categories.list();
        const reading = await provider.read(key, model, photoFrom(body.image), categories.map((c) => c.name));
        return { ...(await tidy(reading, categories)), provider: p, model };
      },
    });

    /** Turns what the AI said into Larder's terms: the household's category and shop, sensible lengths. */
    async function tidy(r: Reading, categories: Array<{ id: string; name: string }>): Promise<Omit<Identified, 'provider' | 'model'>> {
      const name = sentence(cap(r.name, 120)) || 'Something';
      const category = r.category ? categories.find((c) => c.name.toLowerCase() === r.category!.trim().toLowerCase()) : undefined;
      const title = cap(r.title, 120);
      const size = cap(r.size, 30);
      // "Heinz Beanz 415g" already says "415 g".
      const squash = (x: string) => x.toLowerCase().replace(/\s+/g, '');
      const brand = cap([title, size && !squash(title).includes(squash(size)) ? size : ''].filter(Boolean).join(' '), 160) || null;
      const shopName = cap(r.shop, 60);
      let shop: Identified['shop'] = null;
      if (shopName) {
        const found = await ctx.core.resolve.shop(shopName).catch(() => null);
        const preset = SHOP_PRESETS.find((x) => x.name.toLowerCase().replace(/['’]/g, '') === shopName.toLowerCase().replace(/['’]/g, ''));
        shop = { name: found?.name ?? preset?.name ?? shopName, id: found?.id ?? null, preset: !found && !!preset };
      }
      const days = r.shelf_life_days;
      return {
        readable: r.readable,
        name,
        brand,
        unit: cap(r.unit, 20) || 'each',
        categoryId: category?.id ?? null,
        shelfLifeDays: typeof days === 'number' && days >= 1 ? Math.min(36500, Math.round(days)) : null,
        aliases: [...new Set(r.other_names.map((a) => cap(a, 80)).filter((a) => a && a.toLowerCase() !== name.toLowerCase()))].slice(0, 3),
        shop,
      };
    }
  },
});
