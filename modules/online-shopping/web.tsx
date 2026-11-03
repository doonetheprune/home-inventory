/**
 * Online shopping in the app: Settings → Shopping providers (where each
 * provider runs, its token, waking its machine, Test connection).
 */
import { useState } from 'react';
import {
  api, defineWebModule, Icon, Pill, Seg, Sheet, Stepper, Switch, shortDate, useAction, useQuery, useShops,
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
      {editing && (
        <Sheet title={editing === 'new' ? 'Add a shopping provider' : `${editing.shopName} provider`} onClose={() => setEditing(null)}>
          <ProviderForm editing={editing === 'new' ? null : editing} list={data} onDone={() => setEditing(null)} />
        </Sheet>
      )}
    </div>
  );
}

export default defineWebModule({
  id: 'online-shopping',
  settingsPanels: [ShoppingProvidersSettings],
});
