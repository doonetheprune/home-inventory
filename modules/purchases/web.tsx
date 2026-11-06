/**
 * Purchase history UI: what an item was bought for, on its page (with the
 * receipt's photo or the order), and a Purchases page with what was spent.
 */
import { useRef, useState } from 'react';
import {
  api, defineWebModule, Empty, Header, Icon, Link, Loading, money, qty, Seg, Sheet, shortDate, useAction, useQuery, useShops,
  type ProductDetail,
} from '@larder/web-sdk';

interface Evidence { receiptFileId: string | null; source: string | null; reference: string | null; orderedOn: string | null; boughtOn: string | null; note: string | null }
interface Purchase { id: string; productId: string; name: string; quantity: number; unit: string; price: number | null; currency: string; shopId: string | null; shop: string | null; how: 'shop' | 'receipt' | 'order'; on: string; at: string; evidence: Evidence }
interface Total { total: number; count: number }
interface Report { from: string | null; to: string | null; currency: string; total: number; count: number; unpriced: number; byShop: Array<Total & { shop: string }>; byItem: Array<Total & { productId: string; name: string; quantity: number; unit: string }>; byMonth: Array<Total & { month: string }> }

const call = <T,>(method: string, path: string, body?: unknown) => api.modules.call<T>('purchases', method, path, body);

/** "Receipt photo", "From a receipt", "Order TESCO-1, ordered 28 Oct". */
function evidenceText(p: Purchase): string | null {
  if (p.how === 'order') return [`Order${p.evidence.reference ? ` ${p.evidence.reference}` : ''}`, p.evidence.orderedOn ? `ordered ${shortDate(p.evidence.orderedOn)}` : null].filter(Boolean).join(', ');
  if (p.how === 'receipt' && !p.evidence.receiptFileId) return 'From a receipt';
  return null;
}

function PurchaseRow({ p, withName, onOpen }: { p: Purchase; withName?: boolean; onOpen: () => void }) {
  const proof = evidenceText(p);
  const where = p.shop ?? (p.how === 'order' ? p.evidence.source : null);
  return (
    <div className="item" style={{ cursor: 'pointer' }} role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <span className="tile"><Icon name={p.how === 'order' ? 'truck' : p.how === 'receipt' ? 'receipt' : 'cart'} /></span>
      <span className="item-main">
        <span className="item-name">{withName ? `${p.name} · ` : ''}{qty(p.quantity, p.unit)}{where ? ` at ${where}` : ''}</span>
        <span className="item-meta">{shortDate(p.on)}{proof ? ` · ${proof}` : ''}{p.evidence.note ? ` · ${p.evidence.note}` : ''}</span>
      </span>
      {p.evidence.receiptFileId && (
        <a href={api.files.url(p.evidence.receiptFileId)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label="The receipt's photo" className="tile" style={{ overflow: 'hidden' }}>
          <img src={api.files.url(p.evidence.receiptFileId)} alt="" loading="lazy" />
        </a>
      )}
      <span className="qty">{p.price === null ? <span className="muted small">No price</span> : money(p.price, p.currency, 2)}</span>
    </div>
  );
}

/** Correct a purchase: its price, shop or day; add the receipt's photo; or remove it. */
function EditSheet({ p, onClose }: { p: Purchase; onClose: () => void }) {
  const shops = useShops();
  const { run, busy } = useAction();
  const [price, setPrice] = useState(p.price === null ? '' : String(p.price));
  const [shopId, setShopId] = useState(p.shopId ?? '');
  const [on, setOn] = useState(p.on);
  const photo = useRef<HTMLInputElement>(null);
  const save = () => run(() => call('PATCH', `/${p.id}`, { price: price.trim() === '' ? null : Number(price), shopId: shopId || null, on }), 'Purchase saved').then((r) => r && onClose());
  const addPhoto = (file: File) => run(async () => {
    const { id } = await api.files.upload(file);
    return call('PATCH', `/${p.id}`, { evidence: { receiptFileId: id } });
  }, 'Receipt photo kept with the purchase');
  return (
    <Sheet title={`${p.name}, ${shortDate(p.on)}`} onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>{qty(p.quantity, p.unit)}{evidenceText(p) ? ` · ${evidenceText(p)}` : ''}. Changing this doesn't change stock.</p>
      <label className="field"><span>Price paid</span><input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Not known" /></label>
      <label className="field"><span>Shop</span>
        <select className="input" value={shopId} onChange={(e) => setShopId(e.target.value)}><option value="">No shop</option>{shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </label>
      <label className="field"><span>Bought on</span><input className="input" type="date" value={on} onChange={(e) => setOn(e.target.value)} /></label>
      <input ref={photo} type="file" accept="image/*" capture="environment" hidden data-testid="purchase-receipt" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void addPhoto(f); }} />
      <div className="btnrow">
        <button type="button" className="btn primary" disabled={busy || (price.trim() !== '' && !(Number(price) >= 0))} onClick={() => void save()}>Save</button>
        <button type="button" className="btn" disabled={busy} onClick={() => photo.current?.click()}><Icon name="camera" size="sm" />{p.evidence.receiptFileId ? 'Replace receipt photo' : 'Add receipt photo'}</button>
        <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => call('DELETE', `/${p.id}`), 'Removed from the history').then((r) => r && onClose())}><Icon name="trash" size="sm" />Remove</button>
      </div>
    </Sheet>
  );
}

function ItemPurchases({ product }: { product: ProductDetail }) {
  const id = product.product.id;
  const { data } = useQuery({ queryKey: ['purchases', 'item', id], queryFn: () => call<Purchase[]>('GET', `/item/${encodeURIComponent(id)}`) });
  const [open, setOpen] = useState<Purchase | null>(null);
  if (product.product.wish || product.category?.name === 'Renewals' || !data) return null;
  return (
    <div className="section">
      <div className="label">Bought {data.length > 0 && <Link to="/m/purchases/">All purchases</Link>}</div>
      {data.length === 0 ? (
        <p className="muted small">Nothing yet. Tick it off a shopping list, add it from a receipt, or add it with a price, and it's kept here.</p>
      ) : (
        <div className="list">{data.slice(0, 5).map((p) => <PurchaseRow key={p.id} p={p} onOpen={() => setOpen(p)} />)}</div>
      )}
      {open && <EditSheet p={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

type Period = 'month' | 'last' | 'year' | 'all';
function range(period: Period, today = new Date()): { from?: string; to?: string } {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const y = today.getFullYear();
  const m = today.getMonth();
  if (period === 'month') return { from: iso(new Date(y, m, 1)) };
  if (period === 'last') return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
  if (period === 'year') return { from: iso(new Date(y, 0, 1)) };
  return {};
}

function PurchasesPage() {
  const [period, setPeriod] = useState<Period>('month');
  const [open, setOpen] = useState<Purchase | null>(null);
  const r = range(period);
  const q = new URLSearchParams(Object.entries(r).filter(([, v]) => !!v) as Array<[string, string]>).toString();
  const report = useQuery({ queryKey: ['purchases', 'report', q], queryFn: () => call<Report>('GET', `/report${q ? `?${q}` : ''}`) });
  const list = useQuery({ queryKey: ['purchases', 'list', q], queryFn: () => call<Purchase[]>('GET', `/list${q ? `?${q}` : ''}`) });
  const rep = report.data;
  return (
    <>
      <Header title="Purchases" back="/" />
      <div className="content" style={{ maxWidth: 900 }}>
        <Seg label="When" value={period} onChange={setPeriod} options={[['month', 'This month'], ['last', 'Last month'], ['year', 'This year'], ['all', 'All']]} />
        {!rep || !list.data ? <Loading /> : rep.count === 0 ? (
          <Empty title="No purchases then">Tick things off a shopping list, add a receipt, or add stock with a price, and each purchase is kept here with its receipt or order.</Empty>
        ) : (
          <>
            <div className="card pad">
              <div className="big-qty"><b>{money(rep.total, rep.currency, 2)}</b><span className="muted">on {rep.count} purchase{rep.count === 1 ? '' : 's'}</span></div>
              {rep.unpriced > 0 && <p className="small muted" style={{ margin: 0 }}>{rep.unpriced} had no price, so {rep.unpriced === 1 ? "isn't" : "aren't"} counted. Tap one to add it.</p>}
            </div>
            <div className="cols-2">
              <div className="section">
                <div className="label">By shop</div>
                <div className="list">{rep.byShop.map((s) => <div className="item" key={s.shop}><span className="item-main"><span className="item-name">{s.shop}</span><span className="item-meta">{s.count} purchase{s.count === 1 ? '' : 's'}</span></span><span className="qty">{money(s.total, rep.currency, 2)}</span></div>)}</div>
              </div>
              <div className="section">
                <div className="label">Most spent on</div>
                <div className="list">{rep.byItem.slice(0, 8).map((i) => <Link className="item" key={i.productId} to={`/products/${i.productId}`}><span className="item-main"><span className="item-name">{i.name}</span><span className="item-meta">{qty(i.quantity, i.unit)} · {i.count} time{i.count === 1 ? '' : 's'}</span></span><span className="qty">{money(i.total, rep.currency, 2)}</span></Link>)}</div>
              </div>
            </div>
            {rep.byMonth.length > 1 && (
              <div className="section">
                <div className="label">By month</div>
                <div className="list">{rep.byMonth.map((m) => <div className="item" key={m.month}><span className="item-main"><span className="item-name">{new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span></span><span className="qty">{money(m.total, rep.currency, 2)}</span></div>)}</div>
              </div>
            )}
            <div className="section">
              <div className="label">Every purchase</div>
              <div className="list">{list.data.slice(0, 200).map((p) => <PurchaseRow key={p.id} p={p} withName onOpen={() => setOpen(p)} />)}</div>
            </div>
          </>
        )}
        {open && <EditSheet p={open} onClose={() => setOpen(null)} />}
      </div>
    </>
  );
}

export default defineWebModule({
  id: 'purchases',
  productPanels: [ItemPurchases],
  pages: [{ path: '/', title: 'Purchases', icon: 'receipt', subtitle: 'What was bought, and what it cost', component: PurchasesPage }],
});
