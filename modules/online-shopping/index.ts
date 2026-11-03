/**
 * Online shopping: Larder fills an online basket (Tesco first) from what's
 * low or on offer, books delivery slots, and brings in the shop's favourites.
 * Each shop's website is driven by a separate shopping provider behind one
 * fixed contract (see contract.ts); Larder holds the stock and the buying
 * rules and makes every decision.
 */
import { z } from 'zod';
import { defineModule, Id } from '@larder/core';
import { PROVIDER_TYPES, ProviderInput, ProviderPatch, ProviderView, createProviders, type Provider } from './providers';

export { ProviderView } from './providers';

const MODULE_ID = 'online-shopping';

export default defineModule({
  id: MODULE_ID,
  name: 'Online shopping',
  description: 'Fills your online basket (Tesco first) from what\'s low or on offer, books delivery slots and brings in your shop favourites, through a shopping provider on your network.',
  version: '1.0.0',
  defaultEnabled: true,
  setup(ctx) {
    const providers = createProviders(ctx);

    /* --------------------------- Settings: providers --------------------------- */

    ctx.addRoute({
      method: 'GET', path: '/providers', summary: 'Shopping providers, and the types that can be added',
      response: z.object({ providers: z.array(ProviderView), types: z.array(z.object({ type: z.string(), name: z.string(), shop: z.string().nullable() })) }),
      async handler() {
        return { providers: await providers.views(), types: PROVIDER_TYPES.map((t) => ({ ...t })) };
      },
    });

    ctx.addRoute({
      method: 'POST', path: '/providers', summary: 'Add an automated shopping provider', admin: true,
      description: 'One per shop. The address is where the provider runs (e.g. 192.168.1.231:8710) and the token is its AUTH_TOKEN. The first one added is the default.',
      body: ProviderInput, response: ProviderView,
      async handler({ body }) {
        return providers.view(await providers.create(body));
      },
    });

    ctx.addRoute({
      method: 'PATCH', path: '/providers/:id', summary: 'Change a shopping provider', admin: true,
      params: z.object({ id: Id }), body: ProviderPatch, response: ProviderView,
      async handler({ params, body }) {
        return providers.view(await providers.update(params.id, body));
      },
    });

    ctx.addRoute({
      method: 'DELETE', path: '/providers/:id', summary: 'Remove a shopping provider (its items keep their listings)', admin: true,
      params: z.object({ id: Id }), response: z.object({ removed: z.boolean() }),
      async handler({ params }) {
        await providers.remove(params.id);
        return { removed: true };
      },
    });

    ctx.addRoute({
      method: 'POST', path: '/providers/:id/test', summary: 'Test the connection: health and manifest, saved as its status', admin: true,
      description: 'With wake: true, wakes the machine through Home Assistant first if it doesn\'t answer (this can take a few minutes). Fills in waking from the provider\'s manifest when it isn\'t set up.',
      params: z.object({ id: Id }), body: z.object({ wake: z.boolean().optional() }),
      response: z.object({ provider: ProviderView, woke: z.boolean(), filledWake: z.boolean(), message: z.string() }),
      async handler({ params, body }) {
        const r = await providers.check(await providers.get(params.id), { wake: body?.wake ?? false });
        return { provider: await providers.view(r.provider), woke: r.woke, filledWake: r.filledWake, message: statusText(r.provider, r.woke, r.filledWake) };
      },
    });

    function statusText(p: Provider, woke: boolean, filledWake: boolean): string {
      const s = p.status!;
      const parts: string[] = [];
      if (woke) parts.push('Woke it.');
      if (s.ok) parts.push(`${s.name ?? 'The provider'} ${s.version ?? ''} is ready (contract ${s.contractVersion ?? '?'}).`.replace(/\s+\(/, ' ('));
      else parts.push(s.message ?? 'It isn\'t ready.');
      if (filledWake) parts.push(`Larder will wake it with a magic packet to ${p.wake?.mac} when it doesn't answer.`);
      return parts.join(' ');
    }

    /* ----------------------------------- Tools ---------------------------------- */

    const Shop = z.string().max(80).optional().describe('The shop, e.g. "Tesco". Leave out for the default online shop');

    ctx.addTool({
      name: 'provider_status', title: 'Is the online shop ready?', readOnly: true,
      description: 'Check an online shop\'s provider is running and logged in, waking its machine if it\'s asleep (this can take a few minutes). Use before a shop, or when a shop failed.',
      input: z.object({ shop: Shop }),
      async run({ shop }) {
        const { provider } = await providers.resolve(shop);
        const r = await providers.check(provider, { wake: true });
        const p = r.provider;
        const name = await providers.shopName(p.shopId);
        const caps = p.status?.capabilities ?? [];
        const text = p.status?.ok
          ? `${r.woke ? 'Woke it. ' : ''}${name} is ready: provider ${p.status.version ?? ''}, logged in. It can ${capsText(caps)}.`
          : `${name} isn't ready: ${p.status?.message ?? 'no answer'}`;
        return { text, data: { shop: name, ok: p.status?.ok ?? false, woke: r.woke, message: p.status?.message ?? null, version: p.status?.version ?? null, capabilities: caps } };
      },
    });

    function capsText(caps: string[]): string {
      const words: Record<string, string> = {
        slot_booking: 'book delivery slots', favourites: 'read your favourites', add_favourites: 'add favourites', search: 'search products',
        loyalty_prices: 'see loyalty prices', multibuys: 'see multibuys',
      };
      const said = caps.map((c) => words[c]).filter(Boolean);
      return said.length ? ['fill the basket', ...said].join(', ').replace(/, ([^,]*)$/, ' and $1') : 'fill the basket';
    }

  },
});
