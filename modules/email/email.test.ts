import { describe, expect, it } from 'vitest';
import { defineModule } from '@larder/core';
import { makeCore } from '../../tests/helpers';
import type { OrderEmail, OrderEmailReading, OrderReader } from '../_shared/order-email';
import { htmlToText, toMessage } from './gmail';
import email, { ruleFor, searchFor, type Rule } from './index';
import { DEFAULT_TIMING, localTime, nextCheck, watches } from './schedule';

type Core = Awaited<ReturnType<typeof makeCore>>;
const call = <T = any>(core: Core, method: string, path: string, body?: unknown, params: Record<string, string> = {}) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = core.modules.routes().find((x) => x.moduleId === 'email' && x.route.method === method && x.route.path === path)!.route;
  return r.handler({ body: r.body ? r.body.parse(body ?? {}) : body, query: {}, params: r.params ? r.params.parse(params) : params, userId: null }) as Promise<T>;
};
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

interface Mail { id: string; subject: string; from: string; sent: string; html?: string; text?: string }

/** Pretend Google: sign-in, the Gmail profile, searching and reading the emails in `inbox`. */
function google(inbox: Mail[]) {
  const searches: string[] = [];
  const opened: string[] = [];
  const state = { refreshFails: false, scope: 'https://www.googleapis.com/auth/gmail.readonly', revoked: [] as string[] };
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    if (u.href === 'https://oauth2.googleapis.com/token') {
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code') return Response.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 });
        return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3599, scope: state.scope, token_type: 'Bearer' });
      }
      if (state.refreshFails) return Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
      return Response.json({ access_token: 'access-2', expires_in: 3599, scope: state.scope, token_type: 'Bearer' });
    }
    if (u.href === 'https://oauth2.googleapis.com/revoke') {
      state.revoked.push(form.get('token') ?? '');
      return new Response('');
    }
    if (u.hostname === 'gmail.googleapis.com') {
      if (u.pathname.endsWith('/profile')) return Response.json({ emailAddress: 'larder.home@gmail.com' });
      if (u.pathname.endsWith('/messages')) {
        searches.push(u.searchParams.get('q') ?? '');
        return Response.json({ messages: inbox.map((m) => ({ id: m.id, threadId: m.id })).reverse() });
      }
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      const m = inbox.find((x) => x.id === id)!;
      opened.push(id);
      const parts = [m.text ? { mimeType: 'text/plain', body: { data: b64(m.text) } } : null, m.html ? { mimeType: 'text/html', body: { data: b64(m.html) } } : null].filter(Boolean);
      return Response.json({ id, internalDate: String(Date.parse(m.sent)), payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: m.subject }, { name: 'From', value: m.from }], parts } });
    }
    throw new Error(`No network in tests (${u})`);
  }) as unknown as typeof fetch;
  return { fetch: fake, searches, opened, state };
}

/** Stands in for the AI module's order reader. */
function fakeAi(answer: (e: OrderEmail) => Omit<OrderEmailReading, 'provider' | 'model'>) {
  const read: OrderEmail[] = [];
  const remembered: unknown[] = [];
  const on = { ready: true };
  const reader: OrderReader = {
    ready: async () => on.ready,
    read: async (e) => {
      read.push(e);
      return { ...answer(e), provider: 'claude', model: 'claude-haiku-5-5' };
    },
    remember: async (...args) => {
      remembered.push(args);
    },
  };
  return { module: defineModule({ id: 'ai', name: 'AI', description: 'x', version: '1', setup(ctx) { ctx.offer('order-reader', reader); } }), read, remembered, on };
}

const CONFIRMED: Mail = {
  id: 'm1', subject: 'Your Tesco order is confirmed', from: 'Tesco <no-reply@tesco.com>', sent: '2026-11-03T18:00:00Z',
  text: 'View this email in your browser',
  html: '<html><head><style>p{color:red}</style></head><body><p>Order 7712&nbsp;3409</p><table><tr><td>Heinz Beanz</td><td>4</td></tr><tr><td>Milk</td><td>Unavailable</td></tr></table><p>Delivery Friday 09:30&ndash;10:30</p></body></html>',
};
const DELIVERED: Mail = { id: 'm2', subject: 'Your Tesco order is complete', from: 'Tesco <no-reply@tesco.com>', sent: '2026-11-06T10:15:00Z', text: 'Your order has been delivered. '.repeat(10) };

/** Stands in for online shopping, to publish a booked slot. */
const shopping: { publish?: (type: string, data: Record<string, unknown>) => void } = {};
const onlineShopping = defineModule({ id: 'online-shopping', name: 'Online shopping', description: 'x', version: '1', setup(ctx) { shopping.publish = ctx.publish; } });

async function household(inbox: Mail[]) {
  const net = google(inbox);
  const ai = fakeAi(() => ({
    readable: true, reference: '7712 3409', delivery: { date: '2026-11-06', from: '09:30', to: '10:30' },
    lines: [
      { text: 'Heinz Beanz 4x415g', count: 1, item: { id: beans.id, name: 'Baked beans', unit: 'tin' }, quantity: 4, match: 'sure', status: 'coming', date: null, price: 4 },
      { text: 'Tesco Milk 4 Pints', count: 1, item: { id: milk.id, name: 'Milk', unit: 'pint' }, quantity: 4, match: 'learnt', status: 'unavailable', date: null, price: null },
      { text: 'Garlic bread', count: 1, item: null, quantity: 1, match: 'none', status: 'coming', date: null, price: 1 },
    ],
  }));
  const core = await makeCore({ modules: [ai.module, onlineShopping, email], fetch: net.fetch, now: '2026-11-03T18:05:00Z' });
  const beans = await core.products.create({ name: 'Baked beans', unit: 'tin' });
  const milk = await core.products.create({ name: 'Milk', unit: 'pint' });
  const bread = await core.products.create({ name: 'Garlic bread', unit: 'each' });
  const tesco = await core.shops.addPreset('Tesco');
  return { core, net, ai, beans, milk, bread, tesco };
}

async function connect(core: Core) {
  await call(core, 'PUT', '/gmail', { address: 'https://abcd1234.ui.nabu.casa/lovelace/0', clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
  const { url } = await call<{ url: string }>(core, 'POST', '/gmail/start');
  const state = new URL(url).searchParams.get('state')!;
  return call(core, 'POST', '/gmail/callback', { state, code: 'good-code' });
}

describe('signing in to Gmail through Home Assistant', () => {
  it('sends the person to Google with the household\'s client, then keeps the sign-in it sends back', async () => {
    const { core } = await household([]);
    await expect(call(core, 'PUT', '/gmail', { address: 'http://homeassistant.local:8123' })).rejects.toThrow('Google only sends people back to https:// addresses');
    await expect(call(core, 'PUT', '/gmail', { clientId: 'not-a-client' })).rejects.toThrow('ends in .apps.googleusercontent.com');
    await expect(call(core, 'POST', '/gmail/start')).rejects.toThrow('step 1');

    const status = await call(core, 'PUT', '/gmail', { address: 'https://abcd1234.ui.nabu.casa/lovelace/0', clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
    expect(status).toMatchObject({ connected: false, address: 'https://abcd1234.ui.nabu.casa', redirectUri: 'https://abcd1234.ui.nabu.casa/api/larder/gmail/callback', secretSet: true });
    expect(JSON.stringify(status)).not.toContain('GOCSPX-secret');

    const { url } = await call<{ url: string }>(core, 'POST', '/gmail/start');
    const q = new URL(url).searchParams;
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect([q.get('client_id'), q.get('redirect_uri'), q.get('scope'), q.get('access_type')]).toEqual(['123-abc.apps.googleusercontent.com', 'https://abcd1234.ui.nabu.casa/api/larder/gmail/callback', 'https://www.googleapis.com/auth/gmail.readonly', 'offline']);

    await expect(call(core, 'POST', '/gmail/callback', { state: 'made-up', code: 'good-code' })).rejects.toThrow('That sign-in has expired or was already used.');
    expect(await call(core, 'POST', '/gmail/callback', { state: q.get('state'), code: 'good-code' })).toEqual({ account: 'larder.home@gmail.com', message: 'Gmail connected: Larder reads order emails from larder.home@gmail.com.' });
    await expect(call(core, 'POST', '/gmail/callback', { state: q.get('state'), code: 'good-code' })).rejects.toThrow('already used');
    expect(await call(core, 'GET', '/')).toMatchObject({ connected: true, account: 'larder.home@gmail.com', problem: null });
  });

  it('says so when Google wasn\'t allowed to read Gmail, or the sign-in has gone stale', async () => {
    const { core, net } = await household([]);
    await call(core, 'PUT', '/gmail', { address: 'https://abcd1234.ui.nabu.casa', clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
    const state = async () => new URL((await call<{ url: string }>(core, 'POST', '/gmail/start')).url).searchParams.get('state');
    await expect(call(core, 'POST', '/gmail/callback', { state: await state(), error: 'access_denied' })).rejects.toThrow('Google says it wasn\'t allowed');
    net.state.scope = 'openid';
    await expect(call(core, 'POST', '/gmail/callback', { state: await state(), code: 'good-code' })).rejects.toThrow('allow it to view your email messages and settings');
    const late = await state();
    core.clock.set('2026-11-03T18:25:00Z');
    await expect(call(core, 'POST', '/gmail/callback', { state: late, code: 'good-code' })).rejects.toThrow('expired');
  });

  it('disconnects, and Google forgets the sign-in', async () => {
    const { core, net } = await household([]);
    await connect(core);
    expect(await call(core, 'DELETE', '/gmail')).toMatchObject({ connected: false, account: null, address: 'https://abcd1234.ui.nabu.casa' });
    expect(net.state.revoked).toEqual(['refresh-1']);
  });
});

describe('reading order emails', () => {
  const rules = (tesco: string): Array<Omit<Rule, 'id'>> => [
    { shopId: tesco, kind: 'confirmed', subject: 'order is confirmed', from: 'tesco.com' },
    { shopId: tesco, kind: 'delivered', subject: 'order is complete', from: '' },
  ];

  it('turns a confirmation into a delivery on the way, then the delivered email into stock', async () => {
    const { core, net, ai, beans, milk, tesco } = await household([CONFIRMED]);
    await connect(core);
    // A basket filled online: a pending order for beans and milk.
    await core.stock.expect({ productId: beans.id, quantity: 4, source: 'Tesco delivery', pending: true });
    await core.stock.expect({ productId: milk.id, quantity: 4, source: 'Tesco delivery', pending: true });
    expect(await call(core, 'POST', '/check')).toEqual({ message: 'Add the subjects of your shops\' order emails first, so Larder knows which to read.' });
    await call(core, 'PUT', '/settings', { rules: rules(tesco.id) });

    const { message } = await call(core, 'POST', '/check');
    expect(message).toBe('Tesco order 7712 3409: 1 thing on the way for Fri 6 Nov, 09:30–10:30. Not available: Milk. 1 line to check.');
    // Only the rules' subjects are searched for, and only matching emails opened.
    expect(net.searches[0]).toMatch(/^\{subject:"order is confirmed" subject:"order is complete"\} after:\d+$/);
    // The HTML was read, as the plain text was only a stub.
    expect(ai.read[0]).toMatchObject({ shopId: tesco.id, shopName: 'Tesco', subject: 'Your Tesco order is confirmed' });
    expect(ai.read[0]!.text).toContain('Order 7712 3409');
    expect(ai.read[0]!.text).not.toContain('color:red');
    // Beans: the pending order confirmed, on its way for Friday. Milk: off the pending order, so it's bought next time.
    expect((await core.stock.deliveries()).map((d) => [d.source, d.eta, d.itemCount])).toEqual([['Tesco delivery', '2026-11-06', 1]]);
    expect(await core.stock.pendingOrders()).toEqual([]);
    expect(core.events.log.find((e) => e.type === 'email.order_read')?.data).toMatchObject({ shop: 'Tesco', reference: '7712 3409', coming: 1, unavailable: ['Milk'], to_check: 1, delivery_date: '2026-11-06' });

    // Nothing is read twice.
    expect((await call(core, 'POST', '/check')).message).toBe('Nothing new.');
    expect(ai.read).toHaveLength(1);
    const [seen] = await call(core, 'GET', '/emails');
    expect(seen.lines.map((l: { state: string }) => l.state)).toEqual(['done', 'done', 'todo']);
  });

  it('marks a delivery arrived from the delivered email, leaving a later order from the same shop on its way', async () => {
    const { core, beans, milk, tesco } = await household([DELIVERED]);
    await connect(core);
    await call(core, 'PUT', '/settings', { rules: rules(tesco.id) });
    core.clock.set('2026-11-06T10:20:00Z');
    await core.stock.expect({ productId: beans.id, quantity: 4, source: 'Tesco delivery', eta: '2026-11-06' });
    await core.stock.expect({ productId: milk.id, quantity: 4, source: 'Tesco delivery', eta: '2026-11-13' });
    expect((await call(core, 'POST', '/check')).message).toBe('Tesco delivered: 1 thing moved into stock.');
    expect((await core.products.summary(beans.id)).inStock).toBe(4);
    expect((await core.products.summary(milk.id)).expected).toBe(4);
  });

  it('lets someone match a line it wasn\'t sure of, and remembers the shop\'s name for it', async () => {
    const { core, ai, bread, tesco } = await household([CONFIRMED]);
    await connect(core);
    await call(core, 'PUT', '/settings', { rules: rules(tesco.id) });
    await call(core, 'POST', '/check');
    const seen = await call(core, 'POST', '/emails/:id/lines/:n', { productId: bread.id, quantity: 2 }, { id: 'm1', n: '2' });
    expect(seen.lines[2]).toMatchObject({ state: 'done', item: { id: bread.id }, quantity: 2 });
    expect((await core.products.summary(bread.id)).expected).toBe(2);
    expect(ai.remembered).toEqual([[tesco.id, 'Garlic bread', bread.id, 2]]);
  });

  it('keeps an order confirmation for later when no AI is set up', async () => {
    const { core, ai, beans, tesco } = await household([CONFIRMED]);
    await connect(core);
    await call(core, 'PUT', '/settings', { rules: rules(tesco.id) });
    ai.on.ready = false;
    expect((await call(core, 'POST', '/check')).message).toBe('Tesco order confirmation found. Set up AI (Settings → AI) to read it, then press Read it.');
    ai.on.ready = true;
    expect(await call(core, 'POST', '/emails/:id/read', undefined, { id: 'm1' })).toMatchObject({ outcome: 'expected', reference: '7712 3409' });
    expect((await core.products.summary(beans.id)).expected).toBe(4);
  });

  it('doesn\'t add the same order twice when the shop emails it again', async () => {
    const again = { ...CONFIRMED, id: 'm3', sent: '2026-11-04T08:00:00Z' };
    const { core, beans, tesco } = await household([CONFIRMED, again]);
    await connect(core);
    await call(core, 'PUT', '/settings', { rules: rules(tesco.id) });
    const { message } = await call(core, 'POST', '/check');
    expect(message).toContain('Tesco order 7712 3409 was read already (Tue 3 Nov); nothing more was added.');
    expect((await core.products.summary(beans.id)).expected).toBe(4);
  });

  it('stops and says so when Google signs Larder out', async () => {
    const { core, net, tesco } = await household([]);
    await connect(core);
    await call(core, 'PUT', '/settings', { rules: rules(tesco.id) });
    core.clock.set('2026-11-03T20:00:00Z');
    net.state.refreshFails = true;
    await expect(call(core, 'POST', '/check')).rejects.toThrow('Google signed Larder out of Gmail');
    const status = await call(core, 'GET', '/');
    expect(status.problem).toContain('Connect Gmail again');
    expect(status.next).toBeNull();
    expect(core.events.log.find((e) => e.type === 'email.failed')?.data).toMatchObject({ needs_you: true });
  });

  it('watches a slot booked online', async () => {
    const { core, tesco } = await household([]);
    await connect(core);
    await call(core, 'PUT', '/settings', { rules: rules(tesco.id), timing: { ...DEFAULT_TIMING, otherwise: { everyHours: 0 } } });
    shopping.publish!('online-shopping.slot_booked', { shop: 'Tesco', start: '2026-11-06T09:30', end: '2026-11-06T10:30' });
    await new Promise((r) => setTimeout(r, 10));
    // 3 hours before 09:30 in London (GMT in November).
    expect((await call(core, 'GET', '/')).next).toEqual({ at: '2026-11-06T06:30:00.000Z', why: 'around the Tesco delivery' });
  });
  it('lets assistants see the emails read, match a line, and leave one out', async () => {
    const { core, ai, bread, tesco } = await household([CONFIRMED]);
    await connect(core);
    await call(core, 'PUT', '/settings', { rules: rules(tesco.id) });
    await call(core, 'POST', '/check');
    const listed = (await core.assistant.call('order_emails', { waiting_only: true })).text;
    expect(listed).toContain('Tesco order 7712 3409 (id m1)');
    expect(listed).toContain('line 3: "Garlic bread" ×1, 1.00');
    expect((await core.assistant.call('match_order_line', { email: '7712 3409', line: 3, item: 'garlic bread', quantity: 2 })).text).toBe('"Garlic bread" is Garlic bread: 2 on the way from Tesco. Larder will know it next time.');
    expect((await core.products.summary(bread.id)).expected).toBe(2);
    expect(ai.remembered).toEqual([[tesco.id, 'Garlic bread', bread.id, 2]]);
    expect((await core.assistant.call('order_emails', { waiting_only: true })).text).toBe('No order lines are waiting.');
    expect((await core.assistant.call('skip_order_line', { email: 'm1', line: 2 })).text).toMatch(/^Left out "/);
    await expect(core.assistant.call('match_order_line', { email: 'm1', line: 9, item: 'garlic bread' })).rejects.toThrow('That email has 3 lines.');
  });
});

describe('which emails are which', () => {
  const rules: Rule[] = [
    { id: '1', shopId: 't', kind: 'confirmed', subject: 'Your order', from: '' },
    { id: '2', shopId: 't', kind: 'delivered', subject: 'Your order has been delivered', from: 'tesco' },
  ];
  it('picks the most particular rule, checking the sender when the rule names one', () => {
    expect(ruleFor(rules, 'Your order has been delivered', 'Tesco <a@tesco.com>')?.id).toBe('2');
    expect(ruleFor(rules, 'YOUR ORDER has been delivered', 'Someone else')?.id).toBe('1');
    expect(ruleFor(rules, 'Weekly offers', 'Tesco')).toBeNull();
  });
  it('searches Gmail for just those subjects', () => {
    expect(searchFor(rules, Date.parse('2026-11-03T00:00:00Z'))).toBe('{subject:"Your order" subject:"Your order has been delivered"} after:1793664000');
  });
});

describe('reading an email', () => {
  it('turns HTML into lines of text', () => {
    expect(htmlToText('<p>Hello&nbsp;there</p><table><tr><td>Beans</td><td>£1.20</td></tr></table><script>x()</script>&#163;3 &pound;4')).toBe('Hello there\nBeans\t£1.20\t\n\n£3 £4');
  });
  it('prefers the plain text unless it is only a stub', () => {
    const msg = (text: string) => toMessage({ id: 'x', internalDate: '1762192800000', payload: { headers: [{ name: 'subject', value: 'Hi' }], parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }, { mimeType: 'text/html', body: { data: b64('<p>From the HTML</p>') } }] } });
    expect(msg('Short stub').text).toBe('From the HTML');
    expect(msg('A long plain text email. '.repeat(10)).text).toContain('A long plain text email.');
    expect(msg('x').sentAt).toBe('2025-11-03T18:00:00.000Z');
  });
});

describe('when to check', () => {
  const H = 3_600_000;
  const at = (iso: string) => Date.parse(iso);
  it('turns the household\'s time into the time, summer or winter', () => {
    expect(new Date(localTime('2026-11-06', '09:30', 'Europe/London')).toISOString()).toBe('2026-11-06T09:30:00.000Z');
    expect(new Date(localTime('2026-07-06', '09:30', 'Europe/London')).toISOString()).toBe('2026-07-06T08:30:00.000Z');
  });
  it('checks every 5 minutes for 2 hours after a basket is filled, then every 3 hours', () => {
    const list = watches({ timing: DEFAULT_TIMING, timeZone: 'Europe/London', pending: [{ source: 'Tesco delivery', since: '2026-11-03T18:00:00Z' }], deliveries: [], windows: [] });
    expect(nextCheck(at('2026-11-03T18:10:00Z'), at('2026-11-03T18:12:00Z'), list, DEFAULT_TIMING)).toEqual({ at: at('2026-11-03T18:15:00Z'), why: 'waiting for Tesco delivery\'s confirmation' });
    expect(nextCheck(at('2026-11-03T20:00:00Z'), at('2026-11-03T20:01:00Z'), list, DEFAULT_TIMING)).toEqual({ at: at('2026-11-03T20:00:00Z') + 3 * H, why: 'the regular check' });
  });
  it('checks every 5 minutes from 3 hours before a slot to 2 hours after it', () => {
    const list = watches({ timing: DEFAULT_TIMING, timeZone: 'Europe/London', pending: [], deliveries: [], windows: [{ shopName: 'Tesco', date: '2026-11-06', from: '09:30', to: '10:30' }] });
    expect(list).toEqual([{ why: 'around the Tesco delivery', from: at('2026-11-06T06:30:00Z'), until: at('2026-11-06T12:30:00Z'), every: 5 }]);
    expect(nextCheck(at('2026-11-06T12:00:00Z'), at('2026-11-06T12:01:00Z'), list, DEFAULT_TIMING)?.at).toBe(at('2026-11-06T12:05:00Z'));
    expect(nextCheck(at('2026-11-06T04:00:00Z'), at('2026-11-06T04:01:00Z'), list, DEFAULT_TIMING)).toEqual({ at: at('2026-11-06T06:30:00Z'), why: 'around the Tesco delivery' });
  });
  it('watches a delivery\'s whole day when no slot is known, and not at all when switched off', () => {
    const timing = { ...DEFAULT_TIMING, otherwise: { everyHours: 0 } };
    const list = watches({ timing, timeZone: 'Europe/London', pending: [], deliveries: [{ source: 'Toolstation order', eta: '2026-11-07' }], windows: [] });
    expect(list).toEqual([{ why: 'around the Toolstation delivery', from: at('2026-11-07T05:00:00Z'), until: at('2026-11-07T22:00:00Z'), every: 5 }]);
    expect(nextCheck(at('2026-11-08T00:00:00Z'), at('2026-11-08T00:00:00Z'), list, timing)).toBeNull();
  });

});
