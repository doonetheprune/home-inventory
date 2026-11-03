/**
 * Online shopping in the app: Settings → Shopping providers (where each
 * provider runs, its token, waking its machine, Test connection, dismissed
 * favourites), an item's listings and buying rules on its page, planning or
 * filling the basket beside a shop's shopping list, and shop favourites in Pending.
 */
import { useEffect, useState } from 'react';
import {
  api, defineWebModule, Empty, Header, Icon, Link, Pill, Seg, Sheet, Stepper, Switch, money, shortDate, useAction, useAddItem, useModuleEnabled, useQuery, useQueryClient, useShops,
  type ProductDetail, type ProductSummary, type ShoppingList,
} from '@larder/web-sdk';

const call = <T,>(method: string, path: string, body?: unknown) => api.modules.call<T>('online-shopping', method, path, body);

interface Wake { entityId: string | null; mac: string | null; broadcastAddress: string | null; timeoutSeconds: number }
interface Status {
  checkedAt: string; ok: boolean; message: string | null; reachable: boolean; loggedIn: boolean | null;
  name: string | null; version: string | null; contractVersion: string | null; capabilities: string[];
  host: { mac: string | null; address: string | null } | null;
}
interface ProviderView {
  id: string; type: 'tesco' | 'other'; shopId: string; shopName: string; isDefault: boolean; url: string; tokenHint: string;
  wake: Wake | null; sleepEntityId: string | null; loyaltyPrices: boolean; status: Status | null; canWake: boolean;
}
interface ProviderList { providers: ProviderView[]; types: Array<{ type: 'tesco' | 'other'; name: string; shop: string | null }> }

export function useProviders() {
  return useQuery({ queryKey: ['online-shopping', 'providers'], queryFn: () => call<ProviderList>('GET', '/providers') });
}

const when = (iso: string) => `${shortDate(iso.slice(0, 10))} ${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;

function statusLine(p: ProviderView): string {
  const s = p.status;
  if (!s) return 'Not tested yet';
  if (s.ok) return `Ready: ${s.name ?? 'provider'} ${s.version ?? ''}, contract ${s.contractVersion ?? '?'} · checked ${when(s.checkedAt)}`;
  return `${s.message ?? 'Not ready'} · checked ${when(s.checkedAt)}`;
}

/* ------------------------------------------------------------------ */
/* Settings → Shopping providers                                        */
/* ------------------------------------------------------------------ */

function ProviderRow({ p, admin, onEdit }: { p: ProviderView; admin: boolean; onEdit: () => void }) {
  const { run, busy } = useAction();
  const [asleep, setAsleep] = useState(false);
  const test = (wake: boolean) => run(async () => {
    const r = await call<{ message: string; provider: ProviderView }>('POST', `/providers/${p.id}/test`, { wake });
    setAsleep(!r.provider.status?.reachable && r.provider.canWake);
    return r;
  }, (r) => r.message);
  return (
    <div className="toggle" style={{ flexWrap: 'wrap', rowGap: 8 }}>
      <span className="grow" style={{ minWidth: 200 }}>
        <b>{p.shopName}</b>{p.isDefault && <> <Pill kind="ok">Default</Pill></>}
        <br /><span className="small" style={{ color: p.status && !p.status.ok ? 'var(--low)' : undefined }}><span className="muted">{p.url.replace(/^https?:\/\//, '')} · </span>{statusLine(p)}</span>
      </span>
      {admin && (
        <span className="row" style={{ gap: 6 }}>
          {asleep && <button type="button" className="btn small primary" disabled={busy} onClick={() => void test(true)}>Wake and test</button>}
          <button type="button" className="btn small" disabled={busy} onClick={() => void test(false)}>{busy ? 'Testing…' : 'Test connection'}</button>
          <button type="button" className="btn small ghost" disabled={busy} onClick={onEdit}><Icon name="edit" size="sm" />Edit</button>
        </span>
      )}
    </div>
  );
}

type WakeKind = 'none' | 'entity' | 'mac';

function ProviderForm({ editing, list, onDone }: { editing: ProviderView | null; list: ProviderList; onDone: () => void }) {
  const shops = useShops();
  const { run, busy } = useAction();
  const [type, setType] = useState<'tesco' | 'other'>(editing?.type ?? 'tesco');
  const presetName = list.types.find((t) => t.type === type)?.shop ?? null;
  const preset = presetName ? shops.find((s) => s.name.toLowerCase() === presetName.toLowerCase()) : undefined;
  const [shopId, setShopId] = useState<string>(editing?.shopId ?? '');
  const chosenShop = shopId || (type === 'tesco' ? (preset?.id ?? `preset:${presetName}`) : '');
  const [isDefault, setDefault] = useState(editing?.isDefault ?? !list.providers.length);
  const [address, setAddress] = useState(editing?.url.replace(/^http:\/\//, '') ?? '');
  const [token, setToken] = useState('');
  const w = editing?.wake;
  const [wakeKind, setWakeKind] = useState<WakeKind>(w?.entityId ? 'entity' : w?.mac ? 'mac' : 'none');
  const [entityId, setEntityId] = useState(w?.entityId ?? '');
  const [mac, setMac] = useState(w?.mac ?? editing?.status?.host?.mac ?? '');
  const [broadcast, setBroadcast] = useState(w?.broadcastAddress ?? '');
  const [timeout, setTimeoutS] = useState(w?.timeoutSeconds ?? 180);
  const [sleep, setSleep] = useState(editing?.sleepEntityId ?? '');
  const [loyalty, setLoyalty] = useState(editing?.loyaltyPrices ?? true);
  const taken = new Set(list.providers.filter((p) => p.id !== editing?.id).map((p) => p.shopId));

  async function save() {
    // A preset shop (Tesco) Larder doesn't have yet is added first.
    let shop = chosenShop;
    if (shop.startsWith('preset:')) shop = (await api.shops.addPreset(shop.slice('preset:'.length))).id;
    const wake = wakeKind === 'none' ? null
      : { entityId: wakeKind === 'entity' ? entityId.trim() : null, mac: wakeKind === 'mac' ? mac.trim() : null, broadcastAddress: wakeKind === 'mac' && broadcast.trim() ? broadcast.trim() : null, timeoutSeconds: timeout };
    const body = { type, shopId: shop, isDefault, address, ...(token.trim() ? { token: token.trim() } : {}), wake, sleepEntityId: sleep.trim() || null, loyaltyPrices: loyalty };
    return editing ? call<ProviderView>('PATCH', `/providers/${editing.id}`, body) : call<ProviderView>('POST', '/providers', body);
  }

  return (
    <form className="stack" style={{ gap: 16 }} onSubmit={(e) => { e.preventDefault(); void run(save, (p) => `${p.shopName} saved. Test the connection to check it.`).then((r) => r && onDone()); }}>
      <label className="field"><span>Provider type</span>
        <select className="input" value={type} onChange={(e) => { setType(e.target.value as 'tesco' | 'other'); setShopId(''); }}>
          {list.types.map((t) => <option key={t.type} value={t.type}>{t.name}</option>)}
        </select>
      </label>
      <label className="field"><span>Shop</span>
        <select className="input" value={chosenShop} onChange={(e) => setShopId(e.target.value)} required>
          <option value="" disabled>Pick the shop it serves…</option>
          {type === 'tesco' && !preset && presetName && <option value={`preset:${presetName}`}>{presetName} (add it)</option>}
          {shops.map((s) => <option key={s.id} value={s.id} disabled={taken.has(s.id)}>{s.name}{taken.has(s.id) ? ' (has one)' : ''}</option>)}
        </select>
        <small>Listings, deliveries and orders belong to this shop.</small>
      </label>
      <label className="field"><span>Address</span>
        <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.231:8710" required autoComplete="off" />
        <small>Where the provider runs: its computer's address and port (8710 unless you changed it).</small>
      </label>
      <label className="field"><span>Token</span>
        <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={editing ? `Saved (…${editing.tokenHint}). Paste to replace` : 'AUTH_TOKEN from the provider\'s .env'} required={!editing} autoComplete="off" />
      </label>
      <div className="list">
        <div className="toggle"><span><b>Default</b><br /><span className="small muted">Used when you don't name a shop</span></span><Switch checked={isDefault} onChange={setDefault} label="Default" /></div>
        <div className="toggle"><span><b>Loyalty prices</b><br /><span className="small muted">Count Clubcard prices and members' offers</span></span><Switch checked={loyalty} onChange={setLoyalty} label="Loyalty prices" /></div>
      </div>

      <div className="section">
        <div className="label">Waking its computer</div>
        <p className="small muted">When it doesn't answer, Larder asks Home Assistant to wake the computer, then waits for it.</p>
        <Seg<WakeKind> label="How to wake it" value={wakeKind} onChange={setWakeKind} options={[['none', 'Don\'t'], ['mac', 'Magic packet'], ['entity', 'Switch or script']]} />
        {wakeKind === 'mac' && (
          <div className="stack" style={{ gap: 10, marginTop: 10 }}>
            <label className="field"><span>MAC address</span><input className="input" value={mac} onChange={(e) => setMac(e.target.value)} placeholder="4c:32:75:12:34:56" required />
              <small>Test connection fills this in. Needs Home Assistant's Wake on LAN integration.</small></label>
            <label className="field"><span>Broadcast address (optional)</span><input className="input" value={broadcast} onChange={(e) => setBroadcast(e.target.value)} placeholder="192.168.1.255" /></label>
          </div>
        )}
        {wakeKind === 'entity' && (
          <label className="field" style={{ marginTop: 10 }}><span>Home Assistant entity</span><input className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="switch.mac_mini or script.wake_mac" required /></label>
        )}
        {wakeKind !== 'none' && (
          <div className="numfield" style={{ marginTop: 10 }}><span><b>Give up after</b><small>Seconds to wait for it to answer</small></span><Stepper value={timeout} onChange={(n) => setTimeoutS(Math.max(10, Math.round(n)))} min={10} max={900} step={30} label="seconds" /></div>
        )}
        <label className="field" style={{ marginTop: 10 }}><span>Sleep after (optional)</span>
          <input className="input" value={sleep} onChange={(e) => setSleep(e.target.value)} placeholder="script.sleep_mac" />
          <small>A switch, button or script to put it back to sleep after a shop, when nothing else is running.</small></label>
      </div>

      <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
        {editing ? <button type="button" className="btn ghost" disabled={busy} onClick={() => { if (confirm(`Remove the ${editing.shopName} provider? Items keep their listings.`)) void run(() => call('DELETE', `/providers/${editing.id}`), `${editing.shopName} provider removed`).then((r) => r && onDone()); }}><Icon name="trash" size="sm" />Remove</button> : <span />}
        <button className="btn primary" disabled={busy || !chosenShop}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

function MultibuySetting({ admin }: { admin: boolean }) {
  const { run } = useAction();
  const { data } = useQuery({ queryKey: ['online-shopping', 'options'], queryFn: () => call<{ multibuyOverPercent: number }>('GET', '/options') });
  if (!data) return null;
  return (
    <div className="list" style={{ marginTop: 10 }}>
      <div className="numfield"><span><b>Multibuys may go over by</b><small>Percent over the stock-up amount, to complete a deal like 3 for £2</small></span>
        {admin ? <Stepper value={data.multibuyOverPercent} onChange={(n) => void run(() => call('PUT', '/options', { multibuyOverPercent: Math.round(n) }))} min={0} max={200} step={5} label="percent" /> : <span>{data.multibuyOverPercent}%</span>}
      </div>
    </div>
  );
}

interface Favourite {
  id: string; shopId: string; shopName: string; listingId: string; name: string; packSize: { amount: number; unit: 'kg' | 'l' | 'each' } | null;
  link: string; imageUrl: string | null; price: number | null; loyaltyPrice: number | null; foundAt: string;
}

function DismissedFavourites() {
  const { run, busy } = useAction();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ['online-shopping', 'dismissed'], queryFn: () => call<Array<Favourite & { dismissedAt: string }>>('GET', '/dismissed') });
  if (!data?.length) return null;
  return (
    <div className="stack" style={{ gap: 6, marginTop: 10 }}>
      <button type="button" className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} {data.length} dismissed favourite{data.length === 1 ? '' : 's'}</button>
      {open && (
        <div className="list">
          {data.map((d) => (
            <div className="item" key={d.id}>
              <span className="item-main"><span className="item-name">{d.name}</span><span className="item-meta">{d.shopName} · dismissed {shortDate(d.dismissedAt.slice(0, 10))}</span></span>
              <button type="button" className="btn small ghost" disabled={busy} onClick={() => void run(() => call('DELETE', `/dismissed/${encodeURIComponent(d.id)}`), `${d.name} is back in Pending`)}><Icon name="undo" size="sm" />Undo</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ShoppingProvidersSettings({ admin }: { admin: boolean }) {
  const { data } = useProviders();
  const [editing, setEditing] = useState<ProviderView | 'new' | null>(null);
  if (!data) return null;
  return (
    <div className="section">
      <div className="label">Shopping providers</div>
      <p className="small muted">
        Online shops Larder can fill a basket at. Each is a small service on a computer on your network that drives one shop's website, signed in as you.
        {' '}Larder decides what to buy; the provider stops at a full basket, and you check it and pay.
      </p>
      {data.providers.length > 0 && <div className="list">{data.providers.map((p) => <ProviderRow key={p.id} p={p} admin={admin} onEdit={() => setEditing(p)} />)}</div>}
      {admin && <button type="button" className="btn small" style={{ marginTop: 10 }} onClick={() => setEditing('new')}><Icon name="plus" size="sm" />Add automated shopping provider</button>}
      {data.providers.length > 0 && <MultibuySetting admin={admin} />}
      {data.providers.length > 0 && <DismissedFavourites />}
      {editing && (
        <Sheet title={editing === 'new' ? 'Add a shopping provider' : `${editing.shopName} provider`} onClose={() => setEditing(null)}>
          <ProviderForm editing={editing === 'new' ? null : editing} list={data} onDone={() => setEditing(null)} />
        </Sheet>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* An item's page: listings and buying rules                           */
/* ------------------------------------------------------------------ */

interface Listing {
  listingId: string; name: string; packQuantity: number; guessed: boolean; link: string | null; imageUrl: string | null; deadSince: string | null;
}
interface ShopRules { listings: Listing[]; packRule: 'fixed' | 'cheapest'; fixedListingId: string | null; targetPrice: number | null }
interface OnlineFields { shops: Record<string, ShopRules>; offerStockUpTo: number | null; targetPrice: number | null }

const emptyRules: ShopRules = { listings: [], packRule: 'cheapest', fixedListingId: null, targetPrice: null };

/** Prices are kept per one of the item's unit; things counted in g or ml are easier per kg or litre. */
function pricePer(unit: string): { label: string; factor: number } {
  const u = unit.toLowerCase();
  if (u === 'g') return { label: 'a kg', factor: 1000 };
  if (u === 'ml') return { label: 'a litre', factor: 1000 };
  if (u === 'each') return { label: 'each', factor: 1 };
  return { label: `a ${unit}`, factor: 1 };
}

/** A price box that saves when it loses focus or on Enter; empty clears it. */
function PriceBox({ value, unit, onSave, label }: { value: number | null; unit: string; onSave: (v: number | null) => void; label: string }) {
  const per = pricePer(unit);
  const shown = value === null ? '' : String(Math.round(value * per.factor * 1000) / 1000);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const save = () => {
    const t = text.trim().replace(/^£/, '');
    if (t === shown) return;
    if (!t) return onSave(null);
    const n = Number(t);
    if (Number.isFinite(n) && n >= 0) onSave(n / per.factor);
    else setText(shown);
  };
  return (
    <span className="row" style={{ gap: 6, alignItems: 'center' }}>
      <span>£</span>
      <input className="input" inputMode="decimal" style={{ width: 90 }} value={text} placeholder="Not set" aria-label={label}
        onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }} />
      <span className="small muted">{per.label}</span>
    </span>
  );
}

function ListingRow({ l, unit, shopId, shopName, productId }: { l: Listing; unit: string; shopId: string; shopName: string; productId: string }) {
  const { run, busy } = useAction();
  const [fixing, setFixing] = useState(false);
  const [n, setN] = useState(l.packQuantity);
  const path = `/items/${productId}/listings/${encodeURIComponent(l.listingId)}`;
  return (
    <div className="item" style={{ flexWrap: 'wrap' }}>
      <span className="tile">{l.imageUrl ? <img src={l.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="cart" />}</span>
      <span className="item-main" style={{ flex: '1 1 180px' }}>
        <span className="item-name">{l.link ? <a href={l.link} target="_blank" rel="noreferrer">{l.name || l.listingId}</a> : (l.name || l.listingId)}</span>
        <span className="item-meta">
          {l.deadSince ? <Pill kind="low">Gone from {shopName}: link the new one</Pill> : <>Code {l.listingId} · </>}
          {!l.deadSince && (fixing ? (
            <span className="row" style={{ gap: 6, display: 'inline-flex' }}>1 pack = <Stepper small value={n} onChange={setN} min={0.001} label={`${unit} in one pack`} /> {unit}
              <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => call('PATCH', path, { shopId, packQuantity: n }), 'Pack size saved').then(() => setFixing(false))}>Save</button></span>
          ) : (
            <button type="button" className="link small" onClick={() => setFixing(true)}>1 pack = {l.packQuantity} {unit}{l.guessed ? ' (check this)' : ''}</button>
          ))}
        </span>
      </span>
      <span className="row" style={{ gap: 6, marginLeft: 'auto' }}>
        {l.imageUrl && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void run(() => call('POST', `/items/${productId}/shop-image`, { shopId, listingId: l.listingId }), 'Using the shop\'s picture')}><Icon name="camera" size="sm" />Use picture</button>}
        <button type="button" className="iconbtn ghost" aria-label={`Unlink ${l.name}`} disabled={busy} onClick={() => void run(() => call('DELETE', `${path}?shopId=${encodeURIComponent(shopId)}`), `${l.name || l.listingId} unlinked`)}><Icon name="x" size="sm" /></button>
      </span>
    </div>
  );
}

function ShopListings({ product, provider, rules }: { product: ProductDetail; provider: ProviderView; rules: ShopRules }) {
  const { run, busy } = useAction();
  const [code, setCode] = useState('');
  const [favourite, setFavourite] = useState(false);
  const id = product.product.id;
  const unit = product.product.unit;
  const canFavourite = !provider.status?.capabilities.length || provider.status.capabilities.includes('add_favourites');
  const setRules = (body: Partial<ShopRules>, done: string) => run(() => call('PUT', `/items/${id}/shops/${provider.shopId}`, body), done);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <b>{provider.shopName}</b>
        {rules.listings.length > 1 && (
          <Seg<'cheapest' | 'fixed'> label="Which pack" value={rules.packRule} onChange={(v) => void setRules({ packRule: v }, v === 'fixed' ? 'Always the first pack' : 'The cheapest mix of packs')}
            options={[['cheapest', 'Cheapest mix'], ['fixed', 'Always the first']]} />
        )}
      </div>
      {rules.listings.length > 0 && <div className="list">{rules.listings.map((l) => <ListingRow key={l.listingId} l={l} unit={unit} shopId={provider.shopId} shopName={provider.shopName} productId={id} />)}</div>}
      <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (code.trim()) void run(() => call<{ message: string }>('POST', `/items/${id}/listings`, { shopId: provider.shopId, idOrLink: code.trim(), addToFavourites: favourite }), (r) => r.message).then((r) => r && setCode('')); }}>
        <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder={`${provider.shopName} product code or link`} aria-label={`${provider.shopName} product code or link`} />
        <button className="btn small" disabled={busy || !code.trim()}>{busy ? 'Looking…' : 'Link'}</button>
      </form>
      {canFavourite && <label className="small row" style={{ gap: 6 }}><input type="checkbox" checked={favourite} onChange={(e) => setFavourite(e.target.checked)} />Also add it to my {provider.shopName} favourites</label>}
      {rules.listings.length > 0 && (
        <div className="numfield"><span><b>Target price at {provider.shopName}</b><small>Leave empty to use the item's</small></span>
          <PriceBox value={rules.targetPrice} unit={unit} label={`Target price at ${provider.shopName}`} onSave={(v) => void setRules({ targetPrice: v }, v === null ? 'Using the item\'s target price' : 'Target price saved')} /></div>
      )}
    </div>
  );
}

function OnlineShoppingPanel({ product }: { product: ProductDetail }) {
  const providers = useProviders().data?.providers ?? [];
  const { run } = useAction();
  if (!providers.length || product.product.wish) return null;
  const f = (product.product.fields['online-shopping'] ?? {}) as Partial<OnlineFields>;
  const id = product.product.id;
  const unit = product.product.unit;
  const normal = product.product.stockUpTo ?? product.product.minQuantity;
  const setRules = (body: Partial<OnlineFields>, done: string) => run(() => call('PUT', `/items/${id}/rules`, body), done);
  return (
    <div className="section">
      <div className="label">Online shopping</div>
      <div className="card pad stack" style={{ gap: 14 }}>
        <div className="list">
          <div className="numfield"><span><b>On offer at</b><small>This price or less counts as an offer</small></span>
            <PriceBox value={f.targetPrice ?? null} unit={unit} label="Target price" onSave={(v) => void setRules({ targetPrice: v }, v === null ? 'Target price cleared' : 'Target price saved')} /></div>
          <div className="numfield"><span><b>Stock up to, on offer</b><small>{normal ? `Normally up to ${normal}` : 'Set the normal amount with Edit'}</small></span>
            {f.offerStockUpTo == null
              ? <button type="button" className="btn small" onClick={() => void setRules({ offerStockUpTo: Math.max(1, (normal ?? 1) * 3) }, 'On-offer amount set')}>Set</button>
              : <div className="row"><Stepper value={f.offerStockUpTo} onChange={(n) => void setRules({ offerStockUpTo: n }, '')} label="stock up to when on offer" /><button type="button" className="link small" onClick={() => void setRules({ offerStockUpTo: null }, 'On-offer amount cleared')}>Clear</button></div>}
          </div>
        </div>
        {providers.map((p) => <ShopListings key={p.id} product={product} provider={p} rules={{ ...emptyRules, ...(f.shops?.[p.shopId] ?? {}) }} />)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Beside a shop's list: plan or fill the online basket                */
/* ------------------------------------------------------------------ */

interface Run {
  id: string; kind: 'plan' | 'fill'; status: 'running' | 'done' | 'failed'; step: string; startedAt: string; finishedAt: string | null;
  summary: string | null; plan: { total: number; items: unknown[] } | null; error: { code: string; message: string } | null;
}

interface Booking { slotId: string; start: string; end: string; price: number | null; reference: string | null; reservedUntil: string | null }
interface Slot { id: string; start: string; end: string; price: number; available: boolean }

const slotWhen = (b: { start: string; end: string }) =>
  `${new Date(`${b.start.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}, ${b.start.slice(11, 16)}–${b.end.slice(11, 16)}`;

function SlotSheet({ shopId, shopName, onClose }: { shopId: string; shopName: string; onClose: () => void }) {
  const { run, busy } = useAction();
  const [when, setWhen] = useState('');
  const [found, setFound] = useState<{ described: string; date: string; slots: Slot[] } | null>(null);
  const free = found?.slots.filter((x) => x.available) ?? [];
  return (
    <Sheet title={`Book a ${shopName} delivery`} onClose={onClose}>
      <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (when.trim()) void run(() => call<{ described: string; date: string; slots: Slot[] }>('GET', `/shops/${shopId}/slots?when=${encodeURIComponent(when.trim())}`)).then((r) => r && setFound(r)); }}>
        <input className="input" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="tomorrow evening, friday, 12 Nov…" aria-label="When" autoFocus />
        <button className="btn small" disabled={busy || !when.trim()}>{busy && !found ? 'Looking…' : 'Find slots'}</button>
      </form>
      {found && (
        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
          <b>{found.described || shortDate(found.date)}</b>
          {!free.length && <p className="small muted">No slots free then. Try another day or time.</p>}
          <div className="list">
            {free.map((x) => (
              <div className="item" key={x.id}>
                <span className="item-main"><span className="item-name">{x.start.slice(11, 16)}–{x.end.slice(11, 16)}</span><span className="item-meta">{x.price ? money(x.price, 'GBP') : 'Free'}</span></span>
                <button type="button" className="btn small primary" disabled={busy} onClick={() => void run(() => call<{ message: string }>('POST', `/shops/${shopId}/book`, { slotId: x.id }), (r) => r.message).then((r) => r && onClose())}>Book</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Sheet>
  );
}

function OnlineBasketPanel({ list }: { list: ShoppingList }) {
  const provider = useProviders().data?.providers.find((p) => p.shopId === list.shop.id);
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const latest = useQuery({
    queryKey: ['online-shopping', 'latest', list.shop.id],
    queryFn: () => call<{ run: Run | null }>('GET', `/shops/${list.shop.id}/latest`),
    enabled: !!provider,
    // Follow a shop while it runs.
    refetchInterval: (q) => (q.state.data?.run?.status === 'running' ? 3000 : false),
  });
  const r = latest.data?.run ?? null;
  const booked = useQuery({ queryKey: ['online-shopping', 'booking', list.shop.id], queryFn: () => call<{ booking: Booking | null }>('GET', `/shops/${list.shop.id}/booking`), enabled: !!provider }).data?.booking ?? null;
  const [shown, setShown] = useState(false);
  const [booking, setBooking] = useState(false);
  const canBook = !provider?.status?.capabilities.length || provider.status.capabilities.includes('slot_booking');
  useEffect(() => {
    // A filled basket changes what's expected: refresh lists and items once it's done.
    if (r && r.status !== 'running') void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'online-shopping' && q.queryKey[0] !== 'auth' });
  }, [r?.id, r?.status, qc]);
  if (!provider) return null;
  const start = (kind: 'plan' | 'fill') => run(() => call<Run>('POST', `/shops/${list.shop.id}/${kind}`), kind === 'plan' ? 'Getting prices…' : 'Filling the basket…').then(() => setShown(true));
  const running = r?.status === 'running';
  return (
    <div className="card pad stack" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span><b>Online at {list.shop.name}</b><br /><span className="small muted">What's low, plus anything on offer at its target price. Stops at the basket: you check it and pay.</span></span>
      </div>
      {canBook && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Icon name="truck" size="sm" />
          <span className="small grow">{booked ? <>Delivery booked: <b>{slotWhen(booked)}</b>{booked.reference ? ` (ref ${booked.reference})` : ''}</> : 'No delivery slot booked. Offers are checked for today.'}</span>
          <button type="button" className="btn small ghost" onClick={() => setBooking(true)}>{booked ? 'Change slot' : 'Book a delivery slot'}</button>
        </div>
      )}
      {booking && <SlotSheet shopId={list.shop.id} shopName={list.shop.name} onClose={() => setBooking(false)} />}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn small" disabled={busy || running} onClick={() => void start('plan')}><Icon name="search" size="sm" />Plan basket</button>
        <button type="button" className="btn small primary" disabled={busy || running} onClick={() => { if (confirm(`Fill your ${list.shop.name} basket now? What goes in is recorded as on the way.`)) void start('fill'); }}><Icon name="cart" size="sm" />Fill basket</button>
      </div>
      {r && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="small">
            {running ? <><span className="spinner" style={{ display: 'inline-block', width: 12, height: 12, verticalAlign: 'middle' }} /> {r.step}…</>
              : <>{r.status === 'failed' ? <Pill kind="low">Stopped</Pill> : <Pill kind="ok">{r.kind === 'plan' ? 'Planned' : 'Filled'}</Pill>} {shortDate((r.finishedAt ?? r.startedAt).slice(0, 10))}{r.plan?.items.length ? ` · ${r.plan.items.length} items, about ${money(r.plan.total, 'GBP')}` : ''}</>}
          </span>
          {!running && r.summary && (shown ? <pre className="small" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{r.summary}</pre>
            : <button type="button" className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setShown(true)}>Show what it found</button>)}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pending: shop favourites not linked to anything yet                 */
/* ------------------------------------------------------------------ */

function usePendingFavourites() {
  return useQuery({ queryKey: ['online-shopping', 'pending'], queryFn: () => call<Favourite[]>('GET', '/pending') });
}

/** "Tesco Closed Cup Mushrooms 300G" → "Closed Cup Mushrooms"; the full name is kept as its brand. */
function plainName(name: string): string {
  const out = name
    .replace(/^(tesco( finest| organic| everyday value)?|asda|sainsbury'?s|waitrose|ocado|morrisons|aldi|lidl|co-?op)\s+/i, '')
    .replace(/\s+\d+(\.\d+)?\s*(x\s*\d+(\.\d+)?\s*)?(g|kg|ml|l|ltr|litres?|cl|pack|pk|rolls?|tins?|bags?|eggs?|pints?|tablets?|pods?)\b.*$/i, '')
    .trim();
  return out || name;
}

/** What it's counted in: g or ml for weights and volumes, rolls for "9 Rolls", else each. */
function unitFor(f: Favourite): string {
  if (f.packSize?.unit === 'kg') return 'g';
  if (f.packSize?.unit === 'l') return 'ml';
  const counted = /\b\d+\s*(roll|tin|bag|bottle|tablet|egg|can|pod|sachet|capsule|bar)s?\b/i.exec(f.name);
  return counted ? counted[1]!.toLowerCase() : 'each';
}

const sizeText = (p: Favourite['packSize']) => (!p ? '' : p.unit === 'each' ? `${p.amount}` : p.amount < 1 ? `${Math.round(p.amount * 1000)} ${p.unit === 'kg' ? 'g' : 'ml'}` : `${p.amount} ${p.unit}`);

/** Picks an item to link a favourite to. */
function LinkSheet({ f, onClose }: { f: Favourite; onClose: () => void }) {
  const { run, busy } = useAction();
  const [q, setQ] = useState(f.name.replace(/^(tesco|asda|sainsbury'?s|waitrose|ocado)\s+/i, '').split(/\s+/).slice(0, 2).join(' '));
  const items = useQuery({ queryKey: ['products', 'all-for-link'], queryFn: () => api.products.list({ status: 'all' }) }).data ?? [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((s: ProductSummary) => words.every((w) => `${s.product.name} ${s.product.aliases.join(' ')}`.toLowerCase().includes(w))).slice(0, 30);
  return (
    <Sheet title={`Link ${f.name}`} onClose={onClose}>
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find the item" aria-label="Find the item" autoFocus />
      <div className="list" style={{ marginTop: 10 }}>
        {shown.map((s: ProductSummary) => (
          <button type="button" key={s.product.id} className="item" disabled={busy} style={{ width: '100%', textAlign: 'left' }}
            onClick={() => void run(() => call<{ message: string }>('POST', `/pending/${encodeURIComponent(f.id)}/link`, { productId: s.product.id }), (r) => r.message).then((r) => r && onClose())}>
            <span className="item-main"><span className="item-name">{s.product.name}</span><span className="item-meta">Counted in {s.product.unit}</span></span>
            <Icon name="chev" size="sm" />
          </button>
        ))}
        {!shown.length && <p className="small muted">No item matches. Try fewer words, or add it as a new item.</p>}
      </div>
    </Sheet>
  );
}

function FavouritesPending() {
  const { data } = usePendingFavourites();
  const providers = useProviders().data?.providers ?? [];
  const { run, busy } = useAction();
  const addItem = useAddItem();
  const [filter, setFilter] = useState('');
  const [linking, setLinking] = useState<Favourite | null>(null);
  if (!providers.length) return null;
  const all = data ?? [];
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((f) => words.every((w) => f.name.toLowerCase().includes(w)));

  /** A new item, filled in from the favourite, with the shop's picture; saving links it and takes it out of Pending. */
  const asNewItem = (f: Favourite) => run(async () => {
    const { photoFileId } = await call<{ photoFileId: string | null }>('POST', `/pending/${encodeURIComponent(f.id)}/photo`);
    addItem({
      name: plainName(f.name),
      brand: f.name,
      unit: unitFor(f),
      preferredShopIds: [f.shopId],
      photoFileId,
      links: [f.link],
      note: `From your ${f.shopName} favourites. Give it a plain name ("Mushrooms") and say what it's counted in; saving links it to this ${f.shopName} product.`,
      onSaved: (productId) => call('POST', `/pending/${encodeURIComponent(f.id)}/added`, { productId }),
    });
  });

  return (
    <div className="section" style={{ marginTop: 18 }}>
      <div className="label">Shop favourites{all.length ? ` (${all.length})` : ''}</div>
      <p className="small muted">Favourites at your online shops that aren't linked to anything in Larder yet. Make one a new item, link it to an item you have, or dismiss it (it won't come back; undo in Settings).</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {providers.filter((p) => !p.status?.capabilities.length || p.status.capabilities.includes('favourites')).map((p) => (
          <button key={p.id} type="button" className="btn small" disabled={busy} onClick={() => void run(() => call<{ message: string }>('POST', `/shops/${p.shopId}/favourites/sync`, {}), (r) => r.message)}>
            <Icon name="download" size="sm" />{busy ? 'Reading…' : `Bring in ${p.shopName} favourites`}
          </button>
        ))}
        {all.length > 8 && <input className="input" style={{ flex: '1 1 200px' }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter favourites" />}
      </div>
      {data && !all.length && <p className="small muted">None waiting.</p>}
      <div className="list">
        {shown.map((f) => (
          <div className="item" key={f.id} style={{ flexWrap: 'wrap' }}>
            <span className="tile">{f.imageUrl ? <img src={f.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="cart" />}</span>
            <span className="item-main" style={{ flex: '1 1 180px' }}>
              <span className="item-name">{f.name}</span>
              <span className="item-meta">
                <a href={f.link} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{f.shopName}</a>
                {f.packSize ? ` · ${sizeText(f.packSize)}` : ''}{f.price !== null ? ` · ${money(f.price, 'GBP')}` : ''}{f.loyaltyPrice !== null ? ` (${money(f.loyaltyPrice, 'GBP')} with card)` : ''}
              </span>
            </span>
            <div className="row" style={{ gap: 6, rowGap: 6, marginLeft: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button type="button" className="btn small primary" disabled={busy} onClick={() => void asNewItem(f)}><Icon name="plus" size="sm" />New item</button>
              <button type="button" className="btn small" disabled={busy} onClick={() => setLinking(f)}><Icon name="link" size="sm" />Link to an item</button>
              <button type="button" className="iconbtn ghost" aria-label={`Dismiss ${f.name}`} disabled={busy} onClick={() => void run(() => call('POST', `/pending/${encodeURIComponent(f.id)}/dismiss`), `${f.name} dismissed`)}><Icon name="x" size="sm" /></button>
            </div>
          </div>
        ))}
      </div>
      {linking && <LinkSheet f={linking} onClose={() => setLinking(null)} />}
    </div>
  );
}

/** Pending for favourites, when the Sharing module (which has the Pending page) is off. */
function FavouritesPage() {
  return (
    <>
      <Header title="Shop favourites" back="/more" />
      <div className="content" style={{ maxWidth: 860 }}><FavouritesPending /></div>
    </>
  );
}

/** On the Wish list: how many favourites are waiting. */
function FavouritesOnWishList() {
  const n = usePendingFavourites().data?.length ?? 0;
  const sharing = useModuleEnabled('sharing');
  if (!n) return null;
  return (
    <Link className="card pad" to={sharing ? '/m/sharing/' : '/m/online-shopping/favourites'} style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
      <Icon name="cart" />
      <span style={{ flex: 1, minWidth: 0 }}><b>{n === 1 ? '1 shop favourite' : `${n} shop favourites`} in Pending</b><br /><span className="small muted">Make them items, link them to items, or dismiss them</span></span>
      <Icon name="chev" size="sm" />
    </Link>
  );
}

export default defineWebModule({
  id: 'online-shopping',
  settingsPanels: [ShoppingProvidersSettings],
  productPanels: [OnlineShoppingPanel],
  shoppingPanels: [OnlineBasketPanel],
  panels: [{ slot: 'sharing.pending', component: FavouritesPending }],
  pages: [{ path: '/favourites', title: 'Shop favourites', hidden: true, component: FavouritesPage }],
  wishListPanels: [FavouritesOnWishList],
});
