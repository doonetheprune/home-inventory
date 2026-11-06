/**
 * AI: Claude or Gemini, with the household's own API key, reads photos: a
 * pack, to name it in the scanner (looking it up on the web when the photo
 * isn't enough, unless the household has switched that off), or a receipt, to
 * add what was bought to stock (receipts.ts). Each AI has its own key and
 * model, can be switched off for now without losing them, and they're tried
 * in the household's order: if the first can't (out of credit, busy), the next
 * reads it. Nothing is saved from a reading: the app shows it to check first.
 */
import { z } from 'zod';
import { defineModule, LarderError, photoType, SHOP_PRESETS } from '@larder/core';
import { claude, gemini, packTask, PROVIDER_NAMES, type Input, type Photo, type Provider, type ProviderId, type Reading, type Task } from './providers';
import { orderReader } from './orders';
import { receipts, type Asked } from './receipts';

const ProviderName = z.enum(['claude', 'gemini']);
const ALL: ProviderId[] = ['claude', 'gemini'];

interface Saved {
  /** Which to ask first, then next. Each AI appears once. */
  order: ProviderId[];
  /** Switched off for now: their keys and models are kept. */
  off: ProviderId[];
  keys: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
  /** False when the household doesn't want packs looked up on the web. On unless switched off. */
  search?: boolean;
}

/** Every AI exactly once, in the saved order, any missing at the end. */
const fullOrder = (order: readonly ProviderId[] | undefined) => [...new Set([...(order ?? []).filter((p) => ALL.includes(p)), ...ALL])];

const ProviderStatus = z.object({
  /** On: used when it has a key. Off keeps the key and model for later. */
  enabled: z.boolean(),
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
  /** At least one AI is on and has a key: Add by photo works. */
  ready: z.boolean(),
  /** The order they're asked in. */
  order: z.array(ProviderName),
  /** The one asked first: the first in the order that's on and has a key. */
  first: ProviderName.nullable(),
  /** Add by photo may look a pack up on the web when the photo isn't enough (a search costs about a penny). */
  search: z.boolean(),
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
  /** False to switch it off for now, keeping its key and model. */
  enabled: z.boolean().optional(),
});

const Model = z.object({ id: z.string(), name: z.string() });

const Source = z.object({
  /** The site, e.g. "twinings.co.uk". */
  name: z.string(),
  url: z.string(),
});

export const Identified = z.object({
  /** False when the AI couldn't make out a product; the rest is its best guess. */
  readable: z.boolean(),
  /** What to call it, with its variety, and its brand when that's what it is: "Twinings Sleep tea bags", "Semi-skimmed milk". */
  name: z.string(),
  /** The plain kind of thing, e.g. "Herbal tea" (also among `aliases`), or null. Finds an item the household already has for it. */
  kind: z.string().nullable(),
  /** Brand and pack, e.g. "Heinz Baked Beanz 415 g", saved as the item's brand. */
  brand: z.string().nullable(),
  unit: z.string(),
  categoryId: z.string().nullable(),
  shelfLifeDays: z.number().int().nullable(),
  aliases: z.array(z.string()),
  /** The shop, for a shop's own brand: `id` is null when Larder doesn't have it yet. */
  shop: z.object({ name: z.string(), id: z.string().nullable(), preset: z.boolean() }).nullable(),
  /** The AI that read it, and its model. */
  provider: ProviderName,
  model: z.string(),
  /** Web pages it looked at to name it (up to three, one per site); empty when the photo was enough. */
  sources: z.array(Source),
  /** AIs asked first that couldn't read it, and why (e.g. out of credit). */
  skipped: z.array(z.object({ provider: ProviderName, message: z.string() })),
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
  description: 'Claude or Gemini reads photos: a pack, to name it in the scanner, or a receipt, to add what was bought to stock. Needs your own API key (Settings → AI).',
  version: '1.0.0',
  defaultEnabled: true,
  setup(ctx) {
    const store = ctx.collection<Saved>('settings');
    const providers: Record<ProviderId, Provider> = { claude: claude(ctx.fetch), gemini: gemini(ctx.fetch) };

    async function saved(): Promise<Saved> {
      const s = await store.get('ai');
      return { order: fullOrder(s?.order), off: s?.off ?? [], keys: s?.keys ?? {}, models: s?.models ?? {}, search: s?.search ?? true };
    }
    const envKey = (p: ProviderId) => ctx.config[`${p}_api_key`]?.trim() || null;
    const keyFor = (s: Saved, p: ProviderId) => s.keys[p] ?? envKey(p);
    /** The AIs to ask, in order: on, and with a key. */
    const usable = (s: Saved) => s.order.filter((p) => !s.off.includes(p) && !!keyFor(s, p));

    function status(s: Saved): z.infer<typeof Status> {
      const one = (p: ProviderId) => {
        const key = keyFor(s, p);
        return { enabled: !s.off.includes(p), keySet: !!key, keyHint: key ? `…${key.slice(-4)}` : null, keyFrom: s.keys[p] ? 'app' as const : key ? 'env' as const : null, model: s.models[p] ?? null };
      };
      const use = usable(s);
      return { ready: use.length > 0, order: s.order, first: use[0] ?? null, search: s.search !== false, claude: one('claude'), gemini: one('gemini') };
    }

    function needKey(s: Saved, p: ProviderId): string {
      const key = keyFor(s, p);
      if (!key) throw new LarderError(`Add a ${PROVIDER_NAMES[p]} API key in Settings → AI first.`, 409, 'ai_not_set_up');
      return key;
    }

    ctx.addRoute({
      method: 'GET',
      path: '/',
      summary: 'Which AIs read photos for Add by photo, in what order, and whether they are set up (never the keys)',
      response: Status,
      handler: async () => status(await saved()),
    });

    ctx.addRoute({
      method: 'PUT',
      path: '/settings',
      summary: 'Set the order the AIs are asked in, switch one on or off, set or forget its API key or model, or switch looking packs up on the web on or off',
      admin: true,
      body: z.object({
        /** First to ask, then next. AIs left out keep their place after these. */
        order: z.array(ProviderName).min(1).max(ALL.length).refine((o) => new Set(o).size === o.length, 'Name each AI once.').optional(),
        /** False: Add by photo goes only on what the photo shows, never searching the web. */
        search: z.boolean().optional(),
        claude: ProviderPatch.optional(),
        gemini: ProviderPatch.optional(),
      }),
      response: Status,
      async handler({ body }) {
        const s = await saved();
        const next: Saved = { order: body.order ? fullOrder([...body.order, ...s.order]) : s.order, off: [...s.off], keys: { ...s.keys }, models: { ...s.models }, search: body.search ?? s.search };
        for (const p of ALL) {
          const patch = body[p];
          if (!patch) continue;
          if (patch.apiKey === null) delete next.keys[p];
          else if (patch.apiKey !== undefined) next.keys[p] = patch.apiKey;
          if (patch.model === null) delete next.models[p];
          else if (patch.model !== undefined) next.models[p] = patch.model;
          if (patch.enabled === true) next.off = next.off.filter((x) => x !== p);
          else if (patch.enabled === false && !next.off.includes(p)) next.off.push(p);
        }
        await store.put('ai', next);
        ctx.log.info('AI settings changed', { order: next.order, off: next.off, search: next.search });
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
      summary: 'Read a photo of something and say what it is (nothing is saved)',
      description: 'Send a photo as base64 (JPEG, PNG, WebP or GIF; resize it to about 1600 pixels first). The AIs are asked in the household\'s order; if one can\'t (out of credit, key refused, busy), the next is asked. Unless switched off in Settings, the AI may search the web when the photo doesn\'t show which product it is or its size; `sources` lists the pages. The answer fills in the Add item page: check it, then save it as usual.',
      body: z.object({ image: z.string().min(100).max(MAX_PHOTO_CHARS) }),
      response: Identified,
      async handler({ body }) {
        const categories = await ctx.core.categories.list();
        const { answer, ...by } = await ask(body.image, async () => packTask(categories.map((c) => c.name), (await saved()).search !== false));
        return { ...(await tidy(answer, categories)), ...by };
      },
    });

    /** Asks the AIs in the household's order about a photo (base64), until one answers. */
    const ask = <T>(image: string, task: () => Promise<Task<T>>): Promise<Asked<T>> => askAbout(() => ({ photo: photoFrom(image) }), task, 'photo');

    /**
     * Asks the AIs in the household's order about a photo or some text, until one answers. The task is
     * made only once the input has passed its checks, so nothing is looked up for a bad photo.
     */
    async function askAbout<T>(input: () => Input, task: () => Promise<Task<T>>, what: 'photo' | 'email'): Promise<Asked<T>> {
      const s = await saved();
      const use = usable(s);
      if (!use.length) throw new LarderError(`Switch on Claude or Gemini in Settings → AI, with an API key, to read ${what === 'photo' ? 'photos' : 'order emails'}.`, 409, 'ai_not_set_up');
      const given = input();
      const asking = await task();
      const skipped: Array<{ provider: ProviderId; message: string; error: LarderError }> = [];
      for (const p of use) {
        try {
          const model = await modelFor(p, keyFor(s, p)!);
          const { answer, sources } = await providers[p].read(keyFor(s, p)!, model, given, asking);
          return { answer, sources, provider: p, model, skipped: skipped.map(({ provider, message }) => ({ provider, message })) };
        } catch (err) {
          // The AIs only throw LarderErrors on purpose; anything else is a bug, not a reason to ask the next.
          if (!(err instanceof LarderError)) throw err;
          ctx.log.warn(`${PROVIDER_NAMES[p]} couldn't read ${what === 'email' ? 'an email' : 'a photo'}`, { message: err.message });
          skipped.push({ provider: p, message: err.message, error: err });
        }
      }
      const last = skipped[skipped.length - 1]!.error;
      if (skipped.length === 1) throw last;
      throw new LarderError(skipped.map((x) => x.message).join(' '), last.status, last.code);
    }

    /** The household's shop with this name, or a known UK shop that could be added. */
    async function shopFor(name: string | null): Promise<Identified['shop']> {
      if (!name) return null;
      const found = await ctx.core.resolve.shop(name).catch(() => null);
      const preset = SHOP_PRESETS.find((x) => x.name.toLowerCase().replace(/['’]/g, '') === name.toLowerCase().replace(/['’]/g, ''));
      return { name: found?.name ?? preset?.name ?? name, id: found?.id ?? null, preset: !found && !!preset };
    }

    receipts(ctx, { ask, shopFor });
    ctx.offer('order-reader', orderReader(ctx, {
      ready: async () => usable(await saved()).length > 0,
      ask: (text, task) => askAbout(() => ({ text }), task, 'email'),
    }));

    /** The model to use: the chosen one, or the default (saved, so Settings shows it). */
    async function modelFor(p: ProviderId, key: string): Promise<string> {
      const s = await saved();
      const chosen = s.models[p];
      if (chosen) return chosen;
      // Gemini's model names change often, so its default comes from Google's list; Claude's is fixed.
      const model = p === 'gemini' ? providers[p].defaultModel(await providers[p].listModels(key)) : providers[p].defaultModel([]);
      const now = await saved();
      await store.put('ai', { ...now, models: { ...now.models, [p]: model } });
      return model;
    }

    /** Turns what the AI said into Larder's terms: the household's category and shop, sensible lengths. */
    async function tidy(r: Reading, categories: Array<{ id: string; name: string }>): Promise<Omit<Identified, 'provider' | 'model' | 'sources' | 'skipped'>> {
      const name = sentence(cap(r.name, 120)) || 'Something';
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      const kind = sentence(cap(r.kind, 80));
      const category = r.category ? categories.find((c) => c.name.toLowerCase() === r.category!.trim().toLowerCase()) : undefined;
      const title = cap(r.title, 120);
      const size = cap(r.size, 30);
      // "Heinz Beanz 415g" already says "415 g".
      const squash = (x: string) => x.toLowerCase().replace(/\s+/g, '');
      const brand = cap([title, size && !squash(title).includes(squash(size)) ? size : ''].filter(Boolean).join(' '), 160) || null;
      const shop = await shopFor(cap(r.shop, 60) || null);
      const days = r.shelf_life_days;
      return {
        readable: r.readable,
        name,
        kind: kind && !same(kind, name) ? kind : null,
        brand,
        unit: cap(r.unit, 20) || 'each',
        categoryId: category?.id ?? null,
        shelfLifeDays: typeof days === 'number' && days >= 1 ? Math.min(36500, Math.round(days)) : null,
        // The plain kind first ("Herbal tea"), so searching for it finds this; no name twice in any case.
        aliases: [kind, ...r.other_names.map((a) => cap(a, 80))]
          .filter((a, i, all) => a && !same(a, name) && all.findIndex((b) => same(a, b)) === i)
          .slice(0, 3),
        shop,
      };
    }
  },
});
