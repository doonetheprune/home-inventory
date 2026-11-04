/**
 * The AI section in Settings, the photo reading behind the scanner's "Read with
 * AI", and Add from receipt: a photo is shrunk on the phone and read by the AIs
 * in the household's order. Add by photo (on Home) opens the scanner with the
 * camera on.
 */
import { useEffect, useRef, useState } from 'react';
import {
  api, defineWebModule, grabFrame, Header, Icon, money, plural, Sheet, shortDate, Stepper, Switch, useAction, useCamera, useNavigate, useQuery, useShops, type PhotoReader,
} from '@larder/web-sdk';

type ProviderId = 'claude' | 'gemini';
interface ProviderStatus { enabled: boolean; keySet: boolean; keyHint: string | null; keyFrom: 'app' | 'env' | null; model: string | null }
interface Status { ready: boolean; order: ProviderId[]; first: ProviderId | null; claude: ProviderStatus; gemini: ProviderStatus }
interface Identified {
  readable: boolean;
  name: string;
  brand: string | null;
  unit: string;
  categoryId: string | null;
  shelfLifeDays: number | null;
  aliases: string[];
  shop: { name: string; id: string | null; preset: boolean } | null;
  provider: ProviderId;
  model: string;
  /** AIs asked first that couldn't read it, and why. */
  skipped: Array<{ provider: ProviderId; message: string }>;
}

const NAMES: Record<ProviderId, string> = { claude: 'Claude', gemini: 'Gemini' };
const KEY_SITES: Record<ProviderId, { url: string; text: string }> = {
  claude: { url: 'https://platform.claude.com/', text: 'platform.claude.com' },
  gemini: { url: 'https://aistudio.google.com/', text: 'aistudio.google.com' },
};

const call = <T,>(method: string, path: string, body?: unknown) => api.modules.call<T>('ai', method, path, body);
function useStatus() {
  return useQuery({ queryKey: ['ai', 'status'], queryFn: () => call<Status>('GET', '/') });
}

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */

/** Big enough to read small print, small enough to send quickly: about 1600 pixels on the long side (a receipt, 2400), as a JPEG. */
async function shrink(photo: Blob, longest = 1568): Promise<Blob> {
  const bitmap = await createImageBitmap(photo, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no blob'))), 'image/jpeg', 0.85));
  } finally {
    bitmap.close();
  }
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ */
/* Reading photos for the scanner                                      */
/* ------------------------------------------------------------------ */

/** The scanner's "Read with AI": the photo, shrunk here, goes to the AIs in the household's order. */
const photoReader: PhotoReader = {
  async status() {
    const s = await call<Status>('GET', '/');
    return { ready: s.ready, by: s.first ? NAMES[s.first] : null };
  },
  async read(photo) {
    const small = await shrink(photo);
    const r = await call<Identified>('POST', '/identify', { image: await base64(small) });
    return {
      readable: r.readable, name: r.name, brand: r.brand, unit: r.unit, categoryId: r.categoryId, shelfLifeDays: r.shelfLifeDays, aliases: r.aliases, shop: r.shop,
      by: NAMES[r.provider], notes: r.skipped.map((x) => x.message), photo: small,
    };
  },
};

/** Add by photo (from Home) is the scanner with the camera on: Read with AI is under it. */
function AddByPhoto() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/scan?ai=1', { replace: true });
  }, [navigate]);
  return null;
}

/* ------------------------------------------------------------------ */
/* Add from receipt                                                    */
/* ------------------------------------------------------------------ */

interface ItemRef { id: string; name: string; unit: string }
interface ReceiptLine { text: string; count: number; price: number | null; item: ItemRef | null; quantity: number; match: 'learnt' | 'sure' | 'guess' | 'none' }
interface Receipt {
  readable: boolean;
  shop: { name: string; id: string | null; preset: boolean } | null;
  date: string | null;
  total: number | null;
  lines: ReceiptLine[];
  addedBefore: string | null;
  receiptKey: string | null;
  provider: ProviderId;
  model: string;
  skipped: Array<{ provider: ProviderId; message: string }>;
}
/** A line on the review list: `keep` adds it; `picked` when matched by hand. */
interface Row extends Omit<ReceiptLine, 'match'> { key: number; match: ReceiptLine['match'] | 'picked'; keep: boolean }

const SHUTTER_KEYS = new Set([' ', 'AudioVolumeDown', 'AudioVolumeUp', 'VolumeDown', 'VolumeUp', 'Camera']);

function useCurrency(): string {
  return useQuery({ queryKey: ['settings'], queryFn: api.settings.get, staleTime: 60_000 }).data?.currency ?? 'GBP';
}

/** The camera, taller than the scanner's, for a receipt: Take photo, a volume button or Space. */
function ReceiptCamera({ onPhoto, onUpload, onRetry }: { onPhoto: (photo: Blob) => void; onUpload: () => void; onRetry: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const cam = useCamera(video, true);
  const [shooting, setShooting] = useState(false);

  async function shoot() {
    if (!video.current || cam.state !== 'on' || shooting) return;
    setShooting(true);
    try {
      onPhoto(await grabFrame(video.current));
    } finally {
      setShooting(false);
    }
  }
  const shootRef = useRef(shoot);
  shootRef.current = shoot;
  useEffect(() => {
    if (cam.state !== 'on') return;
    const onKey = (e: KeyboardEvent) => {
      if (!SHUTTER_KEYS.has(e.key)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      void shootRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cam.state]);

  return (
    <div className="stack">
      <div className="viewfinder" aria-label="Camera" style={{ aspectRatio: '3 / 4', maxHeight: '58vh', margin: '0 auto', width: '100%' }}>
        <video ref={video} playsInline muted hidden={cam.state !== 'on'} />
        {cam.state !== 'on' && (
          <div className="vf-idle">
            {cam.state === 'error' ? <Icon name="camera" size="lg" /> : <div className="spinner" />}
            <p className="small">{cam.error ?? 'Starting the camera…'}</p>
            {cam.state === 'error' && <button type="button" className="btn small" onClick={onRetry}>Try again</button>}
          </div>
        )}
      </div>
      <p className="small muted">Lay the receipt flat in good light and fill the frame with it. For a long one, do the top half, add it, then the bottom half.</p>
      <button type="button" className="btn primary block" disabled={cam.state !== 'on' || shooting} onClick={() => void shoot()}><Icon name="camera" />Take photo</button>
      <button type="button" className="btn block" onClick={onUpload}>Upload a photo</button>
    </div>
  );
}

/** Which of the household's items a receipt line is, or none. */
function PickItem({ row, onPick, onClose }: { row: Row; onPick: (item: ItemRef | null) => void; onClose: () => void }) {
  const items = useQuery({ queryKey: ['ai', 'receipt-items'], queryFn: () => api.products.list() }).data ?? [];
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((s) => words.every((w) => [s.product.name, ...s.product.aliases].some((n) => n.toLowerCase().includes(w)))).slice(0, 40);
  return (
    <Sheet title="Which item is it?" onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>On the receipt: <b style={{ fontFamily: 'var(--mono, monospace)' }}>{row.text}</b>. Larder remembers your choice for this shop.</p>
      <input className="input" autoFocus placeholder="Search your items" aria-label="Search your items" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list" style={{ maxHeight: '45vh', overflowY: 'auto' }}>
        {shown.map((s) => (
          <button key={s.product.id} type="button" className="item" onClick={() => onPick({ id: s.product.id, name: s.product.name, unit: s.product.unit })}>
            <span className="item-main">
              <span className="item-name">{s.product.name}</span>
              <span className="item-meta">{s.product.aliases.length ? `Also ${s.product.aliases.join(', ')} · ` : ''}counted in {s.product.unit}</span>
            </span>
          </button>
        ))}
        {!shown.length && <div className="item"><span className="small muted">{items.length ? 'Nothing matches. Things not in Larder are left out.' : 'Loading…'}</span></div>}
      </div>
      {row.item && <button type="button" className="btn block ghost" onClick={() => onPick(null)}>Not in Larder: leave it out</button>}
    </Sheet>
  );
}

function ReceiptPage() {
  const ready = !!useStatus().data?.ready;
  const shops = useShops();
  const currency = useCurrency();
  const { run, busy } = useAction();
  const upload = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [shopId, setShopId] = useState('');
  const [picking, setPicking] = useState<number | null>(null);
  const [cameraKey, setCameraKey] = useState(0);
  /** The shop of the last receipt, for the bottom half of a long one (which doesn't say). */
  const lastShop = useRef('');

  async function read(photo: Blob) {
    setReading(true);
    try {
      const r = await run(async () => call<Receipt>('POST', '/receipt', { image: await base64(await shrink(photo, 2400)) }));
      if (!r) return;
      setReceipt(r);
      // Matched before or certain: ticked. A guess is shown to check. Ticked nothing when it's been added before.
      setRows(r.lines.map((l, key) => ({ ...l, key, keep: !r.addedBefore && (l.match === 'learnt' || l.match === 'sure') })));
      setShopId(r.shop?.id ?? (r.shop ? '' : lastShop.current));
    } finally {
      setReading(false);
    }
  }

  const change = (key: number, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const kept = rows.filter((r) => r.keep && r.item && r.quantity > 0);
  const matched = rows.filter((r) => r.item);
  const unmatched = rows.filter((r) => !r.item);
  const startAgain = () => { setReceipt(null); setRows([]); };

  async function addShop() {
    const s = receipt?.shop;
    if (!s) return;
    const made = await run(() => (s.preset ? api.shops.addPreset(s.name) : api.shops.create({ name: s.name })), `${s.name} added to your shops`);
    if (made) setShopId(made.id);
  }

  async function add() {
    if (!receipt || !kept.length) return;
    const r = await run(
      () => call<{ added: number; message: string }>('POST', '/receipt/add', {
        shopId: shopId || null,
        receiptKey: receipt.receiptKey,
        lines: kept.map((x) => ({ productId: x.item!.id, quantity: x.quantity, price: x.price, text: x.text, count: x.count })),
      }),
      (x) => `${x.message} Ready for the next receipt.`,
    );
    if (r) {
      lastShop.current = shopId;
      startAgain();
    }
  }

  const shopName = shops.find((s) => s.id === shopId)?.name ?? receipt?.shop?.name ?? null;
  const by = receipt ? NAMES[receipt.provider] : null;

  return (
    <>
      <Header title="Add from receipt" back="/" />
      <div className="content stack" style={{ maxWidth: 860 }}>
        {!ready && <p className="small muted">Set up Claude or Gemini in Settings → AI to read receipts.</p>}
        <input ref={upload} type="file" accept="image/*" hidden data-testid="receipt-upload"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }} />

        {reading && (
          <div className="card pad" style={{ display: 'grid', justifyItems: 'center', gap: 12, textAlign: 'center' }}>
            <div className="spinner" />
            <p className="small">Reading the receipt and matching it to your items…</p>
          </div>
        )}

        {!reading && !receipt && ready && <ReceiptCamera key={cameraKey} onPhoto={(p) => void read(p)} onUpload={() => upload.current?.click()} onRetry={() => setCameraKey((k) => k + 1)} />}

        {!reading && receipt && (
          <>
            <div className="card pad stack" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <Icon name="receipt" />
                <span className="grow">
                  <b>{shopName ?? 'Receipt'}</b>
                  <br />
                  <span className="small muted">
                    {[receipt.date ? shortDate(receipt.date) : null, receipt.total !== null ? `${money(receipt.total, currency, 2)} in all` : null, `read by ${by}`].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </div>
              <label className="row small" style={{ gap: 8 }}>
                <span>Shop</span>
                <select className="input" style={{ width: 'auto', flex: 1, maxWidth: 280 }} value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop">
                  <option value="">No shop</option>
                  {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {receipt.shop && !receipt.shop.id && !shopId && <button type="button" className="btn small" disabled={busy} onClick={() => void addShop()}><Icon name="plus" size="sm" />Add {receipt.shop.name}</button>}
              </label>
              {receipt.addedBefore && (
                <p className="small" style={{ margin: 0 }}><b>This looks like a receipt added on {shortDate(receipt.addedBefore.slice(0, 10))}.</b> Adding it again would count it twice, so nothing is ticked. Tick anything that wasn't added.</p>
              )}
              {!receipt.readable && <p className="small" style={{ margin: 0 }}><b>{by} couldn't read a receipt in that photo.</b> Try again flat, in good light, filling the frame.</p>}
              {receipt.skipped.map((x) => <p key={x.provider} className="small muted" style={{ margin: 0 }}>{x.message}</p>)}
            </div>

            {matched.length > 0 && (
              <div className="section">
                <div className="label">In Larder · tick what to add</div>
                <div className="list">
                  {matched.map((r) => (
                    <div key={r.key} className="item" style={{ flexWrap: 'wrap' }}>
                      <button type="button" className="check" aria-label={`Add ${r.item!.name}`} aria-pressed={r.keep}
                        style={r.keep ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-ink)' } : undefined}
                        onClick={() => change(r.key, { keep: !r.keep })}><Icon name="check" size="sm" /></button>
                      <span className="item-main" style={{ flex: '1 1 160px' }}>
                        <span className="item-name">{r.item!.name}{r.match === 'guess' && <span className="pill p-soon" style={{ marginLeft: 8 }}>Check</span>}</span>
                        <span className="item-meta">
                          <span style={{ fontFamily: 'var(--mono, monospace)' }}>{r.text}</span>
                          {r.price !== null ? ` · ${money(r.price, currency, 2)}` : ''}
                          {r.match === 'learnt' ? ' · as before' : r.match === 'guess' ? ' · a guess' : ''}
                        </span>
                      </span>
                      <span className="row" style={{ gap: 6, marginLeft: 'auto' }}>
                        <Stepper small value={r.quantity} min={0} onChange={(n) => change(r.key, { quantity: n, keep: n > 0 })} label={`How many ${r.item!.name} (${r.item!.unit})`} />
                        {r.item!.unit !== 'each' && <span className="small muted" style={{ minWidth: 34 }}>{plural(r.item!.unit, r.quantity)}</span>}
                        <button type="button" className="btn small ghost" onClick={() => setPicking(r.key)}>Change</button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {unmatched.length > 0 && (
              <div className="section">
                <div className="label">Not in Larder · left out</div>
                <p className="small muted" style={{ marginTop: 0 }}>Receipts are often vague. If one of these is something you keep, match it, and Larder remembers it for this shop.</p>
                <div className="list">
                  {unmatched.map((r) => (
                    <div key={r.key} className="item">
                      <span className="item-main">
                        <span className="item-name" style={{ fontFamily: 'var(--mono, monospace)', fontWeight: 500 }}>{r.text}</span>
                        {r.price !== null && <span className="item-meta">{money(r.price, currency, 2)}</span>}
                      </span>
                      <button type="button" className="btn small" onClick={() => setPicking(r.key)}>Match</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!rows.length && receipt.readable && <p className="small muted">Nothing on that receipt to add.</p>}
            <div className="dock">
              <button type="button" className="btn" disabled={busy} onClick={startAgain}>Start again</button>
              <button type="button" className="btn primary" disabled={busy || !kept.length} onClick={() => void add()}>
                {kept.length ? `Add ${kept.length === 1 ? '1 thing' : `${kept.length} things`} to stock` : 'Tick what to add'}
              </button>
            </div>
          </>
        )}
      </div>
      {picking !== null && rows.find((r) => r.key === picking) && (
        <PickItem
          row={rows.find((r) => r.key === picking)!}
          onClose={() => setPicking(null)}
          onPick={(item) => {
            const row = rows.find((r) => r.key === picking)!;
            // Another item counted in something else: start from how many the receipt says.
            const quantity = item && row.item?.unit === item.unit ? row.quantity : row.count;
            change(row.key, item ? { item, quantity, match: 'picked', keep: true } : { item: null, quantity: row.count, match: 'none', keep: false });
            setPicking(null);
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function ProviderSettings({ id, s, status, position, admin }: { id: ProviderId; s: ProviderStatus; status: Status; position: number; admin: boolean }) {
  const { run, busy } = useAction();
  const [key, setKey] = useState('');
  const models = useQuery({
    queryKey: ['ai', 'models', id, s.keyHint],
    queryFn: () => call<{ models: Array<{ id: string; name: string }>; default: string }>('GET', `/models?provider=${id}`),
    enabled: admin && s.keySet,
    retry: false,
    staleTime: 10 * 60_000,
  });
  const name = NAMES[id];
  const save = (body: Record<string, unknown>, done: string) => run(() => call<Status>('PUT', '/settings', body), done);
  const list = models.data?.models ?? [];
  const current = s.model ?? '';
  const defaultName = models.data ? list.find((m) => m.id === models.data!.default)?.name ?? models.data.default : null;
  const state = !s.enabled ? 'Off for now. Its key and model are kept.'
    : !s.keySet ? 'Needs an API key'
    : status.first === id ? 'Asked first'
    : `Asked when ${status.first ? NAMES[status.first] : 'the one above'} can't, e.g. out of credit`;

  return (
    <div className="list">
      <div className="toggle">
        <span className="grow"><b>{position + 1}. {name}</b><br /><span className="small muted">{state}</span></span>
        {admin && position > 0 && <button type="button" className="btn small" disabled={busy} onClick={() => void save({ order: [id] }, `${name} is asked first`)}>Ask first</button>}
        <Switch checked={s.enabled} label={`Use ${name}`} disabled={!admin || busy} onChange={(v) => void save({ [id]: { enabled: v } }, v ? `${name} is on` : `${name} is off for now. Its key and model are kept.`)} />
      </div>
      <div className="numfield" style={{ flexWrap: 'wrap', opacity: s.enabled ? 1 : 0.6 }}>
        <span><b>{name} API key</b><small>{s.keySet ? (s.keyFrom === 'env' ? `Set on the server (${s.keyHint})` : `Saved (${s.keyHint})`) : <>Get one at <a href={KEY_SITES[id].url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{KEY_SITES[id].text}</a></>}</small></span>
        {admin && (
          <form className="inputrow" style={{ flex: 1, minWidth: 280, maxWidth: 440 }} onSubmit={(e) => { e.preventDefault(); if (key.trim()) void save({ [id]: { apiKey: key.trim() } }, `${name} key saved`).then((r) => r && setKey('')); }}>
            <input className="input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.keySet ? 'Replace the key' : 'Paste the key'} aria-label={`${name} API key`} />
            <button className="btn small" disabled={busy || !key.trim()}>Save</button>
            {s.keyFrom === 'app' && <button type="button" className="btn small ghost" disabled={busy} onClick={() => void save({ [id]: { apiKey: null } }, `${name} key removed`)}>Remove</button>}
          </form>
        )}
      </div>
      {s.keySet && (
        <div className="numfield" style={{ flexWrap: 'wrap', opacity: s.enabled ? 1 : 0.6 }}>
          <span><b>{name} model</b><small>{models.isError ? (models.error instanceof Error ? models.error.message : 'Couldn’t list the models.') : id === 'claude' ? 'Haiku is quick and costs a fraction of a penny a photo' : 'Flash is quick and cheap'}</small></span>
          {admin ? (
            <select className="input" style={{ width: 'auto', maxWidth: 320 }} value={current} disabled={busy || models.isLoading} aria-label={`${name} model`} onChange={(e) => void save({ [id]: { model: e.target.value || null } }, `${name} will use ${e.target.value ? list.find((m) => m.id === e.target.value)?.name ?? e.target.value : 'its default model'}`)}>
              <option value="">{models.isLoading ? 'Loading…' : `Default${defaultName ? ` (${defaultName})` : ''}`}</option>
              {current && !list.some((m) => m.id === current) && <option value={current}>{current}</option>}
              {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          ) : <span>{current || 'Default'}</span>}
        </div>
      )}
    </div>
  );
}

function AiSettings({ admin }: { admin: boolean }) {
  const s = useStatus().data;
  if (!s) return null;
  return (
    <div className="section">
      <div className="label">AI</div>
      <p className="small muted">
        For Add by photo. Larder asks these in order: if one can't (out of credit, say), the next reads the photo. Switch one off to stop using it for now; its key and model are kept.
        {' '}Photos only go to these, only when you use Add by photo, with your own API keys. Larder never shows a saved key again.
      </p>
      {!s.ready && <p className="small"><b>{s.claude.keySet || s.gemini.keySet ? 'Every AI with a key is switched off, so Add by photo is hidden.' : 'Add a key to Claude or Gemini to use Add by photo.'}</b></p>}
      {s.order.map((id, i) => <ProviderSettings key={id} id={id} s={s[id]} status={s} position={i} admin={admin} />)}
    </div>
  );
}

export default defineWebModule({
  id: 'ai',
  pages: [
    { path: '/photo', title: 'Add by photo', hidden: true, component: AddByPhoto },
    { path: '/receipt', title: 'Add from receipt', hidden: true, component: ReceiptPage },
  ],
  addActions: [
    { path: '/photo', title: 'Add by photo', subtitle: 'Snap the pack and the details fill themselves in', icon: 'camera', useShown: () => !!useStatus().data?.ready },
    { path: '/receipt', title: 'Add from receipt', subtitle: 'What you bought, into stock', icon: 'receipt', useShown: () => !!useStatus().data?.ready },
  ],
  photoReader,
  settingsPanels: [AiSettings],
});
