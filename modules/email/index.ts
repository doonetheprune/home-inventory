/**
 * Order emails: Larder reads shops' order and delivery emails from Gmail, with
 * read-only access the household grants through its own Google Cloud client.
 * The household says which emails are which by their subject (and sender):
 * "this is Tesco's order confirmation", "this is Toolstation's delivered
 * email". Only emails matching those are ever opened.
 *
 * - An order confirmation is read by the AI module ("ai.order-reader"): what's
 *   coming becomes an expected delivery (confirming a filled basket's pending
 *   order), what's unavailable comes off the pending order so it's bought next
 *   time, and lines it isn't sure of wait for someone to match.
 * - A delivered email marks that shop's delivery arrived (no AI needed).
 *
 * Gmail is checked often while it matters (after a basket is filled, around a
 * delivery) and seldom otherwise (schedule.ts). Google sends the person back
 * through Home Assistant after signing in (the Larder integration's page),
 * which passes the sign-in on to /gmail/callback.
 */
import { z } from 'zod';
import { amount, andList, defineModule, LarderError, newId, ValidationError } from '@larder/core';
import type { OrderEmailReading, OrderReader } from '../_shared/order-email';
import { authorizeUrl, CALLBACK_PATH, gmail, GmailSignedOut, SCOPE, type Client, type Message } from './gmail';
import { DEFAULT_TIMING, nextCheck, Timing, watches, type DeliveryWindow } from './schedule';

export const Rule = z.object({
  id: z.string().min(1).max(40),
  shopId: z.string().min(1),
  /** confirmed: the order confirmation (read by the AI). delivered: the order has been delivered or completed. */
  kind: z.enum(['confirmed', 'delivered']),
  /** Words the subject contains, e.g. "Your order is confirmed". Case doesn't matter. */
  subject: z.string().trim().min(3, 'Give a few words of the subject').max(150),
  /** Words the sender contains, e.g. "tesco.com". Optional. */
  from: z.string().trim().max(120).default(''),
});
export type Rule = z.infer<typeof Rule>;

const Item = z.object({ id: z.string(), name: z.string(), unit: z.string() });
export const Line = z.object({
  text: z.string(),
  count: z.number(),
  quantity: z.number(),
  item: Item.nullable(),
  match: z.enum(['learnt', 'sure', 'guess', 'none']),
  status: z.enum(['coming', 'unavailable']),
  date: z.string().nullable(),
  price: z.number().nullable(),
  /** done: dealt with. todo: waiting for someone to match it. skipped: not something Larder keeps. */
  state: z.enum(['done', 'todo', 'skipped']),
});
export const Seen = z.object({
  id: z.string(),
  sentAt: z.string(),
  subject: z.string(),
  from: z.string(),
  shopId: z.string().nullable(),
  shopName: z.string(),
  kind: z.enum(['confirmed', 'delivered']).nullable(),
  /**
   * expected: an order read and on its way. arrived: a delivery marked arrived. nothing: nothing to do.
   * waiting: an order confirmation no AI could read yet. failed: the AI couldn't read it. ignored: no rule matched.
   */
  outcome: z.enum(['expected', 'arrived', 'nothing', 'waiting', 'failed', 'ignored']),
  message: z.string(),
  reference: z.string().nullable(),
  delivery: z.object({ date: z.string().nullable(), from: z.string().nullable(), to: z.string().nullable() }).nullable(),
  lines: z.array(Line),
  at: z.string(),
});
export type Seen = z.infer<typeof Seen>;

interface Connection {
  /** Home Assistant's address from outside the house (Nabu Casa, or the household's own), e.g. https://abcd.ui.nabu.casa. */
  address: string | null;
  clientId: string | null;
  clientSecret: string | null;
  account: string | null;
  refreshToken: string | null;
  accessToken: string | null;
  expiresAt: number | null;
  connectedAt: string | null;
  /** Something only the person can fix (sign in again), shown until they do. Checking stops meanwhile. */
  problem: string | null;
}
const EMPTY: Connection = { address: null, clientId: null, clientSecret: null, account: null, refreshToken: null, accessToken: null, expiresAt: null, connectedAt: null, problem: null };
interface Saved { rules: Rule[]; timing: Timing }
interface Checked { lastCheck: string | null; lastResult: string | null; lastError: string | null }
interface Window extends DeliveryWindow { shopId: string | null; at: string }

export const Status = z.object({
  connected: z.boolean(),
  account: z.string().nullable(),
  address: z.string().nullable(),
  /** What to give Google as the authorised redirect URI. */
  redirectUri: z.string().nullable(),
  clientId: z.string().nullable(),
  secretSet: z.boolean(),
  problem: z.string().nullable(),
  rules: z.array(Rule),
  timing: Timing,
  lastCheck: z.string().nullable(),
  lastResult: z.string().nullable(),
  lastError: z.string().nullable(),
  next: z.object({ at: z.string(), why: z.string() }).nullable(),
  /** Whether an AI can read order confirmations; null when the AI module is off. */
  aiReady: z.boolean().nullable(),
  scope: z.string(),
  callbackPath: z.string(),
});

const HOUR = 3_600_000;
/** Sign-ins not finished in this time have to start again. */
const SIGN_IN_MS = 15 * 60_000;
const KEEP_EMAILS = 60;

const firstWord = (s: string) => s.trim().toLowerCase().split(/\s+/)[0] ?? '';
const sameShop = (source: string, shopName: string) => firstWord(source) === firstWord(shopName);
const cap = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Home Assistant's outside address as just its origin, e.g. "https://abcd.ui.nabu.casa". */
export function originOf(address: string): string {
  let u: URL;
  try {
    u = new URL(address.trim());
  } catch {
    throw new ValidationError('That isn\'t a web address. Give Home Assistant\'s address from outside the house, e.g. https://abcd1234.ui.nabu.casa.');
  }
  if (u.protocol !== 'https:') throw new ValidationError('Google only sends people back to https:// addresses. Use Home Assistant\'s https address, e.g. https://abcd1234.ui.nabu.casa.');
  return u.origin;
}

/** The household's rule for an email, the most particular subject first. Null when none says what it is. */
export function ruleFor(rules: Rule[], subject: string, from: string): Rule | null {
  const s = subject.toLowerCase();
  const f = from.toLowerCase();
  return [...rules]
    .sort((a, b) => b.subject.length - a.subject.length)
    .find((r) => s.includes(r.subject.toLowerCase()) && (!r.from || f.includes(r.from.toLowerCase()))) ?? null;
}

/** The Gmail search for the rules' subjects since a time: only these emails are ever opened. */
export function searchFor(rules: Rule[], since: number): string {
  const subjects = [...new Set(rules.map((r) => r.subject.replace(/["{}]/g, ' ').replace(/\s+/g, ' ').trim()))].filter(Boolean);
  return `{${subjects.map((s) => `subject:"${s}"`).join(' ')}} after:${Math.floor(since / 1000)}`;
}

export default defineModule({
  id: 'email',
  name: 'Order emails',
  description: 'Reads shops\' order and delivery emails from Gmail: orders become deliveries on the way, and delivery emails mark them arrived. Set up in Settings → Order emails.',
  version: '1.0.0',
  defaultEnabled: true,
  setup(ctx) {
    const g = gmail(ctx.fetch);
    const store = ctx.collection<Saved>('settings');
    const conn = ctx.collection<Connection>('gmail');
    const signIns = ctx.collection<{ at: string }>('sign-ins');
    const emails = ctx.collection<Seen>('emails');
    const windows = ctx.collection<Window>('windows');
    const checks = ctx.collection<Checked>('checks');
    const now = () => Date.parse(ctx.core.now());

    const settings = async (): Promise<Saved> => {
      const s = await store.get('settings');
      return { rules: s?.rules ?? [], timing: s?.timing ?? DEFAULT_TIMING };
    };
    const connection = async (): Promise<Connection> => ({ ...EMPTY, ...(await conn.get('gmail')) });
    const saveConnection = (c: Connection) => conn.put('gmail', c);
    const checked = async (): Promise<Checked> => (await checks.get('checks')) ?? { lastCheck: null, lastResult: null, lastError: null };
    const redirectUri = (c: Connection) => (c.address ? `${c.address}${CALLBACK_PATH}` : null);
    const client = (c: Connection): Client | null => (c.clientId && c.clientSecret && c.address ? { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: redirectUri(c)! } : null);
    const connected = (c: Connection) => !!(c.refreshToken && client(c));
    const reader = () => ctx.offered<OrderReader>('ai.order-reader');
    const shopName = async (shopId: string | null) => (shopId ? (await ctx.core.shops.list()).find((s) => s.id === shopId)?.name ?? null : null);

    /** A fresh access token, signing in again with the refresh token when the last has run out. */
    async function accessToken(c: Connection): Promise<string> {
      if (c.accessToken && c.expiresAt && c.expiresAt - 60_000 > now()) return c.accessToken;
      const cl = client(c);
      if (!cl || !c.refreshToken) throw new GmailSignedOut('Connect Gmail first (Settings → Order emails).');
      const t = await g.refresh(cl, c.refreshToken);
      await saveConnection({ ...c, accessToken: t.accessToken, expiresAt: now() + t.expiresIn * 1000, refreshToken: t.refreshToken ?? c.refreshToken });
      return t.accessToken;
    }

    /* ---------------- when to check ---------------- */

    async function plan(): Promise<{ at: number; why: string } | null> {
      const [s, c, pending, deliveries, ws, household] = await Promise.all([
        settings(), checked(), ctx.core.stock.pendingOrders(), ctx.core.stock.deliveries(), windows.list(), ctx.core.settings.get(),
      ]);
      const today = ctx.core.today();
      // Slots more than a couple of days gone are no use.
      for (const w of ws) if (w.data.date < shiftDate(today, -2)) await windows.remove(w.id);
      const list = watches({ timing: s.timing, timeZone: household.timeZone, pending, deliveries, windows: ws.map((w) => w.data).filter((w) => w.date >= shiftDate(today, -2)) });
      return nextCheck(c.lastCheck ? Date.parse(c.lastCheck) : null, now(), list, s.timing);
    }

    let running: Promise<string> | null = null;
    /** Looks in Gmail for emails the rules point to that haven't been dealt with, and deals with them. One at a time. */
    function check(): Promise<string> {
      running ??= runCheck().finally(() => {
        running = null;
      });
      return running;
    }

    async function runCheck(): Promise<string> {
      const c = await connection();
      if (!connected(c)) throw new LarderError('Connect Gmail first (Settings → Order emails).', 409, 'gmail_not_connected');
      const s = await settings();
      const at = now();
      const last = await checked();
      if (!s.rules.length) {
        const message = 'Add the subjects of your shops\' order emails first, so Larder knows which to read.';
        await checks.put('checks', { lastCheck: new Date(at).toISOString(), lastResult: message, lastError: null });
        return message;
      }
      // A little overlap with the last check, so nothing that arrived during it is missed. The first looks back three days.
      const since = (last.lastCheck ? Date.parse(last.lastCheck) : at - 72 * HOUR) - 6 * HOUR;
      try {
        const token = await accessToken(c);
        const ids = await g.search(token, searchFor(s.rules, since));
        const said: string[] = [];
        for (const id of ids.reverse()) {
          if (await emails.get(id)) continue;
          const done = await handle(await g.message(token, id), s.rules);
          if (done) said.push(done);
        }
        const message = said.length ? said.join(' ') : 'Nothing new.';
        await checks.put('checks', { lastCheck: new Date(at).toISOString(), lastResult: message, lastError: null });
        await tidy();
        return message;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await checks.put('checks', { lastCheck: new Date(at).toISOString(), lastResult: null, lastError: message });
        if (err instanceof GmailSignedOut) {
          await saveConnection({ ...(await connection()), problem: message, accessToken: null, expiresAt: null });
          ctx.publish('email.failed', { message, needs_you: true });
        }
        throw err;
      }
    }

    /** Keeps the latest emails dealt with; ids of older ones are kept (without their text) so they're never read twice. */
    async function tidy() {
      const all = (await emails.list()).sort((a, b) => b.data.at.localeCompare(a.data.at));
      for (const old of all.slice(KEEP_EMAILS)) if (old.data.lines.length || old.data.message) await emails.put(old.id, { ...old.data, lines: [], message: '' });
    }

    /* ---------------- dealing with an email ---------------- */

    async function handle(m: Message, rules: Rule[]): Promise<string | null> {
      const rule = ruleFor(rules, m.subject, m.from);
      const base: Seen = { id: m.id, sentAt: m.sentAt, subject: cap(m.subject, 200), from: cap(m.from, 200), shopId: rule?.shopId ?? null, shopName: '', kind: rule?.kind ?? null, outcome: 'ignored', message: '', reference: null, delivery: null, lines: [], at: ctx.core.now() };
      if (!rule) {
        await emails.put(m.id, base);
        return null;
      }
      const name = (await shopName(rule.shopId)) ?? 'The shop';
      const seen = { ...base, shopName: name };
      const done = rule.kind === 'delivered' ? await delivered(seen) : await confirmed(seen, m.text);
      await emails.put(m.id, done);
      return done.message;
    }

    async function delivered(seen: Seen): Promise<Seen> {
      const today = ctx.core.today();
      const sources = [...new Set([...(await ctx.core.stock.deliveries()), ...(await ctx.core.stock.pendingOrders())].map((d) => d.source).filter((s) => sameShop(s, seen.shopName)))];
      let arrived = 0;
      for (const source of sources) {
        try {
          arrived += (await ctx.core.stock.arrive({ source, dueBy: today })).arrived;
        } catch (err) {
          if (!(err instanceof ValidationError)) throw err;
        }
      }
      for (const w of await windows.list()) if (sameShop(w.data.shopName, seen.shopName) && w.data.date <= today) await windows.remove(w.id);
      ctx.publish('email.delivered', { shop: seen.shopName, arrived });
      return arrived
        ? { ...seen, outcome: 'arrived', message: `${seen.shopName} delivered: ${plural(arrived, 'thing')} moved into stock.` }
        : { ...seen, outcome: 'nothing', message: `${seen.shopName} says it delivered, but nothing from ${seen.shopName} was on its way.` };
    }

    async function confirmed(seen: Seen, text: string): Promise<Seen> {
      const r = reader();
      if (!r || !(await r.ready())) {
        return { ...seen, outcome: 'waiting', message: `${seen.shopName} order confirmation found. Set up AI (Settings → AI) to read it, then press Read it.` };
      }
      let reading: OrderEmailReading;
      try {
        reading = await r.read({ shopId: seen.shopId, shopName: seen.shopName, subject: seen.subject, text, sentAt: seen.sentAt });
      } catch (err) {
        if (!(err instanceof LarderError)) throw err;
        return { ...seen, outcome: 'failed', message: `Couldn't read ${seen.shopName}'s order confirmation: ${err.message}` };
      }
      const reference = reading.reference;
      if (!reading.readable && !reading.lines.length) return { ...seen, outcome: 'failed', message: `${seen.shopName}'s email didn't read as an order. Check its rule in Settings → Order emails.` };
      // The same order emailed again (a reminder, or "your order has been updated"): it isn't added twice.
      if (reference) {
        const before = (await emails.list()).find((x) => x.data.outcome === 'expected' && x.data.reference === reference && x.data.shopId === seen.shopId);
        if (before) return { ...seen, outcome: 'nothing', reference, message: `${seen.shopName} order ${reference} was read already (${day(before.data.sentAt.slice(0, 10))}); nothing more was added.` };
      }
      const source = `${seen.shopName} delivery`;
      const eta = reading.delivery.date;
      const lines: Seen['lines'] = [];
      const coming: string[] = [];
      const unavailable: string[] = [];
      for (const l of reading.lines) {
        const sure = !!l.item && (l.match === 'learnt' || l.match === 'sure');
        const line = { text: l.text, count: l.count, quantity: l.quantity, item: l.item, match: l.match, status: l.status, date: l.date, price: l.price };
        if (l.status === 'unavailable') {
          if (sure) await ctx.core.stock.cancelOrders({ source, productId: l.item!.id }).catch((err: unknown) => { if (!(err instanceof ValidationError)) throw err; });
          unavailable.push(l.item?.name ?? l.text);
          lines.push({ ...line, state: 'done' });
        } else if (sure) {
          await ctx.core.stock.expect({ productId: l.item!.id, quantity: l.quantity, source, reference, eta: l.date ?? eta, price: l.price ?? null });
          coming.push(l.item!.name);
          lines.push({ ...line, state: 'done' });
        } else lines.push({ ...line, state: 'todo' });
      }
      const dates = new Set([eta, ...reading.lines.map((l) => l.date)].filter((d): d is string => !!d));
      for (const d of dates) {
        const slot = d === eta ? reading.delivery : { from: null, to: null };
        await windows.put(`${firstWord(seen.shopName)}:${d}`, { shopId: seen.shopId, shopName: seen.shopName, date: d, from: slot.from, to: slot.to, at: ctx.core.now() });
      }
      const todo = lines.filter((l) => l.state === 'todo').length;
      const when = eta ? ` for ${day(eta)}${reading.delivery.from ? `, ${reading.delivery.from}${reading.delivery.to ? `–${reading.delivery.to}` : ''}` : ''}` : '';
      const message = [
        `${seen.shopName} order${reference ? ` ${reference}` : ''}: ${plural(coming.length, 'thing')} on the way${when}.`,
        unavailable.length ? `Not available: ${andList(unavailable)}.` : '',
        todo ? `${plural(todo, 'line')} to check.` : '',
      ].filter(Boolean).join(' ');
      ctx.publish('email.order_read', { shop: seen.shopName, reference, coming: coming.length, unavailable, to_check: todo, delivery_date: eta, delivery_from: reading.delivery.from, delivery_to: reading.delivery.to, message });
      return { ...seen, outcome: 'expected', reference, delivery: reading.delivery, lines, message };
    }

    /* ---------------- checking on its own ---------------- */

    async function tick() {
      if (!ctx.isEnabled() || running) return;
      const c = await connection();
      if (!connected(c) || c.problem) return;
      const next = await plan();
      if (next && next.at <= now()) await check();
    }
    const timer = setInterval(() => {
      tick().catch((err: unknown) => ctx.log.warn('Checking Gmail failed', { message: err instanceof Error ? err.message : String(err) }));
    }, 60_000);
    (timer as { unref?: () => void }).unref?.();

    // A slot booked through online shopping: watch for its delivered email.
    ctx.on('online-shopping.slot_booked', async (e) => {
      const d = e.data as { shop?: string; start?: string; end?: string };
      if (!d.shop || !d.start || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(d.start)) return;
      const shop = await ctx.core.resolve.shop(d.shop).catch(() => null);
      const date = d.start.slice(0, 10);
      await windows.put(`${firstWord(d.shop)}:${date}`, { shopId: shop?.id ?? null, shopName: shop?.name ?? d.shop, date, from: d.start.slice(11, 16), to: d.end && /T\d{2}:\d{2}/.test(d.end) ? d.end.slice(11, 16) : null, at: ctx.core.now() });
    });

    /* ---------------- routes ---------------- */

    async function status(): Promise<z.infer<typeof Status>> {
      const [c, s, k] = await Promise.all([connection(), settings(), checked()]);
      const ok = connected(c);
      const next = ok && !c.problem ? await plan() : null;
      const r = reader();
      return {
        connected: ok, account: c.account, address: c.address, redirectUri: redirectUri(c), clientId: c.clientId, secretSet: !!c.clientSecret, problem: c.problem,
        rules: s.rules, timing: s.timing, lastCheck: k.lastCheck, lastResult: k.lastResult, lastError: k.lastError,
        next: next ? { at: new Date(next.at).toISOString(), why: next.why } : null,
        aiReady: r ? await r.ready() : null,
        scope: SCOPE, callbackPath: CALLBACK_PATH,
      };
    }

    ctx.addRoute({ method: 'GET', path: '/', summary: 'How order emails are set up: Gmail, the rules, when Gmail is checked next', response: Status, handler: status });

    ctx.addRoute({
      method: 'PUT',
      path: '/settings',
      summary: 'Which emails are which (by subject and sender), and how often to check',
      admin: true,
      body: z.object({ rules: z.array(Rule.omit({ id: true }).extend({ id: z.string().max(40).optional() })).max(50).optional(), timing: Timing.optional() }),
      response: Status,
      async handler({ body }) {
        const s = await settings();
        const shops = await ctx.core.shops.list();
        const rules = body.rules?.map((r: Omit<Rule, 'id'> & { id?: string }) => {
          if (!shops.some((x) => x.id === r.shopId)) throw new ValidationError('That shop isn\'t in Larder. Add it under Shops first.');
          return { ...r, id: r.id || newId() };
        });
        await store.put('settings', { rules: rules ?? s.rules, timing: body.timing ?? s.timing });
        return status();
      },
    });

    ctx.addRoute({
      method: 'PUT',
      path: '/gmail',
      summary: 'Home Assistant\'s outside address, and the Google Cloud client ID and secret',
      description: 'The secret is kept in Larder\'s data folder and never sent back. Changing the client signs Larder out of Gmail (Google ties the sign-in to it).',
      admin: true,
      body: z.object({ address: z.string().max(300).optional(), clientId: z.string().trim().max(300).optional(), clientSecret: z.string().trim().max(300).optional() }),
      response: Status,
      async handler({ body }) {
        const c = await connection();
        const next: Connection = { ...c };
        if (body.address !== undefined) next.address = body.address.trim() ? originOf(body.address) : null;
        if (body.clientId !== undefined) {
          if (body.clientId && !/\.apps\.googleusercontent\.com$/.test(body.clientId)) throw new ValidationError('That doesn\'t look like a Google client ID: it ends in .apps.googleusercontent.com.');
          next.clientId = body.clientId || null;
        }
        if (body.clientSecret) next.clientSecret = body.clientSecret;
        const changed = next.clientId !== c.clientId || next.clientSecret !== c.clientSecret || next.address !== c.address;
        await saveConnection(changed && c.refreshToken ? { ...next, refreshToken: null, accessToken: null, expiresAt: null, account: null, connectedAt: null, problem: null } : next);
        return status();
      },
    });

    ctx.addRoute({
      method: 'POST',
      path: '/gmail/start',
      summary: 'Start signing in to Gmail: answers the Google page to send the person to',
      admin: true,
      response: z.object({ url: z.string() }),
      async handler() {
        const c = await connection();
        const cl = client(c);
        if (!c.address) throw new ValidationError('Give Home Assistant\'s address from outside the house first (step 1).');
        if (!cl) throw new ValidationError('Paste the client ID and secret from Google Cloud first (step 8).');
        const state = newId();
        await signIns.put(state, { at: ctx.core.now() });
        return { url: authorizeUrl(cl, state) };
      },
    });

    ctx.addRoute({
      method: 'POST',
      path: '/gmail/callback',
      summary: 'Finish signing in to Gmail, with what Google sent back',
      description: 'The Larder integration in Home Assistant calls this when Google sends the person back to /api/larder/gmail/callback. The state must be one Larder started in the last 15 minutes.',
      body: z.object({ state: z.string().max(200).default(''), code: z.string().max(2000).optional(), error: z.string().max(200).optional() }),
      response: z.object({ account: z.string(), message: z.string() }),
      async handler({ body }) {
        const started = body.state ? await signIns.get(body.state) : null;
        if (body.state) await signIns.remove(body.state).catch(() => undefined);
        if (!started || now() - Date.parse(started.at) > SIGN_IN_MS) throw new ValidationError('That sign-in has expired or was already used. Press Connect Gmail in Larder again.');
        if (body.error) throw new ValidationError(body.error === 'access_denied' ? 'Gmail wasn\'t connected: Google says it wasn\'t allowed.' : `Gmail wasn't connected: ${body.error}.`);
        if (!body.code) throw new ValidationError('Google didn\'t send a sign-in back. Press Connect Gmail in Larder again.');
        const c = await connection();
        const cl = client(c);
        if (!cl) throw new ValidationError('Larder no longer has the Google client details. Paste them again (step 8).');
        const t = await g.signIn(cl, body.code);
        if (!t.scope.split(' ').includes(SCOPE)) throw new ValidationError('Google didn\'t give Larder permission to read Gmail. Press Connect Gmail again and allow it to view your email messages and settings.');
        if (!t.refreshToken) throw new ValidationError('Google didn\'t let Larder stay signed in. Press Connect Gmail again.');
        const account = (await g.profile(t.accessToken)).emailAddress;
        await saveConnection({ ...c, account, refreshToken: t.refreshToken, accessToken: t.accessToken, expiresAt: now() + t.expiresIn * 1000, connectedAt: ctx.core.now(), problem: null });
        await checks.put('checks', { lastCheck: null, lastResult: null, lastError: null });
        return { account, message: `Gmail connected: Larder reads order emails from ${account}.` };
      },
    });

    ctx.addRoute({
      method: 'DELETE',
      path: '/gmail',
      summary: 'Disconnect Gmail (Larder stops reading it and Google forgets the sign-in)',
      admin: true,
      response: Status,
      async handler() {
        const c = await connection();
        if (c.refreshToken) await g.revoke(c.refreshToken);
        await saveConnection({ ...c, account: null, refreshToken: null, accessToken: null, expiresAt: null, connectedAt: null, problem: null });
        return status();
      },
    });

    ctx.addRoute({
      method: 'POST',
      path: '/check',
      summary: 'Check Gmail now (Larder also checks on its own)',
      response: z.object({ message: z.string() }),
      handler: async () => ({ message: await check() }),
    });

    ctx.addRoute({
      method: 'GET',
      path: '/emails',
      summary: 'The order and delivery emails Larder has read, newest first',
      response: z.array(Seen),
      async handler() {
        return (await emails.list()).map((x) => x.data).filter((x) => x.outcome !== 'ignored' && x.message).sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 30);
      },
    });

    const lineParams = z.object({ id: z.string(), n: z.coerce.number().int().min(0) });
    async function line(id: string, n: number) {
      const seen = await emails.get(id);
      const l = seen?.lines[n];
      if (!seen || !l) throw new LarderError('Larder doesn\'t have that email line.', 404, 'not_found');
      return { seen, l };
    }

    /** An order line is this item: it goes on the delivery, and the shop's name for it is remembered. */
    async function matchLine(id: string, n: number, productId: string, quantity: number): Promise<Seen> {
      const { seen, l } = await line(id, n);
      const product = await ctx.core.products.summary(productId);
      if (l.status === 'coming' && l.state !== 'done') {
        await ctx.core.stock.expect({ productId, quantity, source: `${seen.shopName} delivery`, reference: seen.reference, eta: l.date ?? seen.delivery?.date ?? null, price: l.price ?? null });
      }
      await reader()?.remember(seen.shopId, l.text, productId, quantity / (l.count || 1));
      const lines = seen.lines.map((x, i) => (i === n ? { ...x, item: { id: product.product.id, name: product.product.name, unit: product.product.unit }, quantity, match: 'learnt' as const, state: 'done' as const } : x));
      const updated = { ...seen, lines };
      await emails.put(seen.id, updated);
      return updated;
    }

    async function skipLine(id: string, n: number): Promise<Seen> {
      const { seen } = await line(id, n);
      const updated = { ...seen, lines: seen.lines.map((x, i) => (i === n ? { ...x, state: 'skipped' as const } : x)) };
      await emails.put(seen.id, updated);
      return updated;
    }

    ctx.addRoute({
      method: 'POST',
      path: '/emails/:id/lines/:n',
      summary: 'Say which item an order line is: it goes on the delivery, and the shop\'s name for it is remembered',
      params: lineParams,
      body: z.object({ productId: z.string().min(1), quantity: z.number().positive().max(99999) }),
      response: Seen,
      handler: ({ params, body }) => matchLine(params.id, params.n, body.productId, body.quantity),
    });

    ctx.addRoute({
      method: 'POST',
      path: '/emails/:id/lines/:n/skip',
      summary: 'An order line isn\'t something Larder keeps: leave it out',
      params: lineParams,
      response: Seen,
      handler: ({ params }) => skipLine(params.id, params.n),
    });

    const EmailRef = z.string().min(1).max(200).describe('The email: its order number, or the id order_emails gives');
    const LineNo = z.number().int().min(1).describe('The line\'s number, as order_emails lists it (from 1)');
    /** An email by its id or its order number. */
    async function findEmail(ref: string): Promise<Seen> {
      const all = (await emails.list()).map((x) => x.data);
      const found = all.find((x) => x.id === ref) ?? all.find((x) => x.reference && x.reference.toLowerCase() === ref.trim().toLowerCase());
      if (!found) throw new LarderError(`Larder hasn't read an order email "${ref}". order_emails lists them.`, 404, 'not_found');
      return found;
    }

    ctx.addTool({
      name: 'order_emails', title: 'Order emails read', readOnly: true,
      description: 'The shops\' order and delivery emails Larder has read, newest first: what each said and did, and order lines still waiting to be matched to an item (match_order_line, or skip_order_line for things Larder doesn\'t keep).',
      input: z.object({ waiting_only: z.boolean().optional().describe('Only emails with lines waiting') }),
      async run({ waiting_only }) {
        const list = (await emails.list()).map((x) => x.data).filter((x) => x.outcome !== 'ignored' && x.message).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
        const shown = (waiting_only ? list.filter((x) => x.lines.some((l) => l.state === 'todo')) : list).slice(0, 15);
        if (!shown.length) return { text: waiting_only ? 'No order lines are waiting.' : 'Larder hasn\'t read any order emails yet.', data: { emails: [] } };
        const text = shown.map((e) => {
          const todo = e.lines.map((l, i) => ({ l, n: i + 1 })).filter((x) => x.l.state === 'todo');
          const head = `- ${e.sentAt.slice(0, 10)} ${e.shopName}${e.reference ? ` order ${e.reference}` : ''} (id ${e.id}): ${e.message}`;
          return [head, ...todo.map(({ l, n }) => `    line ${n}: "${l.text}" ×${l.count}${l.item ? `, maybe ${l.item.name}` : ''}${l.price !== null ? `, ${l.price.toFixed(2)}` : ''}`)].join('\n');
        }).join('\n');
        return { text, data: { emails: shown.map((e) => ({ id: e.id, shop: e.shopName, reference: e.reference, sent: e.sentAt, outcome: e.outcome, message: e.message, waiting: e.lines.map((l, i) => ({ line: i + 1, text: l.text, count: l.count, guess: l.item?.name ?? null, state: l.state })).filter((x) => x.state === 'todo') })) } };
      },
    });

    ctx.addTool({
      name: 'match_order_line', title: 'Match an order line to an item',
      description: 'Say which item an order email\'s line is: it goes on the delivery, and the shop\'s name for it is remembered for next time.',
      input: z.object({
        email: EmailRef, line: LineNo,
        item: z.string().min(1).max(200).describe('The item in Larder'),
        quantity: z.number().positive().optional().describe('How much of the item\'s own unit the line is, e.g. 18 for two 9-roll packs (default: the line\'s count)'),
      }),
      async run({ email, line: n, item, quantity }) {
        const seen = await findEmail(email);
        const l = seen.lines[n - 1];
        if (!l) throw new ValidationError(`That email has ${seen.lines.length} line${seen.lines.length === 1 ? '' : 's'}.`);
        const product = await ctx.core.resolve.product(item);
        await matchLine(seen.id, n - 1, product.id, quantity ?? l.count);
        return { text: `"${l.text}" is ${product.name}${l.status === 'coming' ? `: ${amount(quantity ?? l.count, product.unit)} on the way from ${seen.shopName}` : ''}. Larder will know it next time.`, data: { email: seen.id, line: n, item: product.name } };
      },
    });

    ctx.addTool({
      name: 'skip_order_line', title: 'Leave out an order line', destructive: true,
      description: 'An order email\'s line isn\'t something Larder keeps (a carrier bag, a delivery charge): leave it out.',
      input: z.object({ email: EmailRef, line: LineNo }),
      async run({ email, line: n }) {
        const seen = await findEmail(email);
        const l = seen.lines[n - 1];
        if (!l) throw new ValidationError(`That email has ${seen.lines.length} line${seen.lines.length === 1 ? '' : 's'}.`);
        await skipLine(seen.id, n - 1);
        return { text: `Left out "${l.text}".`, data: { email: seen.id, line: n } };
      },
    });

    ctx.addRoute({
      method: 'POST',
      path: '/emails/:id/read',
      summary: 'Read an order confirmation again (one no AI could read before)',
      params: z.object({ id: z.string() }),
      response: Seen,
      async handler({ params }) {
        const seen = await emails.get(params.id);
        if (!seen || seen.kind !== 'confirmed') throw new LarderError('Larder doesn\'t have that order email.', 404, 'not_found');
        if (seen.outcome !== 'waiting' && seen.outcome !== 'failed') throw new ValidationError('That order email has been read already.');
        const c = await connection();
        if (!connected(c)) throw new LarderError('Connect Gmail first.', 409, 'gmail_not_connected');
        const m = await g.message(await accessToken(c), seen.id);
        const done = await confirmed({ ...seen, at: ctx.core.now() }, m.text);
        await emails.put(seen.id, done);
        return done;
      },
    });

    ctx.addTool({
      name: 'check_order_emails',
      title: 'Check order emails',
      description: 'Look in the household\'s Gmail now for shops\' order and delivery emails (Larder also checks on its own when set up in Settings → Order emails). Answers what was found and done.',
      input: z.object({}),
      async run() {
        const message = await check();
        return { text: message };
      },
    });
  },
});

/** A date some days on (or back). */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

