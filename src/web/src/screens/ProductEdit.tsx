import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { ProductForm, toPayload, usageForm, type ProductFormValue } from '../components/ProductForm';
import { qty } from '../format';
import { useUnits } from '../units';
import { ErrorBox, Header, Loading, useAction, useCategories, usePlaces, useShops } from '../ui';

export function ProductEdit() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: p, error, isLoading } = useQuery({ queryKey: ['product', id], queryFn: () => api.products.get(id) });
  const categories = useCategories();
  const shops = useShops();
  const places = usePlaces();
  const units = useUnits();
  const { run, busy } = useAction();
  const [form, setForm] = useState<ProductFormValue | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (p && !form) {
      const x = p.product;
      setForm({ name: x.name, aliases: x.aliases.join(', '), categoryId: x.categoryId, unit: x.unit, shelfLifeDays: x.shelfLifeDays, ...usageForm(units, x), minQuantity: x.minQuantity, stockUpTo: x.stockUpTo ?? null, preferredShopIds: x.preferredShopIds, defaultPlaceId: x.defaultPlaceId, notes: x.notes, links: x.links.map((l) => l.url).join('\n'), wish: x.wish, rechargeable: x.rechargeable });
    }
  }, [p, form, units]);

  if (isLoading || !form) return error ? <div className="content"><ErrorBox error={error} /></div> : <Loading />;
  const was = p!.product;
  const have = p!.inStock + p!.expected + p!.pending;
  // A new Bought in keeps the numbers: say what they'll read as, so a count in something else gets corrected.
  const renamed = form.unit !== was.unit && have > 0;

  const save = () => run(() => api.products.update(id, toPayload(form, units)), renamed ? `Saved · ${qty(have, form.unit)} now: correct the count if that's wrong` : 'Saved').then((r) => r && navigate(`/products/${id}`));

  return (
    <>
      <Header title={`Edit ${p!.product.name}`} back={`/products/${id}`} />
      <div className="content" style={{ maxWidth: 760 }}>
        {was.needsCheck && <div className="card pad" role="note"><b>To tidy</b><p className="small" style={{ margin: 0 }}>{was.needsCheck}</p><small className="muted">Saving takes it off the To tidy list.</small></div>}
        <ProductForm value={form} onChange={setForm} categories={categories} shops={shops} places={places} />
        {renamed && <p className="small muted" style={{ margin: 0 }}>{qty(have, was.unit)} will read as {qty(have, form.unit)}: the numbers stay as they are, so correct the count afterwards if they were in something else.</p>}
        <button type="button" className="btn primary block" disabled={busy || !form.name.trim()} onClick={() => void save()}>Save</button>
        <div className="card pad">
          <b>Remove {p!.product.name}</b>
          <p className="small muted">Removes it, its brands and all its stock. History is kept.</p>
          {confirm ? (
            <div className="btnrow"><button type="button" className="btn" onClick={() => setConfirm(false)}>Keep it</button><button type="button" className="btn danger" disabled={busy} onClick={() => run(() => api.products.remove(id), 'Removed').then(() => navigate('/stock', { replace: true }))}><Icon name="trash" size="sm" />Yes, remove it</button></div>
          ) : (
            <button type="button" className="btn danger" onClick={() => setConfirm(true)}><Icon name="trash" size="sm" />Remove</button>
          )}
        </div>
      </div>
    </>
  );
}
