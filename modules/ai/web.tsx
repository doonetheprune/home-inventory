/**
 * Add by photo, and the AI section in Settings. The photo is taken with a live
 * camera view (or uploaded), shrunk on the phone, read by the AIs in the
 * household's order, then opened on the Add item page to check before saving.
 * A barcode in the photo is read on the phone.
 */
import { useEffect, useRef, useState } from 'react';
import {
  api, ApiError, defineWebModule, Empty, ErrorBox, Header, Icon, Link, ProductTile, Sheet, Switch, grabFrame, readBarcode, useAction, useAddItem, useCamera, useQuery, useQueryClient,
  type AddItemDraft, type ProductSummary,
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

/** Big enough to read small print, small enough to send quickly: about 1600 pixels on the long side, as a JPEG. */
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
/* Add by photo                                                        */
/* ------------------------------------------------------------------ */

type Step =
  | { kind: 'camera' }
  | { kind: 'reading'; preview: string }
  | { kind: 'known'; preview: string; product: ProductSummary }
  | { kind: 'unsure'; preview: string; draft: AddItemDraft }
  | { kind: 'shop'; preview: string; draft: AddItemDraft; shop: NonNullable<Identified['shop']> }
  | { kind: 'failed'; preview: string | null; message: string };

/**
 * Keys that take the photo: Space, the volume buttons (like a phone's camera
 * app, where the phone passes them to the page), and a camera key.
 */
const SHUTTER_KEYS = new Set([' ', 'AudioVolumeDown', 'AudioVolumeUp', 'VolumeDown', 'VolumeUp', 'Camera']);

/** The live camera with its shutter, like the barcode scanner's view. */
function CameraView({ intro, onPhoto, onUpload, onRetry }: { intro: string; onPhoto: (photo: Blob) => void; onUpload: () => void; onRetry: () => void }) {
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
    <>
      <div className="viewfinder" aria-label="Camera">
        <video ref={video} playsInline muted hidden={cam.state !== 'on'} />
        {cam.state !== 'on' && (
          <div className="vf-idle">
            {cam.state === 'error' ? <Icon name="camera" size="lg" /> : <div className="spinner" />}
            <p className="small">{cam.error ?? 'Starting the camera…'}</p>
            {cam.state === 'error' && <button type="button" className="btn small" onClick={onRetry}>Try again</button>}
          </div>
        )}
      </div>
      <p className="small muted">{intro}</p>
      <button type="button" className="btn primary block" disabled={cam.state !== 'on' || shooting} onClick={() => void shoot()}><Icon name="camera" />Take photo</button>
      <button type="button" className="btn block" onClick={onUpload}>Upload a photo</button>
      {cam.state === 'on' && <p className="small muted" style={{ textAlign: 'center' }}>A volume button or Space takes the photo too, where your phone allows it.</p>}
    </>
  );
}

function AddByPhoto() {
  const status = useStatus();
  const addItem = useAddItem();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const [step, setStep] = useState<Step>({ kind: 'camera' });
  // A new key starts the camera afresh (Try again).
  const [cameraKey, setCameraKey] = useState(0);
  const upload = useRef<HTMLInputElement>(null);
  const preview = 'preview' in step ? step.preview : null;
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  async function read(file: Blob) {
    const shown = URL.createObjectURL(file);
    setStep({ kind: 'reading', preview: shown });
    let photo: Blob;
    try {
      photo = await shrink(file);
    } catch {
      setStep({ kind: 'failed', preview: shown, message: "Larder can't open that photo. Take one with the camera, or use a JPEG or PNG." });
      return;
    }
    // The barcode, read on the phone, says whether it's already in Larder; the AI reads the rest at the same time.
    const known = readBarcode(file).then(async (barcode) => {
      if (!barcode) return { barcode: null, product: null };
      const found = await api.identify(barcode).catch(() => null);
      return { barcode, product: found?.kind === 'product' ? found.product : null };
    });
    const reading = base64(photo).then((image) => call<Identified>('POST', '/identify', { image }));
    const [{ barcode, product }, result] = await Promise.all([known, reading.then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }))]);
    if (product) {
      setStep({ kind: 'known', preview: shown, product });
      return;
    }
    if (!result.ok) {
      setStep({ kind: 'failed', preview: shown, message: result.e instanceof ApiError ? result.e.message : 'Reading the photo went wrong. Try again.' });
      return;
    }
    const r = result.r;
    const draft: AddItemDraft = {
      name: r.name,
      aliases: r.aliases,
      categoryId: r.categoryId,
      unit: r.unit,
      shelfLifeDays: r.shelfLifeDays,
      preferredShopIds: r.shop?.id ? [r.shop.id] : [],
      brand: r.brand,
      barcode,
      photo,
      source: r.provider,
      // Say when the first AI couldn't (out of credit, say), so it can be sorted out.
      note: `Read from your photo by ${NAMES[r.provider]}.${r.skipped.map((x) => ` ${x.message}`).join('')} Check it before adding.`,
    };
    if (!r.readable) setStep({ kind: 'unsure', preview: shown, draft });
    else next(draft, r.shop, shown);
  }

  /** Asks about a shop Larder doesn't have yet, then opens Add item. */
  function next(draft: AddItemDraft, shop: Identified['shop'], shown: string) {
    if (shop && !shop.id) setStep({ kind: 'shop', preview: shown, draft, shop });
    else addItem(draft, { replace: true });
  }

  async function addShop(draft: AddItemDraft, shop: NonNullable<Identified['shop']>) {
    const made = await run(() => (shop.preset ? api.shops.addPreset(shop.name) : api.shops.create({ name: shop.name, sells: draft.categoryId ? [draft.categoryId] : [] })), `${shop.name} added to your shops`);
    if (!made) return;
    await qc.invalidateQueries({ queryKey: ['shops'] });
    addItem({ ...draft, preferredShopIds: [made.id] }, { replace: true });
  }

  // Upload is a plain file picker (the phone's photos or files); the camera is the live view above.
  const picker = <input ref={upload} type="file" accept="image/*" hidden data-testid="ai-upload" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }} />;
  const again = <div className="btnrow"><button type="button" className="btn primary" onClick={() => setStep({ kind: 'camera' })}><Icon name="camera" />Take another</button><button type="button" className="btn" onClick={() => upload.current?.click()}>Upload a photo</button></div>;
  const photo = preview && <img src={preview} alt="Your photo" style={{ width: '100%', maxHeight: 320, objectFit: 'contain', borderRadius: 16, background: 'var(--surface)' }} />;

  if (status.data && !status.data.ready) {
    return (
      <>
        <Header title="Add by photo" back="/" />
        <div className="content" style={{ maxWidth: 640 }}>
          <Empty title="Choose an AI first">
            <span className="small muted">Add by photo uses Claude or Gemini with your own API key. Set it up in Settings, under AI.</span>
            <div className="btnrow"><Link className="btn primary small" to="/settings">Settings</Link><Link className="btn small" to="/add">Add by name instead</Link></div>
          </Empty>
        </div>
      </>
    );
  }

  return (
    <>
      <Header title="Add by photo" back="/" />
      <div className="content stack" style={{ maxWidth: 640, gap: 16 }}>
        {picker}
        {step.kind === 'camera' && status.data && (
          <CameraView
            key={cameraKey}
            onRetry={() => setCameraKey((k) => k + 1)}
            intro={`Fill the frame with the front of the pack. ${status.data.first ? NAMES[status.data.first] : 'The AI'} reads it and fills in the details for you to check.`}
            onPhoto={(p) => void read(p)}
            onUpload={() => upload.current?.click()}
          />
        )}
        {step.kind === 'reading' && (
          <>
            {photo}
            <div className="row" style={{ gap: 10, alignItems: 'center' }}><div className="spinner" aria-hidden="true" /><b>Reading the label…</b></div>
          </>
        )}
        {step.kind === 'known' && (
          <>
            {photo}
            <div className="card pad stack" style={{ gap: 10 }}>
              <span className="small muted">Already in Larder</span>
              <div className="row" style={{ gap: 12, alignItems: 'center' }}><ProductTile s={step.product} /><b>{step.product.product.name}</b></div>
              <div className="btnrow">
                <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => api.stock.add({ productId: step.product.product.id, quantity: 1 }), `Added 1 ${step.product.product.name}`).then((r) => r && setStep({ kind: 'camera' }))}>Add 1</button>
                <Link className="btn" to={`/products/${step.product.product.id}`}>Open</Link>
              </div>
            </div>
            {again}
          </>
        )}
        {step.kind === 'unsure' && (
          <>
            {photo}
            <div className="card pad stack" style={{ gap: 10 }}>
              <b>{NAMES[step.draft.source as ProviderId] ?? 'The AI'} couldn't make out what this is.</b>
              <span className="small muted">Its best guess is “{step.draft.name}”. Try a clearer photo of the front of the pack, or carry on and fix it by hand.</span>
              <div className="btnrow"><button type="button" className="btn" onClick={() => addItem(step.draft, { replace: true })}>Use the guess</button></div>
            </div>
            {again}
          </>
        )}
        {step.kind === 'failed' && (
          <>
            {photo}
            <ErrorBox error={new Error(step.message)} />
            {again}
            <Link className="link small" to="/add">Add by name instead</Link>
          </>
        )}
        {step.kind === 'shop' && (
          <>
            {photo}
            <Sheet title={`Add ${step.shop.name}?`} onClose={() => addItem(step.draft, { replace: true })}>
              <p>{step.shop.name} isn't one of your shops yet. Add it, so this goes on its shopping list?</p>
              <div className="btnrow">
                <button type="button" className="btn primary" disabled={busy} onClick={() => void addShop(step.draft, step.shop)}>Add {step.shop.name}</button>
                <button type="button" className="btn" onClick={() => addItem(step.draft, { replace: true })}>Not now</button>
              </div>
            </Sheet>
          </>
        )}
      </div>
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
        <Switch checked={s.enabled} label={`Use ${name}`} onChange={(v) => { if (admin && !busy) void save({ [id]: { enabled: v } }, v ? `${name} is on` : `${name} is off for now. Its key and model are kept.`); }} />
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
  pages: [{ path: '/photo', title: 'Add by photo', hidden: true, component: AddByPhoto }],
  addActions: [{ path: '/photo', title: 'Add by photo', subtitle: 'Snap the pack and the details fill themselves in', icon: 'camera', useShown: () => !!useStatus().data?.ready }],
  settingsPanels: [AiSettings],
});
