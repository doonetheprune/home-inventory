import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Place, PlaceContents, ProductSummary } from '@larder/core';
import { api } from '../api';
import { Icon } from '../icons';
import { qty } from '../format';
import { nextPlaceCode } from '../placeCodes';
import { ErrorBox, Header, Loading, ProductRow, ProductTile, Sheet, Stepper, useAction, useIsDesktop, usePlaces } from '../ui';
import { PlaceSheet, PlaceTree } from './Places';
import { NfcTags } from '../components/NfcTags';

type Spot = PlaceContents['children'][number];
type Here = PlaceContents['items'][number];

/**
 * One place: the spots inside it (added and renamed right here, one after
 * another), what lives in it with a count to change, and ways to add stock.
 */
export function PlacePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  /** Just added: ready to type its first spot. */
  const justAdded = (location.state as { added?: boolean } | null)?.added === true;
  const desktop = useIsDesktop();
  const { data: c, error, isLoading } = useQuery({ queryKey: ['place', id], queryFn: () => api.places.contents(id) });
  const tree = useQuery({ queryKey: ['places', 'tree'], queryFn: api.places.tree, enabled: desktop });
  const [sheet, setSheet] = useState<null | 'edit' | 'stock'>(null);
  const [confirm, setConfirm] = useState(false);
  const { run, busy } = useAction();
  const photo = useRef<HTMLInputElement>(null);

  if (isLoading) return <Loading />;
  if (error || !c) return <><Header title="Place" back="/places" /><div className="content"><ErrorBox error={error} /></div></>;
  // Items kept here with none here right now don't stop it being removed.
  const empty = !c.items.some((i) => i.quantity > 0) && !c.visitors.length;
  // A room, or anything with spots (or just added): the spots come first. A shelf or box: what's on it does.
  const spotsFirst = !c.breadcrumbs.length || c.children.length > 0 || justAdded;
  const spots = <Spots key={id} place={c.place} spots={c.children} focus={justAdded} />;
  const photoBlock = (
    <>
      <button type="button" className={`photo ${c.place.photoFileId ? '' : 'photo-add'}`} style={{ border: 0, padding: 0 }} onClick={() => photo.current?.click()} aria-label="Add a photo of this place">
        {c.place.photoFileId ? <img src={api.files.url(c.place.photoFileId)} alt="" /> : <span className="row" style={{ gap: 8, justifyContent: 'center' }}><Icon name="camera" /><span className="small">Add a photo, so others can find it</span></span>}
      </button>
      <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void run(async () => api.places.update(id, { photoFileId: (await api.files.upload(f)).id }), 'Photo added');
      }} />
    </>
  );

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
          {c.place.photoFileId && photoBlock}
          {c.place.notes && <p className="small muted">{c.place.notes}</p>}
          <div className="btnrow">
            <button type="button" className="btn primary" onClick={() => setSheet('stock')}><Icon name="plus" />Add stock here</button>
            <Link className="btn" to={`/scan?mode=add&place=${id}`}><Icon name="scan" />Scan here</Link>
            <Link className="btn" to={`/scan?mode=putaway&place=${id}`}><Icon name="inbox" />Put away here</Link>
          </div>

          {spotsFirst && spots}

          <div className="section">
            <div className="label">Lives here · {c.items.length}</div>
            {c.items.length ? (
              <div className="list">
                {c.items.map((i) => <HereRow key={i.summary.product.id} i={i} placeId={id} />)}
              </div>
            ) : <p className="muted small">Nothing lives here yet. <button type="button" className="link small" onClick={() => setSheet('stock')}>Add stock here</button></p>}
          </div>

          {!spotsFirst && spots}

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

          {!c.place.photoFileId && photoBlock}

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
      {sheet === 'stock' && <AddStockSheet place={c.place} onClose={() => setSheet(null)} />}
    </>
  );
}

/**
 * The spots inside a place, with a row at the end to add the next: type a
 * name, press Enter, type the next. The code is offered from this place's
 * (G1, G2…) and can be changed. The pencil renames a spot or changes its code
 * without leaving the page.
 */
function Spots({ place, spots, focus }: { place: Place; spots: Spot[]; focus: boolean }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  /** What was typed; null while the offered code is used. */
  const [typedCode, setTypedCode] = useState<string | null>(null);
  /** Codes given in this visit, so the next one is offered before the lists catch up. */
  const [given, setGiven] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const offered = nextPlaceCode(place.code, [...places.map((p) => p.code), ...spots.map((s) => s.code), ...given]);
  const code = typedCode ?? offered ?? '';

  const add = async () => {
    const n = name.trim();
    const c = code.trim() || null;
    if (!n) return;
    const created = await run(() => api.places.create({ name: n, parentId: place.id, code: c }), `${n} added${c ? ` as ${c}` : ''}`);
    if (!created) return;
    if (created.code) setGiven((g) => [...g, created.code!]);
    setName('');
    setTypedCode(null);
    input.current?.focus();
  };

  return (
    <div className="section">
      <div className="label">Spots in {place.name}{spots.length ? ` · ${spots.length}` : ''}</div>
      <div className="list">
        {spots.map((sp) => (editing === sp.id ? <SpotEdit key={sp.id} spot={sp} onDone={() => setEditing(null)} /> : (
          <div className="item" key={sp.id}>
            <Link className="row grow" style={{ gap: 12 }} to={`/places/${sp.id}`}>
              <span className="tile"><Icon name="box" /></span>
              <span className="item-main"><span className="item-name">{sp.name}</span><span className="item-meta">{sp.itemCount} item{sp.itemCount === 1 ? '' : 's'}</span></span>
              {sp.code && <span className="code">{sp.code}</span>}
            </Link>
            <button type="button" className="iconbtn ghost" aria-label={`Edit ${sp.name}`} onClick={() => setEditing(sp.id)}><Icon name="edit" size="sm" /></button>
          </div>
        )))}
        <form className="item spot-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input ref={input} className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={spots.length ? 'Another spot' : 'A spot inside: Top shelf, Drawer 1…'} aria-label="New spot's name" autoFocus={focus} enterKeyHint="next" />
          <input className="input mono spot-code" value={code} onChange={(e) => setTypedCode(e.target.value.toUpperCase())} placeholder="Code" aria-label="New spot's code" maxLength={20} />
          <button className="btn primary" disabled={busy || !name.trim()}>Add</button>
        </form>
      </div>
      {!spots.length && (
        <p className="small muted" style={{ margin: 0 }}>
          Shelves, drawers, boxes: type one, press Enter, type the next.{' '}
          {place.code ? `Their codes follow ${place.code}.` : 'Give this place a code (the pencil, top right) and theirs will follow it.'}
        </p>
      )}
    </div>
  );
}

function SpotEdit({ spot, onDone }: { spot: Spot; onDone: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(spot.name);
  const [code, setCode] = useState(spot.code ?? '');
  const save = async () => {
    if (await run(() => api.places.update(spot.id, { name: name.trim(), code: code.trim() || null }), 'Saved')) onDone();
  };
  return (
    <form className="item spot-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void save(); }} onKeyDown={(e) => { if (e.key === 'Escape') onDone(); }}>
      <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} aria-label={`${spot.name}: name`} autoFocus />
      <input className="input mono spot-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Code" aria-label={`${spot.name}: code`} maxLength={20} />
      <button className="btn primary" disabled={busy || !name.trim()}>Save</button>
      <button type="button" className="iconbtn ghost" aria-label="Cancel" onClick={onDone}><Icon name="x" size="sm" /></button>
    </form>
  );
}

/**
 * Something that lives here, with − and + to change how many are here. At 0 it
 * stays (more may come), with a button to stop keeping it here.
 */
function HereRow({ i, placeId }: { i: Here; placeId: string }) {
  const { run, busy } = useAction();
  const s = i.summary;
  const p = s.product;
  const elsewhere = s.inStock - i.quantity > 0.0005;
  const forget = () => run(() => api.products.update(p.id, { keptInPlaceIds: (p.keptInPlaceIds ?? []).filter((x) => x !== placeId) }), `${p.name} isn't kept here now`);
  // Stock that's somewhere else for now, and rechargeables (− would mean "flat"), are changed on the item's page.
  const editable = !i.outOfPlace && !p.rechargeable;
  const change = (n: number) => {
    const d = Math.round((n - i.quantity) * 1000) / 1000;
    if (!d) return;
    void run(
      () => (d > 0 ? api.stock.add({ productId: p.id, quantity: d, placeId }) : api.stock.use({ productId: p.id, quantity: -d, placeId })),
      `${p.name}: ${qty(n, p.unit)} here now`,
    );
  };
  return (
    <div className="item">
      <Link className="row grow" style={{ gap: 12 }} to={`/products/${p.id}`}>
        <ProductTile s={s} />
        <span className="item-main">
          <span className="item-name">{p.name}</span>
          <span className="item-meta">{i.outOfPlace ? <span style={{ color: 'var(--away)' }}>Now in {i.nowIn?.path}</span> : [i.quantity ? `${qty(i.quantity, p.unit)} here` : 'None here now', elsewhere ? `${qty(s.inStock, p.unit)} in total` : null, s.category?.name].filter(Boolean).join(' · ')}</span>
        </span>
      </Link>
      {!i.quantity && <button type="button" className="iconbtn" aria-label={`Don't keep ${p.name} here`} title="Not kept here any more" disabled={busy} onClick={() => void forget()}><Icon name="x" size="sm" /></button>}
      {editable
        ? <Stepper small value={i.quantity} onChange={change} label={`${p.name} here`} />
        : <span className="item-side"><span className="qty">{qty(i.quantity, p.unit)}</span>{i.outOfPlace ? <span className="pill p-away">Moved</span> : null}</span>}
    </div>
  );
}

/**
 * Adding stock to a place, quickly: search first, then − and + on the item for
 * how many are here, and the tick. Several can be added without leaving. With
 * nothing typed, what's waiting in To sort is listed (one press puts it here).
 * Something new is scanned here, or added by name, with this place filled in.
 */
function AddStockSheet({ place, onClose }: { place: Place; onClose: () => void }) {
  const desktop = useIsDesktop();
  const { run, busy } = useAction();
  const all = useQuery({ queryKey: ['products', 'all', ''], queryFn: () => api.products.list({ status: 'all' }) }).data;
  const loose = useQuery({ queryKey: ['places', 'to-sort'], queryFn: api.places.toSort }).data?.items ?? [];
  const [q, setQ] = useState('');
  const label = place.code ?? place.name;
  const matches = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return (all ?? [])
      .filter((s) => !s.product.wish)
      .filter((s) => words.every((w) => [s.product.name, ...s.product.aliases].join(' ').toLowerCase().includes(w)))
      .slice(0, 8);
  }, [all, q]);

  const putHere = (s: ProductSummary) =>
    run(() => api.stock.move({ productId: s.product.id, toPlaceId: place.id, fromPlaceId: null, mode: 'permanent' }), `${s.product.name} put away in ${label}`);

  return (
    <Sheet title={`Add stock to ${place.name}`} onClose={onClose}>
      {/* On a phone the keyboard would cover the sheet, so it waits for a tap. */}
      <input className="input" type="search" autoFocus={desktop} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Which item?" aria-label="Which item?" />
      {q.trim() ? (
        <div className="list">
          {matches.map((s) => <QuickAddRow key={s.product.id} s={s} place={place} />)}
          {!matches.length && <div className="item"><span className="muted small">Nothing in Larder matches “{q.trim()}”.</span></div>}
        </div>
      ) : loose.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="label" style={{ margin: 0 }}>To sort · {loose.length}</div>
          <div className="list">
            {loose.map((i) => (
              <div className="item" key={i.summary.product.id}>
                <ProductTile s={i.summary} />
                <span className="item-main"><span className="item-name">{i.summary.product.name}</span><span className="item-meta">{qty(i.quantity, i.summary.product.unit)} with no place</span></span>
                <button type="button" className="btn small" disabled={busy} onClick={() => void putHere(i.summary)}>Put here</button>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        Something new? <Link to={`/scan?mode=add&place=${place.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>Scan it here</Link> or <Link to={`/add?place=${place.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>add it by name</Link>.
      </p>
    </Sheet>
  );
}

/**
 * One item in the quick add: how many are here and in total, − and + for how
 * many should be here, and the tick to save it. Taking some away uses this
 * place's stock; rechargeables can only be added to here (flat ones are changed
 * on the item's page).
 */
function QuickAddRow({ s, place }: { s: ProductSummary; place: Place }) {
  const { run, busy } = useAction();
  const p = s.product;
  const here = s.stockByPlace?.find((x) => x.id === place.id)?.quantity ?? 0;
  const [n, setN] = useState<number | null>(null);
  const want = n ?? here;
  const d = Math.round((want - here) * 1000) / 1000;
  const label = place.code ?? place.name;
  const save = async () => {
    if (!d) return;
    const done = await run(
      () => (d > 0 ? api.stock.add({ productId: p.id, quantity: d, placeId: place.id }) : api.stock.use({ productId: p.id, quantity: -d, placeId: place.id })),
      d > 0 ? `Added ${qty(d, p.unit)} of ${p.name} to ${label}` : `${p.name}: ${qty(want, p.unit)} in ${label} now`,
    );
    if (done) setN(null);
  };
  const total = Math.round((s.inStock + d) * 1000) / 1000;
  return (
    <div className="item">
      <ProductTile s={s} />
      <span className="item-main">
        <span className="item-name">{p.name}</span>
        <span className="item-meta">{qty(want, p.unit)} here · {qty(total, p.unit)} in total{d ? <b> ({d > 0 ? '+' : '−'}{qty(Math.abs(d), p.unit)})</b> : null}</span>
      </span>
      <Stepper small value={want} onChange={setN} min={p.rechargeable ? here : 0} label={`${p.name} in ${label}`} />
      <button type="button" className="check" aria-label={`Save ${p.name} in ${label}`} aria-pressed={!!d} disabled={!d || busy} onClick={() => void save()}><Icon name="check" size="sm" /></button>
    </div>
  );
}
