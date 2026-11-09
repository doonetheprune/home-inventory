import { describe, expect, it } from 'vitest';
import { defineModule, type ModuleContext } from '@larder/core';
import { makeCore } from '../../tests/helpers';
import type { OrderEmail, OrderReader } from '../_shared/order-email';
import ai from './index';
import type { OrderReading } from './orders';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = (core: Core, method: string, path: string, body?: unknown) => {
  const r = core.modules.routes().find((x) => x.moduleId === 'ai' && x.route.method === method && x.route.path === path)!.route;
  return r.handler({ body: r.body ? r.body.parse(body) : body, query: {}, params: {}, userId: null });
};

/** Pretend Claude, answering every request with `answer`, and keeping what was sent. */
function claude(answer: () => OrderReading) {
  const sent: Array<Array<{ type: string; text?: string }>> = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (u.pathname.startsWith('/v1/models/')) return Response.json({ id: 'claude-haiku-5-5', type: 'model', display_name: 'Claude', created_at: '2026-01-01T00:00:00Z', capabilities: { effort: { supported: true } } });
    if (u.pathname === '/v1/messages') {
      sent.push((body!.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]!.content);
      return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: JSON.stringify(answer()) }], usage: { input_tokens: 2000, output_tokens: 300 } });
    }
    throw new Error(`No network in tests (${u})`);
  }) as unknown as typeof fetch;
  return { fetch: fake, sent };
}

const line = (l: Partial<OrderReading['lines'][number]> & { text: string }): OrderReading['lines'][number] => ({ count: 1, price: null, item: null, quantity: null, sure: true, status: 'coming', delivery_date: null, ...l });

const ORDER: OrderReading = {
  readable: true,
  reference: ' 7712 3409 ',
  delivery_date: '2026-11-06',
  delivery_from: '9:30',
  delivery_to: '10:30',
  lines: [
    line({ text: 'Heinz Baked Beanz 4x415g', price: 4, item: 1, quantity: 4 }),
    line({ text: 'Andrex Classic Clean 9 Rolls', count: 2, item: 3, quantity: 18, delivery_date: '2026-11-08' }),
    line({ text: 'Tesco Semi Skimmed Milk 4 Pints', item: 2, quantity: 4, status: 'unavailable' }),
    line({ text: 'Tesco Garlic Bread', item: null }),
    line({ text: 'Bananas loose', item: 2, quantity: 5, sure: false }),
  ],
};

const EMAIL: OrderEmail = { shopId: null, shopName: 'Tesco', subject: 'Your order is confirmed', text: 'Thanks for your order 7712 3409. Delivery Friday 9:30–10:30.', sentAt: '2026-11-03T18:02:00Z' };

async function household() {
  const net = claude(() => ORDER);
  let other: ModuleContext | undefined;
  const asker = defineModule({ id: 'asker', name: 'Asker', description: 'x', version: '1', setup(ctx) { other = ctx; } });
  const core = await makeCore({ modules: [ai, asker], fetch: net.fetch });
  const reader = () => other!.offered<OrderReader>('ai.order-reader')!;
  const beans = await core.products.create({ name: 'Baked beans', unit: 'tin' });
  const milk = await core.products.create({ name: 'Semi-skimmed milk', unit: 'pint' });
  const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll' });
  const tesco = await core.shops.addPreset('Tesco');
  return { core, net, reader, beans, milk, loo, tesco };
}

describe('order emails', () => {
  it('reads what is coming, what is not and when, matching lines to items', async () => {
    const { core, net, reader, beans, loo, milk, tesco } = await household();
    expect(await reader().ready()).toBe(false);
    await expect(reader().read(EMAIL)).rejects.toThrow('Switch on Claude or Gemini in Settings → AI, with an API key, to read order emails.');
    await call(core, 'PUT', '/settings', { claude: { apiKey: 'sk-ant-test-0000-wxyz', model: 'claude-haiku-5-5' } });
    expect(await reader().ready()).toBe(true);

    const r = await reader().read({ ...EMAIL, shopId: tesco.id });
    expect(r).toMatchObject({ readable: true, reference: '7712 3409', delivery: { date: '2026-11-06', from: '09:30', to: '10:30' }, provider: 'claude' });
    expect(r.lines.map((l) => [l.item?.id ?? null, l.quantity, l.match, l.status, l.date])).toEqual([
      [beans.id, 4, 'sure', 'coming', null],
      [loo.id, 18, 'sure', 'coming', '2026-11-08'],
      [milk.id, 4, 'sure', 'unavailable', null],
      [null, 1, 'none', 'coming', null],
      [milk.id, 5, 'guess', 'coming', null],
    ]);
    // The email goes first, marked off as something to read; then what to do, with the household's items.
    const [email, ask] = net.sent[0]!;
    expect(email!.text).toContain('<<<\nThanks for your order 7712 3409.');
    expect(ask!.text).toContain('sent on 2026-11-03');
    expect(ask!.text).toContain('1. Baked beans (bought in tins)');
  });

  it('remembers how a shop names an item, as receipts do', async () => {
    const { core, reader, loo, tesco } = await household();
    await call(core, 'PUT', '/settings', { claude: { apiKey: 'sk-ant-test-0000-wxyz', model: 'claude-haiku-5-5' } });
    await reader().remember(tesco.id, 'Tesco Garlic Bread', loo.id, 1);
    const r = await reader().read({ ...EMAIL, shopId: tesco.id });
    expect(r.lines[3]).toMatchObject({ item: { id: loo.id }, match: 'learnt', quantity: 1 });
  });

  it('is only offered while the AI module is on', async () => {
    const { core, reader } = await household();
    await core.modules.setEnabled('ai', false);
    expect(reader()).toBeUndefined();
  });
});
