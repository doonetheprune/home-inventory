import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Dashboard, ProductSummary } from '@larder/core';
import { api } from '../api';
import { Icon } from '../icons';
import { dayDate, expiryText, greeting, num, qty } from '../format';
import { Empty, ErrorBox, Loading, PlaceSelect, PlaceText, ProductRow, Sheet, Stepper, useAction, usePlaces } from '../ui';
import { ProductPicker } from '../components/ProductPicker';

function headline(d: Dashboard): string {
  const parts: string[] = [];
  if (d.counts.expiringSoon) parts.push(`${d.counts.expiringSoon} thing${d.counts.expiringSoon === 1 ? '' : 's'} to use soon`);
  if (d.counts.low) parts.push(`${d.counts.low} running low`);
  if (!parts.length) return `${greeting()}. Everything's in hand.`;
  return `${greeting()}. ${parts.join(', and ')}.`;
}

/** Something has been taken somewhere else for now (the drill's in the kitchen): pick it, then where it is. */
function MovedSheet({ onClose }: { onClose: () => void }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [item, setItem] = useState<ProductSummary | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [n, setN] = useState(1);
  return (
    <Sheet title="Something's moved" onClose={onClose}>
      {!item ? (
        <>
          <p className="small muted">Pick what's been moved. It stays listed under its usual place and shows as out of place until it's put back.</p>
          <ProductPicker only={(s) => s.inStock > 0} placeholder="What's moved? e.g. drill" onPick={(s) => { setItem(s); setN(s.inStock); }} />
        </>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span><b>{item.product.name}</b><br /><span className="small muted">Usually {item.places[0]?.path ?? 'no place set'}</span></span>
            <button type="button" className="link small" onClick={() => setItem(null)}>Change</button>
          </div>
          <label className="field"><span>Where it is now</span><PlaceSelect value={to} onChange={setTo} places={places} allowNone={false} label="Where it is now" /></label>
          {item.inStock > 1 && <div className="row" style={{ justifyContent: 'space-between' }}><b>How many</b><Stepper value={n} onChange={setN} min={0.1} max={item.inStock} label="quantity" /></div>}
          <button type="button" className="btn primary block" disabled={busy || !to}
            onClick={() => void run(() => api.stock.move({ productId: item.product.id, toPlaceId: to!, quantity: n, mode: 'temporary' }), `${item.product.name}: ${qty(n, item.product.unit)} now in ${places.find((p) => p.id === to)?.name ?? 'there'}`).then((r) => r && onClose())}>
            It's there for now
          </button>
        </>
      )}
    </Sheet>
  );
}

export function Home() {
  const { data: d, error, isLoading } = useQuery({ queryKey: ['home'], queryFn: api.home });
  const { run } = useAction();
  const [moving, setMoving] = useState(false);
  if (isLoading) return <Loading />;
  if (error || !d) return <div className="content"><ErrorBox error={error} /></div>;

  const shopping = d.shopping.shops.some((s) => s.count > 0);
  const empty = d.counts.products === 0 && d.counts.wish === 0;

  return (
    <div className="content home-grid">
      <div className="hello"><h2>{headline(d)}</h2></div>

      <div className="actions">
        <Link className="act big" to="/scan"><span className="bars" aria-hidden="true" /><Icon name="scan" size="lg" /><div><b>Scan</b><br /><span>Add, use or move anything with a barcode, QR code or NFC tag</span></div></Link>
        <Link className="act" to="/add"><Icon name="plus" /><div><b>Add by name</b><br /><span>Tools, fuel, anything without a barcode</span></div></Link>
        <Link className="act" to="/scan?mode=putaway"><Icon name="inbox" /><div><b>Put away</b><br /><span>Scan the item, then the shelf</span></div></Link>
      </div>

      <div className="card shopcard">
        <div className="label" style={{ margin: 0 }}>Going shopping?</div>
        {d.shopping.shops.length ? (
          <div className="shop-tiles">
            {d.shopping.shops.map((s) => (
              <Link key={s.shop.id} className="shop-tile" to={`/shop/${s.shop.id}`} aria-label={`${s.shop.name}: ${s.count} to buy`}>
                <b>{s.count}</b>
                <span>{s.shop.name}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted small">Add the shops you use and Larder will show what to buy at each. <Link to="/shops" style={{ color: 'var(--accent)', fontWeight: 600 }}>Add shops</Link></p>
        )}
        {d.shopping.shops.length > 0 && !shopping && <p className="muted small">Nothing's running low. Enjoy it.</p>}
      </div>

      <div className="stats">
        <Link className="stat soon" to="/stock?status=expiring"><b>{d.counts.expiringSoon}</b><span>Use soon</span></Link>
        <Link className="stat low" to="/stock?status=low"><b>{d.counts.low}</b><span>Running low</span></Link>
        <Link className="stat away" to="/stock?status=out_of_place"><b>{d.counts.outOfPlace}</b><span>Out of place</span></Link>
      </div>

      {empty && (
        <div style={{ gridColumn: '1 / -1' }}>
          <Empty title="Nothing in Larder yet">
            <span className="muted small">Scan something, add it by name, or set up your places first. Want to look around? Load the example household in Settings.</span>
            <div className="btnrow"><Link className="btn primary small" to="/add">Add your first item</Link><Link className="btn small" to="/places">Set up places</Link><Link className="btn small" to="/settings">Settings</Link></div>
          </Empty>
        </div>
      )}

      <div className="section h-soon">
        <div className="label">Use soon <Link to="/stock?status=expiring">All</Link></div>
        {d.expiringSoon.length ? (
          <div className="list">
            {d.expiringSoon.map((s) => (
              <ProductRow key={s.product.id} s={s} to={`/products/${s.product.id}`}
                side={<span className={`pill ${s.status.expired ? 'p-low' : 'p-soon'}`}>{s.nextExpiry ? expiryText(s.nextExpiry, s.daysToExpiry, s.category?.name === 'Renewals') : ''}</span>} />
            ))}
          </div>
        ) : <p className="muted small">Nothing's about to go off.</p>}
      </div>

      <div className="section h-coming">
        <div className="label">On the way</div>
        {d.deliveries.length ? (
          <div className="list">
            {d.deliveries.map((del) => (
              <div className="item" key={del.source}>
                <span className="tile"><Icon name="truck" /></span>
                <span className="item-main"><span className="item-name">{del.source} · {del.itemCount} item{del.itemCount === 1 ? '' : 's'}</span><span className="item-meta">{del.eta ? dayDate(del.eta) : 'No date given'} · {num(del.quantity)} in total</span></span>
                <button className="btn small" type="button" onClick={() => run(() => api.stock.arrive({ source: del.source }), (r) => `${r.arrived} item${r.arrived === 1 ? '' : 's'} from ${del.source} moved into stock`)}>Arrived</button>
              </div>
            ))}
          </div>
        ) : <p className="muted small">No deliveries expected.</p>}
      </div>

      <div className="section h-away">
        <div className="label">Out of place <span className="row" style={{ gap: 14 }}><button type="button" className="link" onClick={() => setMoving(true)}>Something's moved</button><Link to="/stock?status=out_of_place">All</Link></span></div>
        {d.outOfPlace.length ? (
          <div className="list">
            {d.outOfPlace.map((s) => (
              <ProductRow key={s.product.id} s={s} to={`/products/${s.product.id}`}
                meta={<>Now in {s.nowIn[0]?.name} · usually <PlaceText p={s.places[0]} /></>}
                side={<button className="btn small" type="button" onClick={(e) => { e.preventDefault(); void run(() => api.stock.returnHome({ productId: s.product.id }), `${s.product.name} is back in its usual place`); }}>Put back</button>} />
            ))}
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <p className="muted small">Everything's where it lives.</p>
            <button type="button" className="btn small" style={{ justifySelf: 'start' }} onClick={() => setMoving(true)}><Icon name="move" size="sm" />Something's moved</button>
          </div>
        )}
      </div>

      {d.low.length > 0 && (
        <div className="section" style={{ gridColumn: '1 / -1' }}>
          <div className="label">Running low <Link to="/stock?status=low">All</Link></div>
          <div className="list">{d.low.map((s) => <ProductRow key={s.product.id} s={s} to={`/products/${s.product.id}`} />)}</div>
        </div>
      )}
      {moving && <MovedSheet onClose={() => setMoving(false)} />}
    </div>
  );
}
