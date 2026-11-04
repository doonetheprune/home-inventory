/**
 * Settings → Larder Automations: the hub's address and token, waking its Mac,
 * Test connection, and the automations it runs with the shop each is linked to
 * (linking is adding a provider with `automation`, in providers-api.ts).
 */
import { z } from 'zod';
import type { ModuleContext } from '@larder/core';
import { ProviderError } from './client';
import { HubAutomation, HubInput, HubStatus, HubView, type Hub } from './hub';
import type { Services } from './services';
import { WakeSettings, wakeMachine } from './wake';

const LinkedAutomation = HubAutomation.extend({
  /** The provider it is, when it's linked to a shop. */
  providerId: z.string().nullable(),
  shopId: z.string().nullable(),
  shopName: z.string().nullable(),
});
const HubAnswer = z.object({ hub: HubView.nullable(), automations: z.array(LinkedAutomation) });

export function hubFeatures(ctx: ModuleContext, { hub, providers }: Services) {
  const pollMs = Number(ctx.config.wake_poll_ms ?? 5000);

  async function answer(): Promise<z.infer<typeof HubAnswer>> {
    const h = await hub.get();
    const linked = (await providers.views()).filter((p) => p.automation);
    const known = h?.status?.automations ?? [];
    // Linked ones the hub didn't list last time still show, so they can be unlinked.
    const ids = [...new Set([...known.map((a) => a.id), ...linked.map((p) => p.automation!)])];
    return {
      hub: h ? hub.view(h) : null,
      automations: ids.map((id) => {
        const a = known.find((x) => x.id === id) ?? HubAutomation.parse({ id, name: id, running: false });
        const p = linked.find((x) => x.automation === id);
        return { ...a, providerId: p?.id ?? null, shopId: p?.shopId ?? null, shopName: p?.shopName ?? null };
      }),
    };
  }

  /** Probes the hub, waking the Mac first when asked and it doesn't answer. */
  async function test(h: Hub, wake: boolean): Promise<{ hub: Hub; woke: boolean; filledWake: boolean; answered: boolean }> {
    let woke = false;
    let answered = false;
    let filledWake = false;
    let status: HubStatus;
    let next = h;
    try {
      const probed = await hub.probe(h).catch(async (err: unknown) => {
        if (!wake || !(err instanceof ProviderError) || err.code !== 'unreachable' || !(h.wake?.entityId || h.wake?.mac)) throw err;
        await wakeMachine(ctx, h);
        woke = true;
        const until = Date.now() + (ctx.config.wake_timeout_ms ? Number(ctx.config.wake_timeout_ms) : h.wake.timeoutSeconds * 1000);
        for (;;) {
          await new Promise((r) => setTimeout(r, pollMs));
          try {
            return await hub.probe(h);
          } catch (again) {
            if (!(again instanceof ProviderError) || again.code !== 'unreachable') throw again;
            if (Date.now() >= until) throw new ProviderError('Woke the Mac, but Larder Automations didn\'t answer in time. Check the Mac is plugged in and on the network, and that Larder Automations starts at login.', 'wake_timeout', 503);
          }
        }
      });
      status = probed.status;
      answered = true;
      if (!h.wake && probed.mac) {
        next = { ...next, wake: WakeSettings.parse({ mac: probed.mac.mac, broadcastAddress: probed.mac.broadcast }) };
        filledWake = true;
      }
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      status = HubStatus.parse({ ...(h.status ?? {}), checkedAt: ctx.core.now(), ok: false, message: err.message, reachable: err.code !== 'unreachable' && err.code !== 'wake_timeout' });
    }
    next = await hub.update(next, { status, wake: next.wake });
    return { hub: next, woke, filledWake, answered };
  }

  function testText(h: Hub, r: { woke: boolean; filledWake: boolean; answered: boolean }): string {
    const s = h.status!;
    const parts: string[] = [];
    if (r.woke) parts.push('Woke the Mac.');
    if (r.answered) {
      const names = s.automations.map((a) => a.name);
      parts.push(`Larder Automations ${s.version ?? ''} answered${names.length ? `, running ${names.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : ''}.`.replace(/\s+answered/, ' answered'));
    }
    if (s.message) parts.push(s.message);
    if (r.filledWake) parts.push(`Larder will wake the Mac with a magic packet to ${h.wake?.mac} when it doesn't answer.`);
    return parts.join(' ');
  }

  ctx.addRoute({
    method: 'GET', path: '/hub', summary: 'Larder Automations: where it runs (never its token) and its automations, with the shop each is linked to',
    response: HubAnswer,
    handler: answer,
  });

  ctx.addRoute({
    method: 'PUT', path: '/hub', summary: 'Set where Larder Automations runs, its token and how to wake its Mac', admin: true,
    description: 'The address is the Mac\'s (port 8700 unless given); the token is from the Larder Automations menu (Copy token). Leave the token out to keep the saved one.',
    body: HubInput, response: HubAnswer,
    async handler({ body }) {
      await hub.save(body);
      return answer();
    },
  });

  ctx.addRoute({
    method: 'DELETE', path: '/hub', summary: 'Forget Larder Automations, and the shops linked to its automations (items keep their listings)', admin: true,
    response: z.object({ removed: z.boolean() }),
    async handler() {
      for (const p of await providers.all()) if (p.automation) await providers.remove(p.id);
      await hub.remove();
      return { removed: true };
    },
  });

  ctx.addRoute({
    method: 'POST', path: '/hub/test', summary: 'Test Larder Automations: is it up, which automations it runs, is the Chrome extension connected', admin: true,
    description: 'With wake: true, wakes the Mac through Home Assistant first if it doesn\'t answer. Fills in waking from the Mac\'s network card when it isn\'t set up.',
    body: z.object({ wake: z.boolean().optional() }),
    response: HubAnswer.extend({ woke: z.boolean(), filledWake: z.boolean(), message: z.string() }),
    async handler({ body }) {
      const h = await hub.get();
      if (!h) throw new ProviderError('Larder Automations isn\'t set up yet. Give its address and token first.', 'no_provider', 409);
      const r = await test(h, body?.wake ?? false);
      return { ...(await answer()), woke: r.woke, filledWake: r.filledWake, message: testText(r.hub, r) };
    },
  });
}
