import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { ProductForm, toPayload, type ProductFormValue } from '../components/ProductForm';
import { ErrorBox, Header, Loading, useAction, useCategories, usePlaces, useShops } from '../ui';

export function ProductEdit() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: p, error, isLoading } = useQuery({ queryKey: ['product', id], queryFn: () => api.products.get(id) });
  const categories = useCategories();
  const shops = useShops();
  const places = usePlaces();
  const { run, busy } = useAction();
  const [form, setForm] = useState<ProductFormValue | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (p && !form) {
      const x = p.product;
      setForm({ name: x.name, aliases: x.aliases.join(', '), categoryId: x.categoryId, unit: x.unit, shelfLifeDays: x.shelfLifeDays, minQuantity: x.minQuantity, preferredShopIds: x.preferredShopIds, defaultPlaceId: x.defaultPlaceId, notes: x.notes, links: x.links.map((l) => l.url).join('\n'), wish: x.wish, rechargeable: x.rechargeable });
    }
  }, [p, form]);

  if (isLoading || !form) return error ? <div className="content"><ErrorBox error={error} /></div> : <Loading />;

  return (
    <>
      <Header title={`Edit ${p!.product.name}`} back={`/products/${id}`} />
      <div className="content" style={{ maxWidth: 760 }}>
        <ProductForm value={form} onChange={setForm} categories={categories} shops={shops} places={places} />
        <button type="button" className="btn primary block" disabled={busy || !form.name.trim()} onClick={() => run(() => api.products.update(id, toPayload(form)), 'Saved').then((r) => r && navigate(`/products/${id}`))}>Save</button>
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
