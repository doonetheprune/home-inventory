/**
 * Scenarios: lists of things for a situation, such as Power cut, Christmas or
 * Emergency food. A scenario is a tag on products (wish list items too), with
 * no target quantities: each item's own minimum already says when it's low.
 *
 * Opening a scenario lists every item, how many there are and where, grouped
 * by place, and can be printed (text only or with place photos) to stick
 * inside a cupboard door for whoever needs it in the dark.
 */
import { z } from 'zod';
import { amount, defineModule, Id, LarderError, newId, NotFoundError, type CoreApi, type PlaceRef, type ProductSummary } from '@larder/core';

/** On each product: the ids of the scenarios it belongs to. */
export const ScenarioFields = z.array(Id).max(50).default([]);

export const Scenario = z.object({
  id: Id,
  name: z.string().min(1).max(60),
  /** An icon name from the app's set, e.g. "zap" or "gift". */
  icon: z.string().max(20).default('layers'),
  notes: z.string().max(1000).default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
}).meta({ id: 'Scenario' });
export type Scenario = z.infer<typeof Scenario>;

const ScenarioInput = z.object({ name: z.string().trim().min(1).max(60), icon: z.string().max(20).optional(), notes: z.string().max(1000).optional() });

const Counts = z.object({ items: z.number(), places: z.number(), low: z.number(), wish: z.number() });
export const ScenarioSummary = Scenario.extend({ counts: Counts }).meta({ id: 'ScenarioSummary' });

const Line = z.object({
  productId: z.string(),
  name: z.string(),
  /** How much is in this place. */
  quantity: z.number(),
  unit: z.string(),
  /** "6 charged, 4 flat" for rechargeables; "Min 3" when low. */
  note: z.string().nullable(),
  low: z.boolean(),
  category: z.string().nullable(),
  /** It usually lives somewhere else. */
  visiting: z.boolean(),
});
const Group = z.object({
  place: z.object({ id: z.string(), name: z.string(), path: z.string(), code: z.string().nullable(), photoFileId: z.string().nullable() }).nullable(),
  items: z.array(Line),
});
export const ScenarioDetail = z.object({
  scenario: Scenario,
  counts: Counts,
  /** By where things are right now. */
  groups: z.array(Group),
  /** In the scenario but none in the house. */
  missing: z.array(z.object({ productId: z.string(), name: z.string(), low: z.boolean() })),
  wish: z.array(z.object({ productId: z.string(), name: z.string(), notes: z.string() })),
}).meta({ id: 'ScenarioDetail' });
export type ScenarioDetail = z.infer<typeof ScenarioDetail>;

const tagsOf = (s: ProductSummary): string[] => ScenarioFields.parse(s.product.fields.scenarios ?? []);

export async function detailFor(core: CoreApi, scenario: Scenario): Promise<ScenarioDetail> {
  const all = [...(await core.products.list()), ...(await core.products.list({ status: 'wish' }))];
  const members = all.filter((s) => tagsOf(s).includes(scenario.id)).sort((a, b) => a.product.name.localeCompare(b.product.name));
  const groups = new Map<string, z.infer<typeof Group>>();
  const missing: ScenarioDetail['missing'] = [];
  const wish: ScenarioDetail['wish'] = [];
  const places = new Map((await core.places.list()).map((p) => [p.id, p]));
  const photo = async (ref: PlaceRef) => (await core.places.get(ref.id).catch(() => null))?.photoFileId ?? null;

  for (const s of members) {
    if (s.product.wish) {
      wish.push({ productId: s.product.id, name: s.product.name, notes: s.product.notes });
      continue;
    }
    if (s.inStock <= 0) {
      missing.push({ productId: s.product.id, name: s.product.name, low: s.status.low });
      continue;
    }
    const detail = await core.products.get(s.product.id);
    const byPlace = new Map<string, { ref: PlaceRef | null; quantity: number; visiting: boolean }>();
    for (const e of detail.entries.filter((x) => x.status === 'in_stock' && x.quantity > 0)) {
      const ref = e.currentPlace ?? e.place;
      const key = ref?.id ?? '';
      const cur = byPlace.get(key) ?? { ref, quantity: 0, visiting: !!e.currentPlace };
      cur.quantity += e.quantity;
      byPlace.set(key, cur);
    }
    for (const [key, at] of byPlace) {
      let g = groups.get(key);
      if (!g) {
        const ref = at.ref ? places.get(at.ref.id) ?? at.ref : null;
        g = { place: ref ? { id: ref.id, name: ref.name, path: ref.path, code: ref.code, photoFileId: await photo(ref) } : null, items: [] };
        groups.set(key, g);
      }
      const note = s.charged !== null ? `${s.charged} charged, ${s.flat ?? 0} flat` : s.status.low && s.product.minQuantity ? `Min ${amount(s.product.minQuantity, s.product.unit)}` : null;
      g.items.push({ productId: s.product.id, name: s.product.name, quantity: Math.round(at.quantity * 1000) / 1000, unit: s.product.unit, note, low: s.status.low, category: s.category?.name ?? null, visiting: at.visiting });
    }
  }
  const sorted = [...groups.values()].sort((a, b) => (a.place?.path ?? '~').localeCompare(b.place?.path ?? '~'));
  const owned = members.filter((s) => !s.product.wish);
  return {
    scenario,
    counts: { items: owned.length, places: sorted.length, low: owned.filter((s) => s.status.low).length, wish: wish.length },
    groups: sorted, missing, wish,
  };
}

/** Plain text for AI assistants: by place, with what's low and missing. */
export function detailText(d: ScenarioDetail): string {
  const lines = [`${d.scenario.name}: ${d.counts.items} items in ${d.counts.places} places${d.counts.low ? `, ${d.counts.low} running low` : ''}.`];
  if (d.scenario.notes) lines.push(d.scenario.notes);
  for (const g of d.groups) {
    lines.push(`${g.place ? `${g.place.path}${g.place.code ? ` (${g.place.code})` : ''}` : 'No place set'}:`);
    for (const i of g.items) lines.push(`- ${i.name}: ${amount(i.quantity, i.unit)}${i.note ? ` (${i.note})` : ''}${i.visiting ? ', only here for now' : ''}`);
  }
  if (d.missing.length) lines.push(`None in the house: ${d.missing.map((m) => m.name).join(', ')}.`);
  if (d.wish.length) lines.push(`On the wish list: ${d.wish.map((w) => w.name).join(', ')}.`);
  return lines.join('\n');
}

export default defineModule({
  id: 'scenarios',
  name: 'Scenarios',
  description: 'Lists for situations like a power cut or Christmas: every item, how many and where, ready to print.',
  version: '1.0.0',
  productFields: ScenarioFields,
  setup(ctx) {
    const scenarios = ctx.collection<Scenario>('scenarios');
    const core = ctx.core;
    const all = async () => (await scenarios.list()).map((d) => d.data).sort((a, b) => a.name.localeCompare(b.name));

    async function get(id: string): Promise<Scenario> {
      const s = await scenarios.get(id);
      if (!s) throw new NotFoundError('Scenario', id);
      return s;
    }

    /** By id or name (exact, or every word given), for assistants. */
    async function find(ref: string): Promise<Scenario> {
      const list = await all();
      const q = ref.trim().toLowerCase();
      const byId = list.find((s) => s.id === ref);
      if (byId) return byId;
      const exact = list.filter((s) => s.name.toLowerCase() === q);
      if (exact.length === 1) return exact[0]!;
      const words = q.split(/\s+/).filter(Boolean);
      const covering = list.filter((s) => words.length && words.every((w) => s.name.toLowerCase().split(/\s+/).some((x) => x.startsWith(w))));
      if (covering.length === 1) return covering[0]!;
      throw new LarderError(
        covering.length ? `"${ref}" could be ${covering.map((s) => s.name).join(' or ')}.` : `There's no scenario called "${ref}". The scenarios are: ${list.map((s) => s.name).join(', ') || 'none yet'}.`,
        covering.length ? 409 : 404, covering.length ? 'ambiguous' : 'not_found',
      );
    }

    async function setTag(productId: string, scenarioId: string, included: boolean) {
      const s = await core.products.summary(productId);
      const tags = tagsOf(s);
      const next = included ? [...new Set([...tags, scenarioId])] : tags.filter((t) => t !== scenarioId);
      if (next.length === tags.length && next.every((t, i) => t === tags[i])) return;
      await core.products.update(productId, { fields: { ...s.product.fields, scenarios: next } });
    }

    async function create(input: z.infer<typeof ScenarioInput>): Promise<Scenario> {
      const list = await all();
      if (list.some((s) => s.name.toLowerCase() === input.name.toLowerCase())) throw new LarderError(`There's already a scenario called ${input.name}.`, 409, 'conflict');
      const now = core.now();
      const s = Scenario.parse({ id: newId(), name: input.name, icon: input.icon, notes: input.notes, createdAt: now, updatedAt: now });
      await scenarios.put(s.id, s);
      ctx.publish('scenarios.changed', { id: s.id });
      return s;
    }

    ctx.addRoute({
      method: 'GET', path: '/', summary: 'Scenarios, with how many items, places, low and wished for',
      response: z.array(ScenarioSummary),
      async handler() {
        return Promise.all((await all()).map(async (s) => ({ ...s, counts: (await detailFor(core, s)).counts })));
      },
    });

    ctx.addRoute({
      method: 'POST', path: '/', summary: 'Make a scenario', body: ScenarioInput, response: Scenario,
      handler: ({ body }) => create(body as z.infer<typeof ScenarioInput>),
    });

    ctx.addRoute({
      method: 'GET', path: '/:id', summary: 'A scenario: every item, how many and where, by place',
      params: z.object({ id: Id }), response: ScenarioDetail,
      async handler({ params }) {
        return detailFor(core, await get((params as { id: string }).id));
      },
    });

    ctx.addRoute({
      method: 'PATCH', path: '/:id', summary: 'Rename a scenario or change its notes',
      params: z.object({ id: Id }), body: ScenarioInput.partial(), response: Scenario,
      async handler({ params, body }) {
        const cur = await get((params as { id: string }).id);
        const next = Scenario.parse({ ...cur, ...(body as object), updatedAt: core.now() });
        await scenarios.put(next.id, next);
        ctx.publish('scenarios.changed', { id: next.id });
        return next;
      },
    });

    ctx.addRoute({
      method: 'DELETE', path: '/:id', summary: 'Remove a scenario (its items stay, untagged)',
      params: z.object({ id: Id }), response: z.object({ ok: z.literal(true) }),
      async handler({ params }) {
        const s = await get((params as { id: string }).id);
        const products = [...(await core.products.list()), ...(await core.products.list({ status: 'wish' }))];
        for (const p of products) if (tagsOf(p).includes(s.id)) await setTag(p.product.id, s.id, false);
        await scenarios.remove(s.id);
        ctx.publish('scenarios.changed', { id: s.id });
        return { ok: true as const };
      },
    });

    ctx.addRoute({
      method: 'PUT', path: '/:id/items', summary: 'Put an item in a scenario, or take it out',
      params: z.object({ id: Id }), body: z.object({ productId: Id, included: z.boolean() }), response: z.object({ ok: z.literal(true) }),
      async handler({ params, body }) {
        const s = await get((params as { id: string }).id);
        const b = body as { productId: string; included: boolean };
        await setTag(b.productId, s.id, b.included);
        ctx.publish('scenarios.changed', { id: s.id });
        return { ok: true as const };
      },
    });

    ctx.addSearchSection({
      id: 'scenarios', title: 'Scenarios', order: 40,
      async documents() {
        const products = [...(await core.products.list()), ...(await core.products.list({ status: 'wish' }))];
        return (await all()).map((s) => ({
          id: `scenarios:${s.id}`, type: 'scenarios', refId: s.id, title: s.name,
          keywords: [s.notes, ...products.filter((p) => tagsOf(p).includes(s.id)).map((p) => p.product.name)].filter(Boolean),
        }));
      },
      async results(_query, hits) {
        const list = await all();
        return Promise.all(hits.map(async (h) => {
          const s = list.find((x) => x.id === h.refId);
          if (!s) return null;
          const { counts } = await detailFor(core, s);
          return { type: 'scenario', id: s.id, title: s.name, subtitle: `${counts.items} item${counts.items === 1 ? '' : 's'} in ${counts.places} place${counts.places === 1 ? '' : 's'}${counts.low ? ` · ${counts.low} low` : ''}`, href: `/m/scenarios/${s.id}` };
        })).then((r) => r.filter((x) => x !== null));
      },
    });

    ctx.addTool({
      name: 'list_scenarios', title: 'List scenarios', readOnly: true,
      description: 'The household\'s scenarios (lists for situations like a power cut or Christmas), with how many items each has and how many are low.',
      input: z.object({}),
      async run() {
        const list = await Promise.all((await all()).map(async (s) => ({ s, counts: (await detailFor(core, s)).counts })));
        if (!list.length) return { text: 'There are no scenarios yet.', data: { scenarios: [] } };
        return {
          text: list.map(({ s, counts }) => `- ${s.name}: ${counts.items} items${counts.low ? `, ${counts.low} low` : ''}${counts.wish ? `, ${counts.wish} on the wish list` : ''}`).join('\n'),
          data: { scenarios: list.map(({ s, counts }) => ({ id: s.id, name: s.name, ...counts })) },
        };
      },
    });

    ctx.addTool({
      name: 'get_scenario', title: 'Get a scenario', readOnly: true,
      description: 'Everything in a scenario (e.g. "power cut"): each item, how many and where, grouped by place, plus what\'s low, missing or wished for.',
      input: z.object({ scenario: z.string().min(1).max(60).describe('The scenario\'s name, e.g. "power cut"') }),
      async run({ scenario }) {
        const d = await detailFor(core, await find(scenario));
        return { text: detailText(d), data: d as unknown as Record<string, unknown> };
      },
    });
  },

  async demo(ctx, seed) {
    const core = ctx.core;
    const routes = core.modules.routes().filter((r) => r.moduleId === 'scenarios');
    const call = (method: string, path: string, body?: unknown, params: Record<string, string> = {}) =>
      routes.find((r) => r.route.method === method && r.route.path === path)!.route.handler({ body, params, query: {}, userId: null });
    const make = async (name: string, icon: string, notes: string, items: string[]) => {
      const s = (await call('POST', '/', { name, icon, notes })) as Scenario;
      for (const item of items) if (seed.products[item]) await call('PUT', '/:id/items', { productId: seed.products[item], included: true }, { id: s.id });
    };
    await make('Power cut', 'zap', 'Torches first. The fuse box is in the hall cupboard.', ['AA batteries', 'AAA batteries', 'Head torch', 'Candles', 'Camping stove', 'Camping gas', 'Power bank, 20,000 mAh', 'Wind-up radio']);
    await make('Snowed in', 'drop', 'Enough for a week without getting to the shops.', ['Baked beans', 'Oat milk', 'Frozen peas', 'Dog food', 'Toilet roll', 'Heating oil', 'Candles']);
  },
});
