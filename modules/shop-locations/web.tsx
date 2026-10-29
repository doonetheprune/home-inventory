/** Shop locations UI: branches on each shop's card, a sheet to find nearby ones, and the page for zones, alerts and YAML. */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, defineWebModule, Empty, Header, Icon, Link, Loading, Pill, Sheet, Switch, useAction, useQuery, useQueryClient, useShops, useToast, type Shop } from '@larder/web-sdk';

interface Home { latitude: number; longitude: number; label: string; source: 'home-assistant' | 'search' | 'device' }
interface Status { home: Home | null; homeAssistant: { connected: boolean; problem: string | null }; branches: number; zones: number }
interface Branch { id: string; shopId: string; osmId: string | null; name: string; address: string; latitude: number; longitude: number; radius: number; zoneId: string | null; zoneEntityId: string | null; zoneCurrent: boolean }
interface Found { osmId: string; name: string; street: string; address: string; latitude: number; longitude: number; distance: number; saved: boolean }
/** searching: asking now. waiting: the map servers were busy; Larder tries again at nextTryAt. gave_up: busy all day. */
interface Search { shopId: string; within: number; status: 'searching' | 'waiting' | 'done' | 'gave_up'; attempts: number; nextTryAt: string | null; problem: string | null; finishedAt: string | null; unseen: boolean; results: Found[] }
type SearchSummary = Omit<Search, 'results'> & { found: number; unsaved: number };
interface Phone { action: string; name: string }
interface Alerts { connected: boolean; people: Array<{ entityId: string; name: string; phone: string | null; phones: Phone[] }>; phones: Phone[]; onlyWithItems: boolean; automation: { entityId: string | null; savedAt: string | null } | null }
interface Yaml { zones: string; automation: string; placeholders: boolean }

const call = <T,>(method: string, path: string, body?: unknown) => api.modules.call<T>('shop-locations', method, path, body);
const useStatus = () => useQuery({ queryKey: ['shop-locations', 'status'], queryFn: () => call<Status>('GET', '/status'), staleTime: 30_000 });
const useBranches = () => useQuery({ queryKey: ['shop-locations', 'branches'], queryFn: () => call<Branch[]>('GET', '/branches') });

/** Distances in miles, as on UK road signs. */
const miles = (m: number) => `${(m / 1609.344).toFixed(1)} mi`;
const RANGES: Array<[number, string]> = [[1609, '1 mile'], [4828, '3 miles'], [8047, '5 miles'], [16093, '10 miles'], [32187, '20 miles']];
const isActive = (s?: { status: string } | null) => s?.status === 'searching' || s?.status === 'waiting';
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
/** Every shop's latest search, for the Shops page. Asks again only while one is under way. */
const useSearches = () => useQuery({
  queryKey: ['shop-locations', 'searches'],
  queryFn: () => call<SearchSummary[]>('GET', '/searches'),
  refetchInterval: (q) => (q.state.data?.some(isActive) ? 15_000 : false),
});
const RADII = [100, 150, 250, 400];
// A ticked box, without the crossed-out look of a ticked shopping list item.
const TICKED = { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-ink)' };

function zoneState(b: Branch, connected: boolean) {
  if (b.zoneId && b.zoneCurrent) return <Pill kind="ok">Zone in Home Assistant</Pill>;
  if (b.zoneId) return <Pill kind="low">Zone needs updating</Pill>;
  return connected ? <span className="small muted">No zone yet</span> : null;
}

/** Postcode, town, or this device's location. */
function HomeForm({ status, onDone }: { status: Status; onDone?: () => void }) {
  const { run, busy } = useAction();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const here = () => {
    if (!navigator.geolocation) return toast({ text: 'This browser can\'t share its location. Type a postcode instead.', error: true });
    navigator.geolocation.getCurrentPosition(
      (p) => void run(() => call('PUT', '/home', { latitude: p.coords.latitude, longitude: p.coords.longitude }), 'Searching around here').then((r) => r && onDone?.()),
      () => toast({ text: 'The location wasn\'t shared (Home Assistant\'s app may not allow it here). Type a postcode instead.', error: true }),
      { enableHighAccuracy: false, timeout: 15_000 },
    );
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (query.trim().length >= 2) void run(() => call<Home>('PUT', '/home', { query: query.trim() }), (h) => `Searching around ${h.label}`).then((r) => { if (r) { setQuery(''); onDone?.(); } }); }}>
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Postcode or town, e.g. M14 5TQ" aria-label="Postcode or town" />
        <button className="btn" disabled={busy || query.trim().length < 2}>Search here</button>
      </form>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn small" disabled={busy} onClick={here}><Icon name="pin" size="sm" />Use my location</button>
        {status.home && status.home.source !== 'home-assistant' && status.homeAssistant.connected && (
          <button type="button" className="btn small ghost" disabled={busy} onClick={() => void run(() => call('DELETE', '/home'), 'Using Home Assistant\'s home location').then((r) => r && onDone?.())}>Use Home Assistant’s home</button>
        )}
      </div>
    </div>
  );
}

/** Finds a shop's branches near home and saves the ticked ones. The search carries on in the background if the map is busy. */
function FindSheet({ shop, onClose }: { shop: Shop; onClose: () => void }) {
  const status = useStatus();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const key = ['shop-locations', 'search', shop.id];
  const search = useQuery({
    queryKey: key,
    queryFn: () => call<{ search: Search | null }>('GET', `/nearby?shopId=${encodeURIComponent(shop.id)}`).then((r) => r.search),
    // Only while a search is under way: once it's done or has given up, nothing more to ask.
    refetchInterval: (q) => (isActive(q.state.data) ? 4000 : false),
  });
  const [within, setWithin] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<number | null>(null);
  const [changingHome, setChangingHome] = useState(false);
  const home = status.data?.home ?? null;
  const s = search.data ?? null;
  const range = within ?? s?.within ?? 4828;

  async function start(opts: { within?: number; again?: boolean; now?: boolean } = {}) {
    setStarting(true);
    setError(null);
    try {
      const r = await call<{ search: Search }>('POST', '/nearby', { shopId: shop.id, within: opts.within ?? range, again: opts.again, now: opts.now });
      qc.setQueryData(key, r.search);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn\'t search the map.');
    } finally {
      setStarting(false);
    }
  }
  // Opening the sheet starts a search, or picks up the one already going (once its distance is known).
  const begun = useRef<string | null>(null);
  useEffect(() => {
    const where = home ? `${home.latitude},${home.longitude}` : null;
    if (!where || !search.isFetched || begun.current === where) return;
    begun.current = where;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home?.latitude, home?.longitude, search.isFetched]);
  // The shop's card only asks while it knows a search is under way, so tell it when this one starts or changes.
  useEffect(() => {
    if (s) void qc.invalidateQueries({ queryKey: ['shop-locations', 'searches'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.status, s?.within, s?.attempts]);
  // Found while the sheet was open: say it's been seen, so the shop's card doesn't announce it too.
  useEffect(() => {
    if (s?.status === 'done' && s.unseen && !starting) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.status, s?.unseen]);
  // The nearest one is ticked to start with, if it isn't saved already.
  useEffect(() => {
    if (s?.status === 'done') setPicked(new Set(s.results.filter((f) => !f.saved).slice(0, 1).map((f) => f.osmId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.finishedAt]);

  const results = s?.status === 'done' ? s.results : null;
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const save = async () => {
    const chosen = (results ?? []).filter((f) => picked.has(f.osmId));
    // The sheet says so itself, so no toast.
    const r = await run(() => call<Branch[]>('POST', '/branches', { shopId: shop.id, branches: chosen }));
    if (r) setSaved(chosen.length);
  };

  return (
    <Sheet title={`${shop.name} near home`} onClose={onClose}>
      {status.isLoading ? <Loading /> : !home || changingHome ? (
        <div className="stack">
          <p className="small muted">{home ? 'Search from somewhere else:' : `Where should Larder look?${status.data?.homeAssistant.connected ? ' Home Assistant doesn\'t say where home is.' : ''}`}</p>
          <HomeForm status={status.data!} onDone={() => { setChangingHome(false); begun.current = null; }} />
        </div>
      ) : saved !== null ? (
        <SavedNext shop={shop} count={saved} connected={!!status.data?.homeAssistant.connected} onClose={onClose} />
      ) : (
        <div className="stack">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <span className="small muted">Around {home.label} · <button type="button" className="link small" onClick={() => setChangingHome(true)}>Change</button></span>
            <select className="input" style={{ width: 'auto' }} value={range} onChange={(e) => { const v = Number(e.target.value); setWithin(v); void start({ within: v }); }} aria-label="How far to look">
              {RANGES.map(([m, label]) => <option key={m} value={m}>Within {label}</option>)}
            </select>
          </div>
          {error ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="error">{error}</div>
              <button type="button" className="btn small" style={{ justifySelf: 'start' }} onClick={() => void start()}>Try again</button>
            </div>
          ) : !s || s.status === 'searching' || (starting && !results) ? (
            <div className="stack" style={{ gap: 4, justifyItems: 'center' }}>
              <Loading />
              <span className="small muted">{s && s.attempts > 1 ? 'Trying the map servers again…' : 'Searching the map…'}</span>
            </div>
          ) : s.status === 'waiting' ? (
            <div className="card pad stack" style={{ gap: 8, background: 'var(--surface-2)' }}>
              <b className="small">The map servers are busy</b>
              <span className="small">Larder will keep trying in the background{s.nextTryAt ? `, next at ${clock(s.nextTryAt)}` : ''}. You can close this: what it finds will wait on {shop.name}’s card.</span>
              {s.problem && <span className="small muted">{s.problem}</span>}
              <button type="button" className="btn small" style={{ justifySelf: 'start' }} disabled={starting} onClick={() => void start({ now: true })}>Try now</button>
            </div>
          ) : s.status === 'gave_up' ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="error">Larder kept trying for a day, but the map servers were always busy.</div>
              {s.problem && <span className="small muted">{s.problem}</span>}
              <button type="button" className="btn small" style={{ justifySelf: 'start' }} onClick={() => void start({ again: true })}>Search again</button>
            </div>
          ) : results && !results.length ? (
            <Empty title={`No ${shop.name} found nearby`}><span className="small muted">Try further away. The map may not have every shop, or may spell it differently.</span></Empty>
          ) : results && (
            <div className="list">
              {results.map((f) => {
                const on = f.saved || picked.has(f.osmId);
                return (
                  <div key={f.osmId} className="item">
                    <button type="button" className="check" style={on ? TICKED : undefined} aria-label={`Save ${f.name}${f.street ? `, ${f.street}` : ''}`} aria-pressed={on} disabled={f.saved} onClick={() => toggle(f.osmId)}><Icon name="check" size="sm" /></button>
                    <span className="item-main"><span className="item-name">{f.name}{f.street ? `, ${f.street}` : ''}</span><span className="item-meta">{f.address || 'No address on the map'}</span></span>
                    {f.saved ? <Pill kind="ok">Saved</Pill> : <span className="qty">{miles(f.distance)}</span>}
                  </div>
                );
              })}
            </div>
          )}
          {!!results?.length && (
            <button type="button" className="btn primary" disabled={busy || !picked.size} onClick={() => void save()}>
              {picked.size ? `Save ${picked.size} branch${picked.size === 1 ? '' : 'es'}` : 'Tick the branches you use'}
            </button>
          )}
          {results && <button type="button" className="link small" style={{ justifySelf: 'start' }} disabled={starting} onClick={() => void start({ again: true })}>Search again</button>}
          <span className="small muted">Map data © OpenStreetMap contributors. Larder sends where home is to the nearest kilometre, never exactly.</span>
        </div>
      )}
    </Sheet>
  );
}

/** After saving: straight on to Home Assistant, so it's one more tap, not a trip through menus. */
function SavedNext({ shop, count, connected, onClose }: { shop: Shop; count: number; connected: boolean; onClose: () => void }) {
  const { run, busy } = useAction();
  const alerts = useQuery({ queryKey: ['shop-locations', 'alerts'], queryFn: () => call<Alerts>('GET', '/alerts'), enabled: connected });
  const [done, setDone] = useState<string | null>(null);
  const on = !!alerts.data?.automation;
  return (
    <div className="stack">
      <div className="verdict cheaper"><span>{count} branch{count === 1 ? '' : 'es'} saved</span></div>
      {done ? <p className="small">{done}</p> : connected ? (
        <>
          <p className="small muted">Make {count === 1 ? 'it a zone' : 'them zones'} in Home Assistant, so it knows when someone gets to {shop.name}.{on ? ' Your arrival alert will include them.' : ''}</p>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => call<{ message: string }>('POST', '/zones', { shopId: shop.id }), (r) => r.message).then((r) => r && setDone(r.message))}>
            <Icon name="pin" size="sm" />Add to Home Assistant as zones
          </button>
        </>
      ) : (
        <p className="small muted">Larder isn’t connected to Home Assistant, so the <Link to="/m/shop-locations" onClick={onClose}>Shop locations</Link> page has the zones as YAML to copy in.</p>
      )}
      <div className="btnrow">
        {(done || connected) && !on && <Link className="btn" to="/m/shop-locations" onClick={onClose}>Set up arrival alerts</Link>}
        <button type="button" className="btn" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** On each shop's card: its saved branches and a button to find more. */
function ShopBranchesPanel({ shop }: { shop: Shop }) {
  const branches = useBranches();
  const status = useStatus();
  const searches = useSearches();
  const { run, busy } = useAction();
  const [open, setOpen] = useState(false);
  const mine = (branches.data ?? []).filter((b) => b.shopId === shop.id);
  const search = searches.data?.find((x) => x.shopId === shop.id);
  // What the background search is up to, until someone opens the sheet to look.
  const searchLine = !search ? null
    : search.status === 'searching' ? 'Looking for branches nearby…'
      : search.status === 'waiting' ? `The map is busy, so Larder is still looking${search.nextTryAt ? ` (next try ${clock(search.nextTryAt)})` : ''}`
        : search.status === 'gave_up' ? 'Couldn’t reach the map servers. Find nearby to try again.'
          : search.unseen && search.unsaved ? `Found ${search.unsaved} nearby: choose yours`
            : null;
  const connected = !!status.data?.homeAssistant.connected;
  const behind = mine.filter((b) => !b.zoneId || !b.zoneCurrent).length;
  const find = <button type="button" className="btn small" onClick={() => setOpen(true)}>{mine.length ? 'Find more' : 'Find nearby'}</button>;
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, display: 'grid', gap: 8 }}>
      {searchLine && (
        <button type="button" className="row small" style={{ gap: 8, background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontWeight: 600, textAlign: 'left', cursor: 'pointer' }} onClick={() => setOpen(true)}>
          {isActive(search) ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} aria-hidden /> : <Icon name="search" size="sm" />}
          {searchLine}
        </button>
      )}
      {mine.length ? (
        <>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon name="pin" size="sm" />
            <span className="small" style={{ display: 'grid', gap: 2 }}>
              <span>{mine.map((b) => b.name).join(' · ')}</span>
              {connected && <span className="muted">{behind ? `${behind} not in Home Assistant yet` : 'Zones in Home Assistant'}</span>}
            </span>
          </div>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            {connected && behind > 0 && <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => call<{ message: string }>('POST', '/zones', { shopId: shop.id }), (r) => r.message)}>Add as zones</button>}
            {find}
          </div>
        </>
      ) : (
        <div className="row" style={{ gap: 8 }}><Icon name="pin" size="sm" /><span className="small muted grow">No branches saved</span>{find}</div>
      )}
      {open && <FindSheet shop={shop} onClose={() => setOpen(false)} />}
    </div>
  );
}

function CopyBlock({ title, text, note }: { title: string; text: string; note?: string }) {
  const toast = useToast();
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b className="small">{title}</b>
        <button type="button" className="btn small" onClick={() => navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Select the text and copy it')) ?? toast('Select the text and copy it')}>Copy</button>
      </div>
      {note && <span className="small muted">{note}</span>}
      <textarea className="input mono" readOnly rows={Math.min(18, text.split('\n').length)} value={text} aria-label={title} style={{ whiteSpace: 'pre', overflowX: 'auto', fontSize: 12 }} onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

function Alerting({ alerts }: { alerts: Alerts }) {
  const { run, busy } = useAction();
  const [confirmOff, setConfirmOff] = useState(false);
  const people = alerts.people;
  const save = (next: Alerts['people'], onlyWithItems = alerts.onlyWithItems) =>
    run(() => call<{ automationUpdated: boolean }>('PUT', '/alerts', { people: next.map(({ entityId, name, phone }) => ({ entityId, name, phone })), onlyWithItems }), (r) => (r.automationUpdated ? 'Saved, and updated in Home Assistant' : 'Saved'));
  const anyPhone = people.some((p) => p.phone);
  return (
    <div className="card pad stack">
      <p className="small muted">When someone gets to a shop you’ve saved, Home Assistant sends what to get there to their phone. Phones need the Home Assistant app.</p>
      {!people.length && <span className="small muted">Home Assistant has no people set up yet (Settings → People).</span>}
      {people.map((p) => {
        const others = alerts.phones.filter((ph) => !p.phones.some((x) => x.action === ph.action));
        return (
          <label key={p.entityId} className="row" style={{ gap: 10, justifyContent: 'space-between' }}>
            <span><Icon name="user" size="sm" /> {p.name}</span>
            <select className="input" style={{ width: 'auto', maxWidth: '60%' }} value={p.phone ?? ''} aria-label={`Alert ${p.name} on`}
              onChange={(e) => void save(people.map((x) => (x.entityId === p.entityId ? { ...x, phone: e.target.value || null } : x)))}>
              <option value="">No alert</option>
              {p.phones.map((ph) => <option key={ph.action} value={ph.action}>{ph.name}</option>)}
              {others.length > 0 && <optgroup label="Other phones">{others.map((ph) => <option key={ph.action} value={ph.action}>{ph.name}</option>)}</optgroup>}
            </select>
          </label>
        );
      })}
      <label className="row" style={{ justifyContent: 'space-between' }}>
        <span className="small">Only when there’s something to get there</span>
        <Switch checked={alerts.onlyWithItems} label="Only when there's something to get there" onChange={(v) => void save(people, v)} />
      </label>
      {alerts.automation ? (
        <div className="stack" style={{ gap: 8 }}>
          {alerts.automation.entityId
            ? <span className="small"><Pill kind="ok">On</Pill> The automation is in Home Assistant as <code style={{ overflowWrap: 'anywhere' }}>{alerts.automation.entityId}</code>. Larder keeps it up to date.</span>
            : <span className="small"><Pill kind="low">Not loaded</Pill> Home Assistant saved the automation but hasn’t loaded it. Check configuration.yaml has <code>automation: !include automations.yaml</code>.</span>}
          {confirmOff ? (
            <div className="btnrow">
              <button type="button" className="btn" onClick={() => setConfirmOff(false)}>Keep it</button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => call<{ message: string }>('DELETE', '/automation'), (r) => r.message).then(() => setConfirmOff(false))}>Remove it</button>
            </div>
          ) : (
            <div className="btnrow">
              <button type="button" className="btn" disabled={busy || !anyPhone} onClick={() => void run(() => call<{ message: string }>('POST', '/automation', {}), (r) => r.message)}>Save it again</button>
              <button type="button" className="btn ghost" onClick={() => setConfirmOff(true)}>Turn alerts off</button>
            </div>
          )}
        </div>
      ) : (
        <button type="button" className="btn primary" disabled={busy || !anyPhone} onClick={() => void run(() => call<{ message: string }>('POST', '/automation', {}), (r) => r.message)}>
          <Icon name="zap" size="sm" />Create the automation in Home Assistant
        </button>
      )}
    </div>
  );
}

function ShopLocationsPage() {
  const status = useStatus();
  const branches = useBranches();
  const shops = useShops();
  const alerts = useQuery({ queryKey: ['shop-locations', 'alerts'], queryFn: () => call<Alerts>('GET', '/alerts') });
  const yaml = useQuery({ queryKey: ['shop-locations', 'yaml'], queryFn: () => call<Yaml>('GET', '/yaml') });
  const { run, busy } = useAction();
  const [changingHome, setChangingHome] = useState(false);
  const [showYaml, setShowYaml] = useState(false);
  if (status.isLoading || branches.isLoading) return <><Header title="Shop locations" back="/more" /><Loading /></>;
  const s = status.data!;
  const connected = s.homeAssistant.connected;
  const all = branches.data ?? [];
  const byShop = shops.map((shop) => ({ shop, list: all.filter((b) => b.shopId === shop.id) })).filter((g) => g.list.length);
  const behind = all.filter((b) => !b.zoneId || !b.zoneCurrent).length;

  return (
    <>
      <Header title="Shop locations" back="/more" />
      <div className="content" style={{ maxWidth: 760 }}>
        <p className="small muted">Save the branches you use, and Home Assistant can tell when someone gets there and send them that shop’s list.</p>

        <div className="section">
          <div className="label">Home</div>
          <div className="card pad stack">
            {s.home && !changingHome ? (
              <span className="small">Looking for shops around <b>{s.home.label}</b> · <button type="button" className="link small" onClick={() => setChangingHome(true)}>Change</button></span>
            ) : (
              <>
                <span className="small muted">{s.home ? 'Look for shops around somewhere else:' : `Where is home?${connected ? ' Home Assistant doesn’t say, so' : ''} Give a postcode or town.`}</span>
                <HomeForm status={s} onDone={() => setChangingHome(false)} />
              </>
            )}
          </div>
        </div>

        <div className="section">
          <div className="label">Home Assistant</div>
          <div className="card pad small">
            {connected ? <span><Pill kind="ok">Connected</Pill> Larder can make zones and the arrival automation for you.</span>
              : s.homeAssistant.problem ? <span><Pill kind="low">Can’t reach it</Pill> {s.homeAssistant.problem}</span>
                : <span className="muted">Larder isn’t connected to Home Assistant, so copy the YAML below in by hand. (As a Home Assistant add-on it connects by itself; elsewhere, set LARDER_HA_URL and LARDER_HA_TOKEN.)</span>}
          </div>
        </div>

        <div className="section">
          <div className="label" style={{ display: 'flex', justifyContent: 'space-between' }}>Branches <Link to="/shops">Find more on Shops</Link></div>
          {!byShop.length ? (
            <Empty title="No branches yet"><span className="small muted">On the <Link to="/shops">Shops</Link> page, tap Find nearby on a shop.</span></Empty>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {byShop.map(({ shop, list }) => (
                <div key={shop.id}>
                  <div className="small muted" style={{ fontWeight: 600, margin: '0 0 6px' }}>{shop.name}</div>
                  <div className="list">
                    {list.map((b) => (
                      <div key={b.id} className="item" style={{ flexWrap: 'wrap' }}>
                        <span className="item-main"><span className="item-name">{b.name}</span><span className="item-meta">{b.address || `${b.latitude.toFixed(4)}, ${b.longitude.toFixed(4)}`}</span>{zoneState(b, connected)}</span>
                        <select className="input" style={{ width: 'auto' }} value={b.radius} aria-label={`Zone size for ${b.name}`} onChange={(e) => void run(() => call('PATCH', `/branches/${b.id}`, { radius: Number(e.target.value) }), connected && b.zoneId ? 'Changed. Add as zones again to update Home Assistant.' : 'Changed')}>
                          {[...new Set([...RADII, b.radius])].sort((x, y) => x - y).map((r) => <option key={r} value={r}>{r} m</option>)}
                        </select>
                        <button type="button" className="iconbtn ghost" aria-label={`Forget ${b.name}`} disabled={busy} onClick={() => void run(() => call<{ message: string }>('DELETE', `/branches/${b.id}`), (r) => r.message)}><Icon name="trash" size="sm" /></button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {connected && (
                <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => call<{ message: string }>('POST', '/zones', {}), (r) => r.message)}>
                  <Icon name="pin" size="sm" />{behind ? `Add to Home Assistant as zones (${behind} to do)` : 'Update the zones in Home Assistant'}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="section">
          <div className="label">Arrival alerts</div>
          {connected ? (alerts.data ? <Alerting alerts={alerts.data} /> : <Loading />) : (
            <div className="card pad small muted">With Larder connected to Home Assistant, choose here who gets an alert. Without it, the automation YAML below does the same: change the person and phone in it to your own.</div>
          )}
        </div>

        <div className="section">
          <div className="label">Set it up by hand</div>
          <div className="card pad stack">
            <span className="small muted">The same zones and automation as YAML, for when Larder can’t reach Home Assistant or you’d rather paste them in yourself.</span>
            {showYaml ? (yaml.data ? (
              <>
                <CopyBlock title="Zones (configuration.yaml)" text={yaml.data.zones} note="Skip this if Larder made the zones for you, or they’ll appear twice." />
                <CopyBlock title="Automation" text={yaml.data.automation} note={yaml.data.placeholders ? 'Change person.your_name and notify.mobile_app_your_phone to your own.' : undefined} />
              </>
            ) : <Loading />) : <button type="button" className="btn" onClick={() => setShowYaml(true)}>Show the YAML</button>}
          </div>
        </div>
      </div>
    </>
  );
}

export default defineWebModule({
  id: 'shop-locations',
  shopPanels: [ShopBranchesPanel],
  pages: [{ path: '/', title: 'Shop locations', icon: 'pin', subtitle: 'Branches, zones and arrival alerts', component: ShopLocationsPage }],
});
