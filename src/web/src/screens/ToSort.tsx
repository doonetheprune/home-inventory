import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { PlaceToSort } from '@larder/core';
import { api } from '../api';
import { qty } from '../format';
import { Empty, ErrorBox, Header, Loading, PlaceSelect, ProductTile, Sheet, useAction, usePlaces } from '../ui';

type Loose = PlaceToSort['items'][number];

/** Stock added without a place (scanned in a hurry, say), waiting to be put where it lives. */
export function ToSort() {
  const { data, error, isLoading } = useQuery({ queryKey: ['places', 'to-sort'], queryFn: api.places.toSort });
  const [putting, setPutting] = useState<Loose | null>(null);
  return (
    <>
      <Header title="To sort" back="/places" />
      <div className="content">
        <div className="section">
          <p className="small muted" style={{ margin: 0 }}>Added without a place. Put each where it lives, or open a place and use <b>Add stock here</b>.</p>
          {isLoading && <Loading />}
          {error ? <ErrorBox error={error} /> : null}
          {data && !data.items.length && <Empty title="Nothing to sort"><span className="muted small">Everything has a place.</span></Empty>}
          {data && data.items.length > 0 && (
            <div className="list">
              {data.items.map((i) => (
                <div className="item" key={i.summary.product.id}>
                  <Link className="row grow" style={{ gap: 12 }} to={`/products/${i.summary.product.id}`}>
                    <ProductTile s={i.summary} />
                    <span className="item-main">
                      <span className="item-name">{i.summary.product.name}</span>
                      <span className="item-meta">{qty(i.quantity, i.summary.product.unit)}{i.summary.places[0] ? ` · the rest in ${i.summary.places[0].path}` : ''}</span>
                    </span>
                  </Link>
                  <button type="button" className="btn small" onClick={() => setPutting(i)}>Put away</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {putting && <PutAwaySheet item={putting} onClose={() => setPutting(null)} />}
    </>
  );
}

function PutAwaySheet({ item, onClose }: { item: Loose; onClose: () => void }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const s = item.summary;
  // Where the rest of it lives is the likely place.
  const [to, setTo] = useState<string | null>(s.product.defaultPlaceId ?? s.places[0]?.id ?? null);
  const save = async () => {
    if (!to) return;
    const place = places.find((p) => p.id === to);
    const done = await run(() => api.stock.move({ productId: s.product.id, toPlaceId: to, fromPlaceId: null, mode: 'permanent' }), `${s.product.name} put away in ${place?.code ?? place?.name ?? 'its place'}`);
    if (done) onClose();
  };
  return (
    <Sheet title={`Put away ${s.product.name}`} onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>{qty(item.quantity, s.product.unit)} with no place.</p>
      <label className="field"><span>Where it lives</span><PlaceSelect value={to} onChange={setTo} places={places} allowNone={false} label="Where it lives" /></label>
      <button type="button" className="btn primary block" disabled={!to || busy} onClick={() => void save()}>Put away</button>
    </Sheet>
  );
}
