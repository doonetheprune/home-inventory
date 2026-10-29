import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { qty, stockText } from '../format';
import { ProductForm, emptyForm, toPayload } from '../components/ProductForm';
import { Header, PlaceSelect, ProductRow, Stepper, useAction, useCategories, useDebounced, usePlaces, useShops } from '../ui';

export function AddItem() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const categories = useCategories();
  const shops = useShops();
  const places = usePlaces();
  const { run, busy } = useAction();
  const [form, setForm] = useState(() => ({ ...emptyForm(params.get('name') ?? ''), wish: params.get('wish') === '1' }));
  const [n, setN] = useState(1);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const dq = useDebounced(form.name.trim(), 200);
  const { data } = useQuery({ queryKey: ['search', dq], queryFn: () => api.search(dq), enabled: dq.length > 1 });
  const existing = (data?.sections.find((s) => s.id === 'stock')?.results ?? []).slice(0, 3);
  const exact = existing.find((r) => r.title.toLowerCase() === form.name.trim().toLowerCase());

  async function save() {
    const created = await run(async () => {
      const p = await api.products.create(toPayload(form));
      if (!form.wish && n > 0) await api.stock.add({ productId: p.id, quantity: n, placeId: placeId ?? form.defaultPlaceId });
      return p;
    }, form.wish ? `${form.name} is on the wish list` : `${form.name} added · ${qty(n, form.unit)}`);
    if (created) navigate(`/products/${created.id}`, { replace: true });
  }

  return (
    <>
      <Header title="Add by name" back />
      <div className="content" style={{ maxWidth: 760 }}>
        <label className="field"><span>What is it?</span><input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Head torch, heating oil, AA batteries…" /></label>
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
