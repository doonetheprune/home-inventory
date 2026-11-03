/**
 * The AI section in Settings, and the photo reading behind the scanner's
 * "Read with AI": a photo is shrunk on the phone and read by the AIs in the
 * household's order. Add by photo (on Home) opens the scanner with the camera on.
 */
import { useEffect, useState } from 'react';
import { api, defineWebModule, Switch, useAction, useNavigate, useQuery, type PhotoReader } from '@larder/web-sdk';

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
  photoReader,
  settingsPanels: [AiSettings],
});
