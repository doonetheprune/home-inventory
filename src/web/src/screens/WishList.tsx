import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ProductSummary } from '@larder/core';
import { api } from '../api';
import { Icon } from '../icons';
import { Empty, Header, Loading, PlaceSelect, ProductTile, Sheet, useAction, useIsDesktop, usePlaces } from '../ui';

export function WishList() {
  const desktop = useIsDesktop();
  const { data, isLoading } = useQuery({ queryKey: ['products', 'wish'], queryFn: () => api.products.list({ status: 'wish' }) });
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const [bought, setBought] = useState<ProductSummary | null>(null);

  return (
    <>
      <Header title="Wish list" back="/more" />
      <div className="content">
        <p className="small muted">Things you want but don't have. Buy one and it moves into stock.</p>
        <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => api.products.create({ name: name.trim(), wish: true }), `${name.trim()} is on the wish list`).then(() => setName('')); }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Something you'd like" aria-label="Wish list item" />
          <button className="btn" disabled={!name.trim() || busy}><Icon name="heart" size="sm" />Add</button>
        </form>
        {isLoading && <Loading />}
        {data && !data.length && <Empty title="Nothing on the wish list"><span className="muted small">Add things you'd like to have, like a power bank for power cuts.</span></Empty>}
        <div className={desktop ? 'cards-2' : 'list'}>
          {(data ?? []).map((s) => (
            <div className={desktop ? 'card item' : 'item'} key={s.product.id}>
              <ProductTile s={s} />
              <Link className="item-main" to={`/products/${s.product.id}`}><span className="item-name">{s.product.name}</span><span className="item-meta">{[s.category?.name, s.product.notes].filter(Boolean).join(' · ') || 'Wish list'}</span></Link>
              <button type="button" className="btn small" onClick={() => setBought(s)}>Bought it</button>
            </div>
          ))}
        </div>
      </div>
      {bought && <BoughtSheet s={bought} onClose={() => setBought(null)} />}
    </>
  );
}

function BoughtSheet({ s, onClose }: { s: ProductSummary; onClose: () => void }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [placeId, setPlaceId] = useState<string | null>(s.product.defaultPlaceId);
  return (
    <Sheet title={`Where did you put the ${s.product.name.toLowerCase()}?`} onClose={onClose}>
      <PlaceSelect value={placeId} onChange={setPlaceId} places={places} />
      <button type="button" className="btn primary block" disabled={busy} onClick={() => run(() => api.stock.add({ productId: s.product.id, quantity: 1, placeId }), `${s.product.name} moved into stock`).then((r) => r && onClose())}>Move into stock</button>
    </Sheet>
  );
}
