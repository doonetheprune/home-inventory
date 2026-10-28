import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Dashboard } from '@larder/core';
import { api } from '../api';
import { Icon } from '../icons';
import { dayDate, expiryText, greeting, num } from '../format';
import { Empty, ErrorBox, Loading, PlaceText, ProductRow, useAction } from '../ui';

function headline(d: Dashboard): string {
  const parts: string[] = [];
  if (d.counts.expiringSoon) parts.push(`${d.counts.expiringSoon} thing${d.counts.expiringSoon === 1 ? '' : 's'} to use soon`);
  const best = d.shopping.shops.find((s) => s.shop.id === d.shopping.suggestedShopId);
  if (best) parts.push(`${best.shop.name}'s the shop to hit`);
  if (!parts.length) return `${greeting()}. Everything's in hand.`;
  return `${greeting()}. ${parts.join(', and ')}.`;
}

export function Home() {
  const { data: d, error, isLoading } = useQuery({ queryKey: ['home'], queryFn: api.home });
  const { run } = useAction();
  if (isLoading) return <Loading />;
  if (error || !d) return <div className="content"><ErrorBox error={error} /></div>;

  const best = d.shopping.shops.find((s) => s.shop.id === d.shopping.suggestedShopId);
  const others = d.shopping.shops.filter((s) => s.shop.id !== best?.shop.id && s.count > 0);
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
        {best ? (
          <Link className="go" to={`/shop/${best.shop.id}`}>
            <span className="tile lg"><Icon name="cart" size="lg" /></span>
            <span className="item-main"><h3>{best.shop.name} · {best.count} item{best.count === 1 ? '' : 's'}</h3><span className="muted small">Most of your list can come from {best.shop.name}</span></span>
            <Icon name="chev" className="muted" />
          </Link>
        ) : d.shopping.shops.length ? (
          <p className="muted small">Nothing's running low. Enjoy it.</p>
        ) : (
          <p className="muted small">Add the shops you use and Larder will tell you which one to go to. <Link to="/shops" style={{ color: 'var(--accent)', fontWeight: 600 }}>Add shops</Link></p>
        )}
        {others.length > 0 && (
          <div className="chips wrap">
            {others.map((s) => <Link key={s.shop.id} className="chip" to={`/shop/${s.shop.id}`}>{s.shop.name} <span className="n">{s.count}</span></Link>)}
          </div>
        )}
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
        {d.expiringSoon.some((s) => s.category?.name === 'Food') && (
          <div className="card hint"><Icon name="sparkle" size="sm" /><span>Ask Claude <i>“what can I cook with the {d.expiringSoon.filter((s) => s.category?.name === 'Food').slice(0, 2).map((s) => s.product.name.toLowerCase()).join(' and ')}?”</i> It sees your stock (from Phase 3).</span></div>
        )}
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
        <div className="label">Out of place <Link to="/stock?status=out_of_place">All</Link></div>
        {d.outOfPlace.length ? (
          <div className="list">
            {d.outOfPlace.map((s) => (
              <ProductRow key={s.product.id} s={s} to={`/products/${s.product.id}`}
                meta={<>Now in {s.nowIn[0]?.name} · usually <PlaceText p={s.places[0]} /></>}
                side={<button className="btn small" type="button" onClick={(e) => { e.preventDefault(); void run(() => api.stock.returnHome({ productId: s.product.id }), `${s.product.name} is back in its usual place`); }}>Put back</button>} />
            ))}
          </div>
        ) : <p className="muted small">Everything's where it lives.</p>}
      </div>

      {d.low.length > 0 && (
        <div className="section" style={{ gridColumn: '1 / -1' }}>
          <div className="label">Running low <Link to="/stock?status=low">All</Link></div>
          <div className="list">{d.low.map((s) => <ProductRow key={s.product.id} s={s} to={`/products/${s.product.id}`} />)}</div>
        </div>
      )}
    </div>
  );
}
