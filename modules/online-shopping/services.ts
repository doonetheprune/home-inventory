/** What the module's routes and tools share. */
import { LarderError, type ModuleContext } from '@larder/core';
import type { ProviderClient } from './client';
import { createHub } from './hub';
import { createItems } from './items';
import { createProviders, type Provider } from './providers';

export function createServices(ctx: ModuleContext) {
  const hub = createHub(ctx);
  const providers = createProviders(ctx, hub);
  const items = createItems(ctx);

  /** The provider's client once it answers (waking it if needed) and is logged in; otherwise says why not. */
  async function ready(p: Provider): Promise<ProviderClient> {
    const { health } = await providers.awake(p, { wake: true });
    const problem = providers.healthProblem(health, await providers.shopName(p.shopId));
    if (problem) throw new LarderError(problem, 503, health.ok ? 'login_expired' : 'provider_error');
    return providers.client(p);
  }

  /** Whether the provider said it can (from its last status); unknown counts as yes, and the provider says if not. */
  const can = (p: Provider, capability: string) => !p.status?.capabilities.length || p.status.capabilities.includes(capability);

  const currency = async () => (await ctx.core.settings.get()).currency;

  return { hub, providers, items, ready, can, currency };
}
export type Services = ReturnType<typeof createServices>;
