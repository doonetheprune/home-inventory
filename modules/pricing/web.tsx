/** Unit pricing UI: a price panel on product pages and a pack checker on shopping lists. */
import { useEffect, useState } from 'react';
import { api, defineWebModule, money, plural, useAction, useQuery, type ProductDetail, type ShoppingList } from '@larder/web-sdk';

type SizeUnit = 'g' | 'kg' | 'ml' | 'l';
interface View {
  usual: { price: number; unit: string; per: string } | null;
  basedOn: string;
  showPer: string;
  options: Array<{ unit: string; per: string; price: number | null; needsSize: boolean }>;
  itemSize: { amount: number; unit: SizeUnit } | null;
  itemUnit: string | null;
  packUnits: string[];
}
interface Check { unitPrice: number; usualUnitPrice: number | null; verdict: 'cheaper' | 'dearer' | 'same' | 'no_usual_price'; message: string; priceUnit: string; per: string }

const MEASURE_NAMES: Record<string, string> = { g: 'g', kg: 'kg', ml: 'ml', l: 'litres' };
/** A unit as a pack size reads: "g", "kg", "bags". */
const packUnitName = (u: string) => MEASURE_NAMES[u] ?? plural(u, 2);
const isVolume = (u: string) => u === 'ml' || u === '100ml' || u === 'l';
/** Prices under £1 get a third decimal place when it matters (as on the server): £0.333, but £0.55. */
const priceText = (n: number, currency: string) => money(n, currency, n < 1 && Math.round(n * 1000) % 10 !== 0 ? 3 : 2);

function useCurrency() {
  return useQuery({ queryKey: ['settings'], queryFn: api.settings.get, staleTime: 60_000 }).data?.currency ?? 'GBP';
}

function useView(productId: string) {
  return useQuery({ queryKey: ['pricing', 'view', productId], queryFn: () => api.modules.call<View>('pricing', 'GET', `/view/${encodeURIComponent(productId)}`), enabled: !!productId });
}

/** "One bag holds 200 g", so prices can be per 100 g or per kg. */
function SizeEditor({ productId, view, wanted, onDone }: { productId: string; view: View; wanted?: string; onDone: () => void }) {
  const { run, busy } = useAction();
  const [amount, setAmount] = useState(view.itemSize ? String(view.itemSize.amount) : '');
  const [unit, setUnit] = useState<SizeUnit>(view.itemSize?.unit ?? (wanted && isVolume(wanted) ? 'ml' : 'g'));
  const n = Number(amount);
  const save = () => run(() => api.modules.call('pricing', 'PUT', '/display', { productId, itemSize: { amount: n, unit }, ...(wanted ? { showPer: wanted } : {}) }), `One ${view.itemUnit} is ${n} ${unit}`).then((r) => r && onDone());
  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className="small muted">How much is in one {view.itemUnit}? Then Larder can work out its price by weight or volume.</span>
      <div className="inputrow">
        <input className="input" inputMode="decimal" style={{ flex: 1 }} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="200" aria-label={`How much one ${view.itemUnit} holds`} />
        <select className="input" style={{ width: 'auto' }} value={unit} onChange={(e) => setUnit(e.target.value as SizeUnit)} aria-label="Unit">
          {(['g', 'kg', 'ml', 'l'] as const).map((u) => <option key={u} value={u}>{MEASURE_NAMES[u]}</option>)}
        </select>
        <button type="button" className="btn small" disabled={busy || !(n > 0)} onClick={() => void save()}>Save</button>
        <button type="button" className="btn small ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function PackChecker({ productId, view }: { productId: string; view: View }) {
  const currency = useCurrency();
  const { run, busy } = useAction();
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState(view.itemUnit ?? view.packUnits[0] ?? 'each');
  const [price, setPrice] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  useEffect(() => setCheck(null), [amount, unit, price]);
  const q = Number(amount);
  const p = Number(price);
  const valid = q > 0 && p >= 0 && price !== '';
  const byWeight = view.packUnits.includes('g');

  async function doCheck() {
    if (!valid) return;
    const r = await run(() => api.modules.call<Check>('pricing', 'POST', '/check', { productId, quantity: q, unit, price: p }));
    if (r) setCheck(r);
  }

  return (
    <div className="stack">
      <div className="inputrow" style={{ flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '2 1 160px' }}><span>Pack size</span>
          <span className="inputrow">
            <input className="input" inputMode="decimal" style={{ flex: 1, minWidth: 0 }} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={view.itemUnit && unit === view.itemUnit ? '1' : '500'} aria-label="How much is in the pack" />
            <select className="input" style={{ width: 'auto' }} value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Pack size unit">
              {view.packUnits.map((u) => <option key={u} value={u}>{packUnitName(u)}</option>)}
            </select>
          </span>
        </label>
        <label className="field" style={{ flex: '1 1 100px' }}><span>Price</span><input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="2.50" /></label>
      </div>
      {byWeight && <span className="small muted">A shelf label works too: “£3.50/kg” is 1 kg for 3.50.</span>}
      <button type="button" className="btn small" style={{ justifySelf: 'start' }} disabled={!valid || busy} onClick={() => void doCheck()}>Check the price</button>
      {check && (
        <div className={`verdict ${check.verdict}`}>
          <span>{check.verdict === 'cheaper' ? 'Cheaper than usual' : check.verdict === 'dearer' ? 'Dearer than usual' : check.verdict === 'same' ? 'About the same' : 'No usual price yet'}</span>
          <small style={{ fontWeight: 500, color: 'var(--ink)' }}>{check.message}</small>
        </div>
      )}
      {check && check.verdict !== 'same' && (
        <button type="button" className="btn small" style={{ justifySelf: 'start' }} disabled={busy}
          onClick={() => void run(() => api.modules.call('pricing', 'PUT', '/usual', { productId, quantity: q, unit, price: p, basedOn: `${q} ${packUnitName(unit)} for ${money(p, currency, 2)}` }), `Usual price is now ${priceText(check.unitPrice, currency)} ${check.per}`).then(() => setCheck(null))}>
          Make this the usual price
        </button>
      )}
    </div>
  );
}

function ProductPricePanel({ product }: { product: ProductDetail }) {
  const id = product.product.id;
  const { data: view } = useView(id);
  const currency = useCurrency();
  const { run } = useAction();
  const [sizing, setSizing] = useState<{ wanted?: string } | null>(null);
  if (product.category?.name === 'Renewals' || product.product.wish || !view) return null;

  const choose = (unit: string) => {
    const option = view.options.find((o) => o.unit === unit);
    if (option?.needsSize) setSizing({ wanted: unit });
    else void run(() => api.modules.call('pricing', 'PUT', '/display', { productId: id, showPer: unit }));
  };

  return (
    <div className="section">
      <div className="label">Price</div>
      <div className="card pad">
        {view.usual ? (
          <div className="stack" style={{ gap: 4 }}>
            <span className="small muted">Usual price</span>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <b className="mono" style={{ font: '800 26px/1.1 var(--f-mono)' }}>{priceText(view.usual.price, currency)}</b>
              <select className="input" style={{ width: 'auto' }} value={view.showPer} onChange={(e) => choose(e.target.value)} aria-label="Show the price per">
                {view.options.map((o) => <option key={o.unit} value={o.unit}>{o.per}{o.needsSize ? ' (needs its size)' : ''}</option>)}
              </select>
            </div>
            {view.basedOn && <span className="small muted">From {view.basedOn}</span>}
          </div>
        ) : (
          <p className="small muted">No usual price yet. Check a pack below, or add the price when you tick it off at the shop.</p>
        )}
        {view.itemUnit && !sizing && (
          <span className="small muted">
            {view.itemSize ? <>One {view.itemUnit} holds {view.itemSize.amount} {view.itemSize.unit} · </> : <>Size of one {view.itemUnit} not set · </>}
            <button type="button" className="link small" onClick={() => setSizing({})}>{view.itemSize ? 'Change' : 'Set it'}</button>
          </span>
        )}
        {sizing && <SizeEditor productId={id} view={view} wanted={sizing.wanted} onDone={() => setSizing(null)} />}
        <div className="label" style={{ margin: '6px 0 0' }}>Spotted a different pack?</div>
        <PackChecker productId={id} view={view} />
      </div>
    </div>
  );
}

function ShoppingPriceCheck({ list }: { list: ShoppingList }) {
  const items = list.groups.flatMap((g) => g.items);
  const [id, setId] = useState(items[0]?.summary.product.id ?? '');
  const { data: view } = useView(id);
  if (!items.length || !id) return null;
  return (
    <div className="card pad">
      <div className="label" style={{ margin: 0 }}>Spotted a different pack?</div>
      <select className="input" value={id} onChange={(e) => setId(e.target.value)} aria-label="Which item">
        {items.map((i) => <option key={i.summary.product.id} value={i.summary.product.id}>{i.summary.product.name}</option>)}
      </select>
      {view && <p className="small muted" style={{ marginTop: -4 }}>{view.usual ? <>Usually <b className="mono" style={{ color: 'var(--ink)' }}>{view.usual.per}</b>.</> : 'No usual price yet.'}</p>}
      {view && <PackChecker key={id} productId={id} view={view} />}
    </div>
  );
}

export default defineWebModule({
  id: 'pricing',
  productPanels: [ProductPricePanel],
  shoppingPanels: [ShoppingPriceCheck],
});
