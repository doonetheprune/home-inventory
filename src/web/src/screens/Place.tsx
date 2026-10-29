import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../icons';
import { qty } from '../format';
import { ErrorBox, Header, Loading, ProductRow, useAction, useIsDesktop } from '../ui';
import { PlaceSheet, PlaceTree } from './Places';
import { NfcTags } from '../components/NfcTags';

export function PlacePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const desktop = useIsDesktop();
  const { data: c, error, isLoading } = useQuery({ queryKey: ['place', id], queryFn: () => api.places.contents(id) });
  const tree = useQuery({ queryKey: ['places', 'tree'], queryFn: api.places.tree, enabled: desktop });
  const [sheet, setSheet] = useState<null | 'edit' | 'child'>(null);
  const [confirm, setConfirm] = useState(false);
  const { run, busy } = useAction();
  const photo = useRef<HTMLInputElement>(null);

  if (isLoading) return <Loading />;
  if (error || !c) return <><Header title="Place" back="/places" /><div className="content"><ErrorBox error={error} /></div></>;
  const empty = !c.items.length && !c.visitors.length;

  return (
    <>
      <Header title={c.place.name} back={c.breadcrumbs.length ? `/places/${c.breadcrumbs[c.breadcrumbs.length - 1]!.id}` : '/places'}>
        <button type="button" className="iconbtn" aria-label="Edit place" onClick={() => setSheet('edit')}><Icon name="edit" /></button>
      </Header>
      <div className="content" style={desktop ? { gridTemplateColumns: '320px minmax(0, 1fr)', alignItems: 'start' } : undefined}>
        {desktop && tree.data && <PlaceTree nodes={tree.data} current={id} />}
        <div className="section" style={{ gap: 22 }}>
          <div className="row" style={{ gap: 14 }}>
            <div className="stack grow" style={{ gap: 4 }}>
              {c.place.code ? <span className="bigcode">{c.place.code}</span> : <h2 style={{ fontSize: 26 }}>{c.place.name}</h2>}
              <span className="muted small">{c.breadcrumbs.map((b) => <span key={b.id}><Link to={`/places/${b.id}`}>{b.name}</Link> › </span>)}{c.place.name}</span>
            </div>
          </div>
          <button type="button" className="photo" style={{ border: 0, padding: 0 }} onClick={() => photo.current?.click()} aria-label="Add a photo of this place">
            {c.place.photoFileId ? <img src={api.files.url(c.place.photoFileId)} alt="" /> : <span className="stack" style={{ justifyItems: 'center', gap: 6 }}><Icon name="camera" size="lg" /><span className="small">Add a photo, so others can find it</span></span>}
          </button>
          <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void run(async () => api.places.update(id, { photoFileId: (await api.files.upload(f)).id }), 'Photo added');
          }} />
          {c.place.notes && <p className="small muted">{c.place.notes}</p>}
          <div className="btnrow">
            <Link className="btn" to="/scan?mode=putaway"><Icon name="inbox" />Put away here</Link>
            <button type="button" className="btn" onClick={() => setSheet('child')}><Icon name="plus" />Add a spot inside</button>
          </div>

          {c.children.length > 0 && (
            <div className="section">
              <div className="label">Inside {c.place.name} · {c.children.length}</div>
              <div className="list">
                {c.children.map((ch) => (
                  <Link key={ch.id} className="item" to={`/places/${ch.id}`}>
                    <span className="tile"><Icon name="box" /></span>
                    <span className="item-main"><span className="item-name">{ch.name}</span><span className="item-meta">{ch.itemCount} item{ch.itemCount === 1 ? '' : 's'}</span></span>
                    {ch.code && <span className="code">{ch.code}</span>}
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div className="section">
            <div className="label">Lives here · {c.items.length}</div>
            {c.items.length ? (
              <div className="list">
                {c.items.map((i) => (
                  <ProductRow key={i.summary.product.id} s={i.summary} to={`/products/${i.summary.product.id}`}
                    meta={i.outOfPlace ? <span style={{ color: 'var(--away)' }}>Now in {i.nowIn?.path}</span> : i.summary.category?.name}
                    side={<><span className="qty">{qty(i.quantity, i.summary.product.unit)}</span>{i.outOfPlace ? <span className="pill p-away">Moved</span> : null}</>} />
                ))}
              </div>
            ) : <p className="muted small">Nothing lives here yet.</p>}
          </div>

          {c.visitors.length > 0 && (
            <div className="section">
              <div className="label">Here for now · {c.visitors.length}</div>
              <div className="list">
                {c.visitors.map((v) => (
                  <ProductRow key={v.summary.product.id} s={v.summary} to={`/products/${v.summary.product.id}`} meta={<>Usually {v.usualPlace?.path ?? 'nowhere set'}</>}
                    side={<button type="button" className="btn small" disabled={busy} onClick={(e) => { e.preventDefault(); void run(() => api.stock.returnHome({ productId: v.summary.product.id }), 'Put back'); }}>Put back</button>} />
                ))}
              </div>
            </div>
          )}

          <NfcTags tags={c.place.nfcTags} placeId={id} />

          <div className="card pad">
            <b>Remove {c.place.name}</b>
            <p className="small muted">{empty ? 'Anything inside it moves up a level.' : 'Move everything out of it first.'}</p>
            {confirm ? (
              <div className="btnrow"><button type="button" className="btn" onClick={() => setConfirm(false)}>Keep it</button><button type="button" className="btn danger" disabled={busy} onClick={() => run(() => api.places.remove(id), 'Removed').then((r) => r !== undefined && navigate('/places', { replace: true }))}>Yes, remove it</button></div>
            ) : (
              <button type="button" className="btn danger" disabled={!empty} onClick={() => setConfirm(true)}><Icon name="trash" size="sm" />Remove</button>
            )}
          </div>
        </div>
      </div>
      {sheet === 'edit' && <PlaceSheet onClose={() => setSheet(null)} edit={{ id, name: c.place.name, code: c.place.code, parentId: c.place.parentId, notes: c.place.notes }} />}
      {sheet === 'child' && <PlaceSheet onClose={() => setSheet(null)} parentId={id} />}
    </>
  );
}
