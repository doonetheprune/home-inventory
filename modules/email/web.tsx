/**
 * Order emails: connecting Gmail (a walk through Google Cloud, step by step),
 * which emails are which, when Gmail is checked, and what Larder read. Without
 * Gmail, how to have Claude do it on a schedule instead.
 */
import { useEffect, useRef, useState } from 'react';
import { api, defineWebModule, ErrorBox, Header, Icon, Link, Loading, ProductPicker, Sheet, Stepper, useAction, useQuery, useShops, useToast, type ProductSummary } from '@larder/web-sdk';

type Kind = 'confirmed' | 'delivered';
interface Rule { id: string; shopId: string; kind: Kind; subject: string; from: string }
interface Timing { afterOrder: { every: number; hours: number }; aroundDelivery: { every: number; before: number; after: number }; otherwise: { everyHours: number } }
interface Status {
  connected: boolean; account: string | null; address: string | null; redirectUri: string | null; clientId: string | null; secretSet: boolean; problem: string | null;
  rules: Rule[]; timing: Timing; lastCheck: string | null; lastResult: string | null; lastError: string | null; next: { at: string; why: string } | null;
  aiReady: boolean | null; scope: string; callbackPath: string;
}
interface Line { text: string; count: number; quantity: number; item: { id: string; name: string; unit: string } | null; match: string; status: 'coming' | 'unavailable'; date: string | null; price: number | null; state: 'done' | 'todo' | 'skipped' }
interface Seen { id: string; sentAt: string; subject: string; shopName: string; kind: Kind | null; outcome: string; message: string; reference: string | null; lines: Line[] }

const call = <T,>(method: string, path: string, body?: unknown) => api.modules.call<T>('email', method, path, body);
const useStatus = (waiting = false) => useQuery({ queryKey: ['email', 'status'], queryFn: () => call<Status>('GET', '/'), refetchInterval: waiting ? 3000 : 60_000 });
const KINDS: Array<[Kind, string]> = [['confirmed', 'Order confirmed'], ['delivered', 'Delivered']];
const link = { color: 'var(--accent)', fontWeight: 600 } as const;
const time = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Text to paste somewhere else, with a Copy button (and a fallback where the clipboard isn't allowed, e.g. over http). */
function CopyText({ value, label, rows }: { value: string; label: string; rows?: number }) {
  const toast = useToast();
  const box = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      box.current?.select();
      document.execCommand('copy');
    }
    toast('Copied');
  };
  return (
    <div className="inputrow" style={{ alignItems: rows ? 'flex-start' : undefined }}>
      {rows
        ? <textarea ref={box} className="input mono" readOnly value={value} rows={rows} aria-label={label} style={{ fontSize: 12.5 }} onFocus={(e) => e.target.select()} />
        : <input ref={box} className="input mono" readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} />}
      <button type="button" className="btn small" onClick={() => void copy()}>Copy</button>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <div className="item" style={{ alignItems: 'flex-start' }}>
      <span className="tile" style={done ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : undefined} aria-hidden="true">{done ? <Icon name="check" size="sm" /> : <b>{n}</b>}</span>
      <div className="item-main" style={{ gap: 8 }}>
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}

const Open = ({ href, children }: { href: string; children: React.ReactNode }) => <a className="btn small" href={href} target="_blank" rel="noreferrer" style={{ justifySelf: 'start' }}>{children} <Icon name="link" size="sm" /></a>;

/** Google Cloud, one step at a time. */
function GmailSetup({ s }: { s: Status }) {
  const { run, busy } = useAction();
  const [address, setAddress] = useState(s.address ?? '');
  const [clientId, setClientId] = useState(s.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [waiting, setWaiting] = useState(false);
  useStatus(waiting);
  const save = (body: Record<string, string>, done: string) => run(() => call<Status>('PUT', '/gmail', body), done);
  const connect = async () => {
    const r = await run(() => call<{ url: string }>('POST', '/gmail/start'));
    if (!r) return;
    window.open(r.url, '_blank', 'noopener');
    setWaiting(true);
  };
  const ready = !!s.address && !!s.clientId && s.secretSet;
  return (
    <div className="section">
      <div className="label">Connect Gmail</div>
      <p className="small muted" style={{ margin: 0 }}>
        About 10 minutes, once. Larder gets read-only access through your own Google Cloud project: it can't send, change or delete anything, and only opens emails whose subject you name below.
        {' '}Use the Gmail account your order emails go to (one just for Larder, with your shops' emails forwarded to it, keeps the rest of your email out of reach).
      </p>
      <div className="list">
        <Step n={1} title="Your Home Assistant address from outside the house" done={!!s.address}>
          <span className="small muted">Google sends you back to Home Assistant after you allow Larder in, and Home Assistant passes it on. With Home Assistant Cloud it's the Remote control address in Home Assistant's Settings → Home Assistant Cloud, like https://abcd1234.ui.nabu.casa.</span>
          <form className="inputrow" onSubmit={(e) => { e.preventDefault(); void save({ address }, 'Address saved'); }}>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://abcd1234.ui.nabu.casa" aria-label="Home Assistant's address from outside" inputMode="url" />
            <button className="btn small" disabled={busy || !address.trim()}>Save</button>
          </form>
        </Step>
        <Step n={2} title="Make a Google Cloud project">
          <span className="small muted">Sign in with that Google account and create a project called <b>Larder</b>. It's free: no billing is needed.</span>
          <Open href="https://console.cloud.google.com/projectcreate">Open Google Cloud</Open>
        </Step>
        <Step n={3} title="Turn on the Gmail API">
          <span className="small muted">Check the Larder project is picked at the top of the page, then press <b>Enable</b>.</span>
          <Open href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">Open the Gmail API</Open>
        </Step>
        <Step n={4} title="Set up Google's sign-in page">
          <span className="small muted">Press <b>Get started</b>. App name: Larder. Support email: yours. Audience: <b>External</b>. Contact email: yours. Agree, then <b>Create</b>.</span>
          <Open href="https://console.cloud.google.com/auth/overview">Open Google Auth Platform</Open>
        </Step>
        <Step n={5} title="Let Larder read Gmail, and nothing else">
          <span className="small muted">Under <b>Data access</b>, press <b>Add or remove scopes</b>, paste this under Manually add scopes, press <b>Add to table</b>, then <b>Update</b> and <b>Save</b>.</span>
          <CopyText value={s.scope} label="Gmail read-only scope" />
          <Open href="https://console.cloud.google.com/auth/scopes">Open Data access</Open>
        </Step>
        <Step n={6} title="Publish it">
          <span className="small muted">Under <b>Audience</b>, press <b>Publish app</b>, then Confirm. Left in Testing, Google signs Larder out every 7 days. Publishing doesn't put it anywhere: nobody can use it without your client ID and secret. Google will say it isn't verified, which is expected for an app only you use.</span>
          <Open href="https://console.cloud.google.com/auth/audience">Open Audience</Open>
        </Step>
        <Step n={7} title="Make Larder's client">
          <span className="small muted">Under <b>Clients</b>, press <b>Create client</b>. Application type: <b>Web application</b>. Name: Larder. Under Authorised redirect URIs press <b>Add URI</b> and paste this, then <b>Create</b>.</span>
          {s.redirectUri ? <CopyText value={s.redirectUri} label="Authorised redirect URI" /> : <span className="small"><b>Save your Home Assistant address (step 1) first.</b></span>}
          <Open href="https://console.cloud.google.com/auth/clients">Open Clients</Open>
        </Step>
        <Step n={8} title="Give Larder the client" done={!!s.clientId && s.secretSet}>
          <span className="small muted">Copy the <b>Client ID</b> and <b>Client secret</b> Google shows (they're on the client's page too). The secret is kept in Larder's data folder and never shown again.</span>
          <form className="stack" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void save({ clientId: clientId.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) }, 'Client saved').then((r) => r && setSecret('')); }}>
            <input className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="….apps.googleusercontent.com" aria-label="Client ID" autoComplete="off" />
            <div className="inputrow">
              <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={s.secretSet ? 'Secret saved: paste to replace it' : 'Client secret'} aria-label="Client secret" autoComplete="off" />
              <button className="btn small" disabled={busy || !clientId.trim() || (!secret.trim() && !s.secretSet)}>Save</button>
            </div>
          </form>
        </Step>
        <Step n={9} title="Connect Gmail">
          <span className="small muted">Pick the Gmail account. Google warns it hasn't verified Larder: press <b>Advanced</b>, then <b>Go to Larder</b>. Allow it to view your email, then Continue. A Home Assistant page says when Gmail is connected; then come back here.</span>
          {waiting
            ? <span className="row small" style={{ gap: 8 }}><span className="spinner" />Waiting for Google… <button type="button" className="link small" onClick={() => setWaiting(false)}>Stop waiting</button></span>
            : <button type="button" className="btn primary" style={{ justifySelf: 'start' }} disabled={busy || !ready} onClick={() => void connect()}><Icon name="mail" size="sm" />Connect Gmail</button>}
          {!ready && <span className="small muted">Steps 1 and 8 first.</span>}
        </Step>
      </div>
    </div>
  );
}

/** Without Gmail: Claude reads the emails on a schedule and tells Larder, through its connectors. */
function ClaudeInstead({ address }: { address: string | null }) {
  const prompt = [
    'Check my Gmail for shops\' order emails from the last 2 days that don\'t have the Gmail label "Larder/done" (Tesco, Toolstation and any other shop I order from), and update Larder with them:',
    '- An order confirmation: for each thing ordered, search Larder for the item, then use add_expected with the quantity in the item\'s own unit, the shop as the source (e.g. "Tesco delivery"), the order number as the reference and the delivery date. Use the shop\'s product code as the item when the email shows one. For anything the email says is unavailable, use cancel_order for that item if it\'s waiting in a pending order from that shop.',
    '- A delivered or "order complete" email: use mark_arrived with that shop\'s delivery as the source.',
    '- An e-receipt: use add_receipt with the lines and prices.',
    'Never add new items to Larder; list anything you couldn\'t match. Then add the label "Larder/done" to each email you dealt with, and finish with a short summary of what changed.',
  ].join('\n');
  return (
    <div className="section">
      <div className="label">Or let Claude do it</div>
      <p className="small muted" style={{ margin: 0 }}>No Google Cloud set-up: Claude reads your Gmail on a schedule and tells Larder. It runs at most hourly, uses your Claude plan, and sees the whole Gmail account you connect.</p>
      <div className="list">
        <Step n={1} title="Connect Gmail and Larder to Claude">
          <span className="small muted">In Claude (claude.ai or the Claude app), go to Settings → Connectors. Connect <b>Gmail</b>. Then <b>Add custom connector</b> for Larder with this address, and allow it when Home Assistant asks.</span>
          <CopyText value={`${address ?? 'https://<your Home Assistant address>'}/api/larder/mcp`} label="Larder's address for Claude" />
        </Step>
        <Step n={2} title="Ask Claude for a scheduled task">
          <span className="small muted">In a new chat, ask Claude to set up a task that runs every hour (or as often as you like) with this prompt:</span>
          <CopyText value={prompt} label="Prompt for Claude's scheduled task" rows={9} />
        </Step>
        <Step n={3} title="Check the first run">
          <span className="small muted">Look at what Claude did after its first run, and at Home's <b>On the way</b> in Larder. Claude can also check on request: "check my order emails for Larder".</span>
        </Step>
      </div>
    </div>
  );
}

function Rules({ s }: { s: Status }) {
  const shops = useShops();
  const { run, busy } = useAction();
  const [shopId, setShopId] = useState('');
  const [kind, setKind] = useState<Kind>('confirmed');
  const [subject, setSubject] = useState('');
  const [from, setFrom] = useState('');
  const save = (rules: Array<Omit<Rule, 'id'> & { id?: string }>, done: string) => run(() => call<Status>('PUT', '/settings', { rules }), done);
  const name = (id: string) => shops.find((x) => x.id === id)?.name ?? 'A shop no longer in Larder';
  return (
    <div className="section">
      <div className="label">Which emails are which</div>
      <p className="small muted" style={{ margin: 0 }}>Larder only opens emails whose subject has these words. Copy a few words from the subject of a real email from each shop: its <b>order confirmed</b> email (the AI reads what's coming and when) and its <b>delivered</b> or order complete email (marks the delivery arrived).</p>
      <div className="list">
        {s.rules.map((r) => (
          <div className="item" key={r.id}>
            <span className="tile"><Icon name={r.kind === 'delivered' ? 'truck' : 'receipt'} /></span>
            <span className="item-main"><span className="item-name">{name(r.shopId)}: {r.kind === 'delivered' ? 'delivered' : 'order confirmed'}</span><span className="item-meta">Subject has “{r.subject}”{r.from ? ` · from ${r.from}` : ''}</span></span>
            <button type="button" className="iconbtn ghost" aria-label={`Remove the ${name(r.shopId)} ${r.kind} rule`} disabled={busy} onClick={() => void save(s.rules.filter((x) => x.id !== r.id), 'Removed')}><Icon name="x" size="sm" /></button>
          </div>
        ))}
        <form className="item" style={{ flexWrap: 'wrap', gap: 8 }} onSubmit={(e) => {
          e.preventDefault();
          void save([...s.rules, { shopId, kind, subject: subject.trim(), from: from.trim() }], `${name(shopId)} ${kind === 'delivered' ? 'delivered' : 'order'} emails will be read`).then((r) => { if (r) { setSubject(''); setFrom(''); } });
        }}>
          <select className="input" style={{ width: 'auto', flex: '1 1 120px' }} value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop">
            <option value="">Shop…</option>
            {shops.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <select className="input" style={{ width: 'auto', flex: '1 1 200px' }} value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Kind of email">
            {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <input className="input" style={{ flex: '2 1 220px' }} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder='Subject has, e.g. "order is confirmed"' aria-label="Subject has" />
          <input className="input" style={{ flex: '1 1 160px' }} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From (optional), e.g. tesco.com" aria-label="From has" />
          <button className="btn primary small" disabled={busy || !shopId || subject.trim().length < 3}>Add</button>
        </form>
      </div>
      {!shops.length && <p className="small muted" style={{ margin: 0 }}>Add your shops first, under <Link to="/shops" style={link}>Shops</Link>.</p>}
    </div>
  );
}

function Timings({ s }: { s: Status }) {
  const { run, busy } = useAction();
  const [t, setT] = useState<Timing>(s.timing);
  useEffect(() => setT(s.timing), [s.timing]);
  const num = (value: number, onChange: (n: number) => void, label: string, max: number) => (
    <input className="input" type="number" min={label.includes('every') && !label.includes('otherwise') ? 1 : 0} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} style={{ width: 70, padding: '6px 8px' }} />
  );
  const changed = JSON.stringify(t) !== JSON.stringify(s.timing);
  return (
    <div className="section">
      <div className="label">When Larder checks Gmail</div>
      <div className="list">
        <div className="numfield" style={{ flexWrap: 'wrap' }}>
          <span><b>After a basket is filled</b><small>For its order confirmation</small></span>
          <span className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>every {num(t.afterOrder.every, (n) => setT({ ...t, afterOrder: { ...t.afterOrder, every: n } }), 'after an order: every so many minutes', 120)} min for {num(t.afterOrder.hours, (n) => setT({ ...t, afterOrder: { ...t.afterOrder, hours: n } }), 'after an order: for so many hours', 48)} hours</span>
        </div>
        <div className="numfield" style={{ flexWrap: 'wrap' }}>
          <span><b>Around a delivery</b><small>For the delivered email</small></span>
          <span className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>every {num(t.aroundDelivery.every, (n) => setT({ ...t, aroundDelivery: { ...t.aroundDelivery, every: n } }), 'around a delivery: every so many minutes', 120)} min, from {num(t.aroundDelivery.before, (n) => setT({ ...t, aroundDelivery: { ...t.aroundDelivery, before: n } }), 'hours before the slot', 24)} hours before the slot to {num(t.aroundDelivery.after, (n) => setT({ ...t, aroundDelivery: { ...t.aroundDelivery, after: n } }), 'hours after the slot', 24)} after</span>
        </div>
        <div className="numfield" style={{ flexWrap: 'wrap' }}>
          <span><b>The rest of the time</b><small>For orders placed outside Larder. 0: not at all</small></span>
          <span className="row small" style={{ gap: 6 }}>every {num(t.otherwise.everyHours, (n) => setT({ ...t, otherwise: { everyHours: n } }), 'otherwise: every so many hours', 48)} hours</span>
        </div>
      </div>
      {changed && <div className="btnrow"><button type="button" className="btn" onClick={() => setT(s.timing)}>Undo</button><button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => call<Status>('PUT', '/settings', { timing: t }), 'Saved')}>Save</button></div>}
      <p className="small muted" style={{ margin: 0 }}>A delivery's slot comes from its order email, or from a slot booked through online shopping; without one, Larder watches the whole day.</p>
    </div>
  );
}

function Connected({ s }: { s: Status }) {
  const { run, busy } = useAction();
  const [confirm, setConfirm] = useState(false);
  const reconnect = async () => {
    const r = await run(() => call<{ url: string }>('POST', '/gmail/start'));
    if (r) window.open(r.url, '_blank', 'noopener');
  };
  return (
    <div className="section">
      <div className="label">Gmail</div>
      <div className="card pad">
        <div className="row" style={{ gap: 12 }}>
          <span className="tile" style={{ background: 'var(--accent-soft)' }}><Icon name="mail" /></span>
          <span className="item-main"><b>{s.account}</b><span className="small muted">Read-only, for the emails named below</span></span>
        </div>
        {s.problem && <p className="small" style={{ margin: 0, color: 'var(--low)' }}><b>{s.problem}</b> <button type="button" className="link small" onClick={() => void reconnect()}>Connect Gmail again</button></p>}
        <p className="small muted" style={{ margin: 0 }}>
          {s.lastCheck ? <>Last checked {time(s.lastCheck)}: {s.lastError ?? s.lastResult ?? 'nothing yet.'}</> : 'Not checked yet.'}
          {s.next && !s.problem ? <> Next check {time(s.next.at)} ({s.next.why}).</> : null}
        </p>
        {s.aiReady !== true && <p className="small" style={{ margin: 0 }}><b>Order confirmations need AI:</b> set it up in <Link to="/settings" style={link}>Settings → AI</Link>. Delivered emails work without it.</p>}
        <div className="btnrow">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => call<{ message: string }>('POST', '/check'), (r) => r.message)}><Icon name="search" size="sm" />Check now</button>
          {confirm
            ? <><button type="button" className="btn" onClick={() => setConfirm(false)}>Keep it</button><button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => call('DELETE', '/gmail'), 'Gmail disconnected')}>Disconnect</button></>
            : <button type="button" className="btn" onClick={() => setConfirm(true)}>Disconnect</button>}
        </div>
      </div>
    </div>
  );
}

function Emails() {
  const { data } = useQuery({ queryKey: ['email', 'emails'], queryFn: () => call<Seen[]>('GET', '/emails') });
  const { run, busy } = useAction();
  const [matching, setMatching] = useState<{ seen: Seen; n: number } | null>(null);
  if (!data?.length) return null;
  return (
    <div className="section">
      <div className="label">What Larder read</div>
      <div className="list">
        {data.map((e) => (
          <div className="item" key={e.id} style={{ alignItems: 'flex-start' }}>
            <span className="tile"><Icon name={e.kind === 'delivered' ? 'truck' : 'receipt'} /></span>
            <div className="item-main" style={{ gap: 6 }}>
              <span className="item-name">{e.subject}</span>
              <span className="item-meta">{e.shopName} · {time(e.sentAt)}</span>
              <span className="small">{e.message}</span>
              {(e.outcome === 'waiting' || e.outcome === 'failed') && <button type="button" className="btn small" style={{ justifySelf: 'start' }} disabled={busy} onClick={() => void run(() => call<Seen>('POST', `/emails/${e.id}/read`), (r) => r.message)}>Read it</button>}
              {e.lines.map((l, n) => l.state === 'todo' && (
                <div key={n} className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="grow">“{l.text}”{l.count > 1 ? ` × ${l.count}` : ''}{l.item ? ` (maybe ${l.item.name})` : ''}</span>
                  <button type="button" className="btn small" onClick={() => setMatching({ seen: e, n })}>Match</button>
                  <button type="button" className="btn small ghost" disabled={busy} onClick={() => void run(() => call<Seen>('POST', `/emails/${e.id}/lines/${n}/skip`), 'Left out')}>Not in Larder</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {matching && <MatchSheet seen={matching.seen} n={matching.n} onClose={() => setMatching(null)} />}
    </div>
  );
}

function MatchSheet({ seen, n, onClose }: { seen: Seen; n: number; onClose: () => void }) {
  const line = seen.lines[n]!;
  const { run, busy } = useAction();
  const [picked, setPicked] = useState<ProductSummary | null>(null);
  const [quantity, setQuantity] = useState(line.quantity || line.count || 1);
  return (
    <Sheet title={`“${line.text}”`} onClose={onClose}>
      {!picked ? (
        <ProductPicker onPick={(p) => { setPicked(p); if (!line.quantity && p.product.pack) setQuantity((line.count || 1) * p.product.pack.holds); }} placeholder="Which item is it?" />
      ) : (
        <>
          <p className="small" style={{ margin: 0 }}><b>{picked.product.name}</b>. Larder remembers this for {seen.shopName}'s next emails.</p>
          <div className="row" style={{ justifyContent: 'space-between' }}><b>How many {picked.product.unit}?</b><Stepper value={quantity} onChange={setQuantity} min={0.1} label="quantity" /></div>
          <div className="btnrow">
            <button type="button" className="btn" onClick={() => setPicked(null)}>Back</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => call('POST', `/emails/${seen.id}/lines/${n}`, { productId: picked.product.id, quantity }), `${picked.product.name} is on the way`).then((r) => r && onClose())}>On the way</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function OrderEmails() {
  const { data: s, error, isLoading } = useStatus();
  return (
    <>
      <Header title="Order emails" back="/settings" />
      {/* On a big screen, the set-up (or what was read) on the left, and the rest beside it. */}
      <div className="content two-col">
        <div className="section" style={{ gap: 22 }}>
          <p className="small muted" style={{ margin: 0 }}>Larder reads your shops' order emails from Gmail: an order confirmation puts what's coming on its way (and takes what's unavailable off the order), and a delivered email moves it into stock.</p>
          {isLoading && <Loading />}
          {error ? <ErrorBox error={error} /> : null}
          {s && (s.connected ? <><Connected s={s} /><Rules s={s} /><Emails /></> : <GmailSetup s={s} />)}
        </div>
        {s && <aside className="side">{s.connected ? <Timings s={s} /> : <ClaudeInstead address={s.address} />}</aside>}
      </div>
    </>
  );
}

function EmailSettings() {
  const { data: s } = useStatus();
  if (!s) return null;
  return (
    <div className="section">
      <div className="label">Order emails</div>
      <Link className="card item" to="/m/email/" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r)' }}>
        <span className="tile"><Icon name="mail" /></span>
        <span className="item-main">
          <span className="item-name">{s.connected ? `Reading ${s.account}` : 'Read order emails from Gmail'}</span>
          <span className="item-meta">{s.problem ?? (s.connected ? `${s.rules.length} email rule${s.rules.length === 1 ? '' : 's'}${s.next ? ` · next check ${time(s.next.at)}` : ''}` : 'Set up step by step, or let Claude do it')}</span>
        </span>
        <Icon name="chev" className="muted" />
      </Link>
    </div>
  );
}

export default defineWebModule({
  id: 'email',
  pages: [{ path: '/', title: 'Order emails', icon: 'mail', component: OrderEmails, hidden: true }],
  settingsPanels: [EmailSettings],
});
