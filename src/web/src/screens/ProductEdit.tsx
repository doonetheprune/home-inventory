import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { ProductForm, toPayload, usageForm, type ProductFormValue } from '../components/ProductForm';
import { num, plural, qty, sameUnit } from '../format';
import { ErrorBox, Header, Loading, useAction, useCategories, usePlaces, useShops } from '../ui';

export function ProductEdit() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: p, error, isLoading } = useQuery({ queryKey: ['product', id], queryFn: () => api.products.get(id) });
  const categories = useCategories();
  const shops = useShops();
  const places = usePlaces();
  const { run, busy } = useAction();
  const [form, setForm] = useState<ProductFormValue | null>(null);
  const [initial, setInitial] = useState<ProductFormValue | null>(null);
  const [confirm, setConfirm] = useState(false);
  /** Asked before saving a new "Counted in" when the old unit is now what it comes in. */
  const [recount, setRecount] = useState<null | { packName: string; holds: number }>(null);

  useEffect(() => {
    if (p && !form) {
      const x = p.product;
      const f: ProductFormValue = { name: x.name, aliases: x.aliases.join(', '), categoryId: x.categoryId, unit: x.unit, shelfLifeDays: x.shelfLifeDays, ...usageForm(x), minQuantity: x.minQuantity, stockUpTo: x.stockUpTo ?? null, preferredShopIds: x.preferredShopIds, defaultPlaceId: x.defaultPlaceId, notes: x.notes, links: x.links.map((l) => l.url).join('\n'), wish: x.wish, rechargeable: x.rechargeable };
      setForm(f);
      setInitial(f);
    }
  }, [p, form]);

  if (isLoading || !form || !initial) return error ? <div className="content"><ErrorBox error={error} /></div> : <Loading />;
  const was = p!.product;
  const have = p!.inStock + p!.expected + p!.pending;

  /**
   * Counting what's inside now: what it was counted in (box) is what it comes in, and it's counted in
   * something else (tea bag). Asked even with none in stock, as its prices and recipes follow too.
   */
  function recountOffer(f: ProductFormValue) {
    const packName = f.packName.trim();
    if (sameUnit(f.unit, was.unit) || !packName || f.packHolds <= 1 || !sameUnit(packName, was.unit)) return null;
    return { packName, holds: f.packHolds };
  }

  const save = (f: ProductFormValue) => run(() => api.products.update(id, toPayload(f)), 'Saved').then((r) => r && navigate(`/products/${id}`));

  /** Recounts, then saves: numbers changed on the form are already in the new unit; the rest are multiplied. */
  function saveRecounted(r: { packName: string; holds: number }) {
    const f = form!;
    const times = (now: number | null, before: number | null) => (now !== null && now === before ? Math.round(now * r.holds * 1000) / 1000 : now);
    const sameUsage = f.usageAmount === initial!.usageAmount && f.usageEvery === initial!.usageEvery && f.usagePer === initial!.usagePer;
    const scaled: ProductFormValue = { ...f, minQuantity: times(f.minQuantity, initial!.minQuantity), stockUpTo: times(f.stockUpTo, initial!.stockUpTo), usageAmount: sameUsage ? times(f.usageAmount, initial!.usageAmount) : f.usageAmount };
    return run(async () => {
      await api.stock.recount(id, { unit: f.unit.trim(), holds: r.holds, pack: r.packName });
      try {
        return await api.products.update(id, toPayload(scaled));
      } catch (err) {
        // It's counted again, but the rest wasn't saved: show what is saved now, to check and save again.
        setRecount(null);
        setForm(null);
        setInitial(null);
        await qc.invalidateQueries({ queryKey: ['product', id] });
        throw err;
      }
    }, `Now counted in ${plural(f.unit.trim(), 2)}`).then((x) => x && navigate(`/products/${id}`));
  }

  function onSave() {
    const offer = recountOffer(form!);
    if (offer) setRecount(offer);
    else void save(form!);
  }

  return (
    <>
      <Header title={`Edit ${p!.product.name}`} back={`/products/${id}`} />
      <div className="content" style={{ maxWidth: 760 }}>
        <ProductForm value={form} onChange={setForm} categories={categories} shops={shops} places={places} />
        {recount ? (
          <div className="card pad" role="alertdialog" aria-label="Count what's inside?">
            <b>{have > 0 ? `You have ${qty(have, was.unit)}.` : `${was.name} is counted in ${plural(was.unit, 2)}.`} Count {have > 0 ? 'them' : 'it'} in {plural(form.unit.trim(), 2)} now?</b>
            <p className="small muted" style={{ margin: 0 }}>
              1 {recount.packName} = {num(recount.holds)} {plural(form.unit.trim(), recount.holds)}, so {have > 0 ? `${qty(have, was.unit)} become ${qty(have * recount.holds, form.unit.trim())}` : 'its numbers are multiplied'}.
              Low below, stock up to and how fast it's used follow, and so do prices, deliveries, online shop packs and recipes.
            </p>
            <div className="btnrow">
              <button type="button" className="btn primary" disabled={busy} onClick={() => void saveRecounted(recount)}>{have > 0 ? `Count them as ${qty(have * recount.holds, form.unit.trim())}` : `Count it in ${plural(form.unit.trim(), 2)}`}</button>
              <button type="button" className="btn" disabled={busy} onClick={() => void save(form)}>Keep the numbers, just rename</button>
              <button type="button" className="btn ghost" onClick={() => setRecount(null)}>Back</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn primary block" disabled={busy || !form.name.trim()} onClick={onSave}>Save</button>
        )}
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
