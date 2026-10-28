/** Unit pricing UI: a price panel on product pages and a pack checker on shopping lists. */
import { useState } from 'react';
import { api, defineWebModule, money, plural, useAction, useQuery, type ProductDetail, type ShoppingList } from '@larder/web-sdk';

interface PricingFields { usualUnitPrice: number | null; priceUnit: string | null; basedOn: string; updatedAt: string | null }
interface Check { unitPrice: number; usualUnitPrice: number | null; verdict: 'cheaper' | 'dearer' | 'same' | 'no_usual_price'; message: string; priceUnit: string }

const fieldsOf = (p: { fields: Record<string, unknown> }): PricingFields =>
  ({ usualUnitPrice: null, priceUnit: null, basedOn: '', updatedAt: null, ...((p.fields.pricing as Partial<PricingFields>) ?? {}) });

function useCurrency() {
  return useQuery({ queryKey: ['settings'], queryFn: api.settings.get, staleTime: 60_000 }).data?.currency ?? 'GBP';
}

function PackChecker({ productId, unit, onUpdated }: { productId: string; unit: string; onUpdated?: () => void }) {
  const currency = useCurrency();
  const { run, busy } = useAction();
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const q = Number(quantity);
  const p = Number(price);
  const valid = q > 0 && p >= 0 && price !== '';

  async function doCheck() {
    if (!valid) return;
    const r = await run(() => api.modules.call<Check>('pricing', 'POST', '/check', { productId, quantity: q, price: p }));
    if (r) setCheck(r);
  }

  return (
    <div className="stack">
      <div className="inputrow">
        <label className="field" style={{ flex: 1 }}><span>{unit === 'each' ? 'How many in the pack' : `${plural(unit, 2)} in the pack`}</span><input className="input" inputMode="decimal" value={quantity} onChange={(e) => { setQuantity(e.target.value); setCheck(null); }} placeholder="24" /></label>
        <label className="field" style={{ flex: 1 }}><span>Pack price</span><input className="input" inputMode="decimal" value={price} onChange={(e) => { setPrice(e.target.value); setCheck(null); }} placeholder="8.00" /></label>
      </div>
      <button type="button" className="btn small" style={{ justifySelf: 'start' }} disabled={!valid || busy} onClick={doCheck}>Check the price</button>
      {check && (
        <div className={`verdict ${check.verdict}`}>
          <span>{check.verdict === 'cheaper' ? 'Cheaper than usual' : check.verdict === 'dearer' ? 'Dearer than usual' : check.verdict === 'same' ? 'About the same' : 'No usual price yet'}</span>
          <small style={{ fontWeight: 500, color: 'var(--ink)' }}>{check.message}</small>
        </div>
      )}
      {check && check.verdict !== 'same' && (
        <button type="button" className="btn small" style={{ justifySelf: 'start' }} disabled={busy} onClick={() => run(() => api.modules.call('pricing', 'PUT', '/usual', { productId, quantity: q, price: p, basedOn: `${q} for ${money(p, currency, 2)}` }), `Usual price is now ${money(check.unitPrice, currency)} a ${check.priceUnit}`).then(() => { setCheck(null); onUpdated?.(); })}>
          Make this the usual price
        </button>
      )}
    </div>
  );
}

function ProductPricePanel({ product }: { product: ProductDetail }) {
  const currency = useCurrency();
  const f = fieldsOf(product.product);
  const unit = f.priceUnit ?? product.product.unit;
  return (
    <div className="section">
      <div className="label">Price</div>
      <div className="card pad">
        {f.usualUnitPrice !== null ? (
          <dl className="kv">
            <dt>Usual price</dt><dd><span className="mono">{money(f.usualUnitPrice, currency)}</span> per {unit}</dd>
            {f.basedOn && <><dt>Based on</dt><dd>{f.basedOn}</dd></>}
          </dl>
        ) : (
          <p className="small muted">No usual price yet. Check a pack below, or add the price when you tick it off at the shop.</p>
        )}
        <PackChecker productId={product.product.id} unit={unit} />
      </div>
    </div>
  );
}

function ShoppingPriceCheck({ list }: { list: ShoppingList }) {
  const items = list.groups.flatMap((g) => g.items);
  const [id, setId] = useState(items[0]?.summary.product.id ?? '');
  const item = items.find((i) => i.summary.product.id === id);
  if (!items.length) return null;
  const f = item ? fieldsOf(item.summary.product) : null;
  return (
    <div className="card pad">
      <div className="label" style={{ margin: 0 }}>Spotted a different pack?</div>
      <select className="input" value={id} onChange={(e) => setId(e.target.value)} aria-label="Which item">
        {items.map((i) => <option key={i.summary.product.id} value={i.summary.product.id}>{i.summary.product.name}</option>)}
      </select>
      {item && <p className="small muted" style={{ marginTop: -4 }}>{f?.usualUnitPrice !== null && f ? <>Usually <b className="mono" style={{ color: 'var(--ink)' }}>{money(f.usualUnitPrice, 'GBP')}</b> a {f.priceUnit ?? item.summary.product.unit}.</> : 'No usual price yet.'}</p>}
      {item && <PackChecker key={id} productId={id} unit={f?.priceUnit ?? item.summary.product.unit} />}
    </div>
  );
}

export default defineWebModule({
  id: 'pricing',
  productPanels: [ProductPricePanel],
  shoppingPanels: [ShoppingPriceCheck],
});
