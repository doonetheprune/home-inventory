/**
 * Planning and filling a basket: routes for the app, the plan_basket,
 * fill_basket and shop_status tools, and the household's multibuy setting.
 */
import { z } from 'zod';
import { Id, LarderError, type ModuleContext } from '@larder/core';
import { Shop } from './providers-api';
import { Options, Run, type Shops } from './shop';
import type { Services } from './services';

export function shopFeatures(ctx: ModuleContext, s: Services, shops: Shops) {
  const { providers } = s;
  // Tools wait this long for a shop before answering "still working".
  const toolWait = Number(ctx.config.tool_wait_ms ?? 50_000);

  void shops.tidyAfterRestart().catch((err: unknown) => ctx.log.warn('Couldn\'t tidy unfinished shops', { error: String(err) }));

  /** Waits up to `ms` for a run to finish, then answers it as it is. */
  async function settle(r: { run: Run; done: Promise<void> }, ms: number): Promise<Run> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([r.done, new Promise<void>((res) => { timer = setTimeout(res, ms); })]);
    clearTimeout(timer);
    return shops.get(r.run.id);
  }

  function runText(run: Run, already = false): string {
    if (run.status === 'running') {
      const mins = Math.max(0, Math.round((Date.parse(ctx.core.now()) - Date.parse(run.startedAt)) / 60_000));
      return `${already ? 'A shop is already running' : 'Still working'} at ${run.shopName}: ${run.step.charAt(0).toLowerCase()}${run.step.slice(1)} (started ${mins ? `${mins} minute${mins === 1 ? '' : 's'} ago` : 'just now'}). Ask again in a minute with shop_status (job_id ${run.id}).`;
    }
    return run.summary ?? run.step;
  }

  async function begin(kind: Run['kind'], shop: string | undefined) {
    const { provider, shop: sh } = await providers.resolve(shop);
    return shops.start(kind, provider, sh);
  }

  /* ---------------------------------- Routes --------------------------------- */

  ctx.addRoute({
    method: 'GET', path: '/options', summary: 'Household settings for online shopping',
    response: Options,
    handler: () => shops.options(),
  });

  ctx.addRoute({
    method: 'PUT', path: '/options', summary: 'Change household settings for online shopping', admin: true,
    description: 'multibuyOverPercent: how far over the stock-up amount rounding up to complete a multibuy may go (default 25).',
    body: Options.partial(), response: Options,
    handler: ({ body }) => shops.setOptions(body),
  });

  ctx.addRoute({
    method: 'POST', path: '/shops/:shopId/plan', summary: 'Work out the basket at a shop without adding anything (answers at once; follow it with GET /runs/:id)',
    params: z.object({ shopId: Id }), response: Run,
    async handler({ params }) {
      const p = await providers.forShop(params.shopId);
      if (!p) throw new LarderError('That shop has no shopping provider. Link one to it in Settings → Larder Automations.', 409, 'no_provider');
      const shop = (await ctx.core.shops.list()).find((x) => x.id === params.shopId)!;
      return (await shops.start('plan', p, shop)).run;
    },
  });

  ctx.addRoute({
    method: 'POST', path: '/shops/:shopId/fill', summary: 'Plan and fill the basket at a shop (answers at once; follow it with GET /runs/:id)',
    description: 'What goes in is recorded as expected deliveries from "<shop> delivery". Stops at the basket: nobody pays.',
    params: z.object({ shopId: Id }), response: Run,
    async handler({ params }) {
      const p = await providers.forShop(params.shopId);
      if (!p) throw new LarderError('That shop has no shopping provider. Link one to it in Settings → Larder Automations.', 409, 'no_provider');
      const shop = (await ctx.core.shops.list()).find((x) => x.id === params.shopId)!;
      return (await shops.start('fill', p, shop)).run;
    },
  });

  ctx.addRoute({
    method: 'GET', path: '/runs/:id', summary: 'How a shop is going, or how it went',
    params: z.object({ id: z.string() }), response: Run,
    handler: ({ params }) => shops.get(params.id),
  });

  ctx.addRoute({
    method: 'GET', path: '/shops/:shopId/latest', summary: 'The latest shop at a shop, if any',
    params: z.object({ shopId: Id }), response: z.object({ run: Run.nullable() }),
    async handler({ params }) {
      return { run: await shops.latest(params.shopId) };
    },
  });

  /* ---------------------------------- Tools ---------------------------------- */

  ctx.addTool({
    name: 'plan_basket', title: 'Plan an online shop', readOnly: true,
    description: 'Work out what Larder would put in the online basket (what\'s low, and what\'s on offer at or below its target price) without adding anything. Gets live prices, so it can take a minute or two.',
    input: z.object({ shop: Shop }),
    async run({ shop }) {
      const started = await begin('plan', shop);
      const run = await settle(started, toolWait);
      return { text: runText(run, started.already), data: { job_id: run.id, status: run.status, plan: run.plan } };
    },
  });

  ctx.addTool({
    name: 'fill_basket', title: 'Fill the online basket',
    description: 'Plan the shop and add it to the online basket, recording it as expected deliveries. Book a delivery or collection slot first (list_slots, book_slot) so offers are checked for that day, unless the shop has no slots. Stops at the basket: the person checks it and pays on the shop\'s website. Can take a few minutes; follow it with shop_status.',
    input: z.object({ shop: Shop }),
    async run({ shop }) {
      const started = await begin('fill', shop);
      const run = await settle(started, toolWait);
      return { text: runText(run, started.already), data: { job_id: run.id, status: run.status, added: run.added, failed: run.failed } };
    },
  });

  ctx.addTool({
    name: 'shop_status', title: 'How is the online shop going?', readOnly: true,
    description: 'Progress and result of plan_basket or fill_basket: give its job_id, or the shop for its latest.',
    input: z.object({ job_id: z.string().max(100).optional().describe('From plan_basket or fill_basket'), shop: Shop }),
    async run({ job_id, shop }) {
      let run: Run | null;
      if (job_id) run = await shops.get(job_id);
      else {
        const { shop: sh } = await providers.resolve(shop);
        run = await shops.latest(sh.id);
        if (!run) return { text: `There hasn't been an online shop at ${sh.name} yet.`, data: { status: null } };
      }
      return { text: runText(run), data: { job_id: run.id, status: run.status, kind: run.kind, step: run.step, plan: run.plan, added: run.added, failed: run.failed, error: run.error } };
    },
  });
}
