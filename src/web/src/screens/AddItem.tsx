import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { takeDraft, type AddItemDraft } from '../drafts';
import { rotatePhoto } from '../components/camera';
import { Icon } from '../icons';
import { qty, stockText } from '../format';
import { ProductForm, emptyForm, toPayload, type ProductFormValue } from '../components/ProductForm';
import { Header, PlaceSelect, ProductRow, Stepper, useAction, useCategories, useDebounced, usePlaces, useShops } from '../ui';

function fromDraft(d: AddItemDraft): ProductFormValue {
  const f = emptyForm(d.name);
  return {
    ...f,
    aliases: (d.aliases ?? []).join(', '),
    categoryId: d.categoryId ?? null,
    unit: d.unit || f.unit,
    shelfLifeDays: d.shelfLifeDays ?? null,
    preferredShopIds: d.preferredShopIds ?? [],
  };
}

/** An address for a photo still on the phone, tidied away when the page closes. */
function usePhotoUrl(photo: Blob | null | undefined): string | null {
  const url = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

export function AddItem() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const categories = useCategories();
  const shops = useShops();
  const places = usePlaces();
  const { run, busy } = useAction();
  // Filled in by a module (Add by photo): details to check, plus a photo, brand and barcode to save with it.
  const draft = useMemo(() => takeDraft(params.get('draft')), [params]);
  // The draft's photo, turned round here if it came out sideways.
  const [photo, setPhoto] = useState<Blob | null>(() => draft?.photo ?? null);
  const photoUrl = usePhotoUrl(photo);
  const [form, setForm] = useState(() => (draft ? fromDraft(draft) : { ...emptyForm(params.get('name') ?? ''), wish: params.get('wish') === '1' }));
  const [n, setN] = useState(1);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const dq = useDebounced(form.name.trim(), 200);
  const { data } = useQuery({ queryKey: ['search', dq], queryFn: () => api.search(dq), enabled: dq.length > 1 });
  const existing = (data?.sections.find((s) => s.id === 'stock')?.results ?? []).slice(0, 3);
  const exact = existing.find((r) => r.title.toLowerCase() === form.name.trim().toLowerCase());

  async function save() {
    const created = await run(async () => {
      const photoId = photo ? (await api.files.upload(new File([photo], 'photo.jpg', { type: photo.type || 'image/jpeg' }))).id : null;
      const p = await api.products.create({ ...toPayload(form), photoFileIds: photoId ? [photoId] : [] });
      if (draft && (draft.brand || draft.barcode)) {
        const variant = { name: draft.brand || p.name, barcodes: draft.barcode ? [draft.barcode] : [], photoFileId: photoId, source: draft.source ?? 'local' };
        // A barcode another item has already got is left off rather than losing the new item.
        await api.products.addVariant(p.id, variant).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 409 && variant.barcodes.length) return api.products.addVariant(p.id, { ...variant, barcodes: [] });
          throw err;
        });
      }
      if (!form.wish && n > 0) await api.stock.add({ productId: p.id, quantity: n, placeId: placeId ?? form.defaultPlaceId });
      return p;
    }, form.wish ? `${form.name} is on the wish list` : `${form.name} added · ${qty(n, form.unit)}`);
    if (created) navigate(`/products/${created.id}`, { replace: true });
  }

  return (
    <>
      <Header title={draft ? 'Add item' : 'Add by name'} back />
      <div className="content" style={{ maxWidth: 760 }}>
        {draft && (
          <div className="card pad" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {photoUrl && <img src={photoUrl} alt="Your photo" style={{ width: 72, height: 72, objectFit: 'contain', borderRadius: 12, flex: 'none', background: 'var(--surface-2, var(--line))' }} />}
            <div className="stack" style={{ gap: 2, minWidth: 0 }}>
              {draft.brand && <b>{draft.brand}</b>}
              {draft.barcode && <span className="small muted">Barcode {draft.barcode}</span>}
              {draft.note && <span className="small muted">{draft.note}</span>}
              {photo && (
                <button type="button" className="link small" style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6 }} disabled={busy}
                  onClick={() => void rotatePhoto(photo).then(setPhoto, () => undefined)}>
                  <Icon name="rotate" size="sm" />Rotate photo
                </button>
              )}
            </div>
          </div>
        )}
        <label className="field"><span>What is it?</span><input className="input" autoFocus={!draft} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Head torch, heating oil, AA batteries…" /></label>
        {existing.length > 0 && (
          <div className="section">
            <div className="label">Already in Larder</div>
            <div className="list">
              {existing.map((r) => r.product && (
                <ProductRow key={r.id} s={r.product} to={`/products/${r.id}`}
                  side={<button type="button" className="btn small" disabled={busy} onClick={(e) => { e.preventDefault(); void run(() => api.stock.add({ productId: r.id, quantity: 1 }), (s) => `Added 1 · ${stockText(s)}`); }}>Add 1</button>} />
              ))}
            </div>
            {!exact && <p className="small muted">Not one of these? Fill in the rest below to create “{form.name.trim()}”.</p>}
          </div>
        )}

        {!form.wish && (
          <div className="list">
            <div className="numfield"><span><b>How many now</b></span><Stepper value={n} onChange={setN} label="quantity" /></div>
            <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>Where</b><small>{places.length ? 'Where you’re putting it' : <Link to="/places" style={{ color: 'var(--accent)' }}>Set up places first</Link>}</small></span>
              <div style={{ minWidth: 200, flex: 1, maxWidth: 360 }}><PlaceSelect value={placeId ?? form.defaultPlaceId} onChange={(v) => { setPlaceId(v); if (!form.defaultPlaceId) setForm({ ...form, defaultPlaceId: v }); }} places={places} /></div>
            </div>
          </div>
        )}

        <ProductForm value={form} onChange={setForm} categories={categories} shops={shops} places={places} showName={false} />
        <button type="button" className="btn primary block" disabled={busy || !form.name.trim()} onClick={save}>
          <Icon name="plus" />{form.wish ? `Add ${form.name.trim() || 'it'} to the wish list` : `Add ${form.name.trim().toLowerCase() || 'item'}`}
        </button>
      </div>
    </>
  );
}
