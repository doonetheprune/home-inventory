import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { ProductDetail, StockEntryView } from '@larder/core';
import { api } from '../api';
import { Icon } from '../icons';
import { ago, expiryText, longDate, num, qty, shortDate, stockText } from '../format';
import { useEnabledWebModules } from '../modules';
import { ErrorBox, Header, Loading, PlaceSelect, PlaceText, ProductTile, Seg, Sheet, StatusPills, Stepper, useAction, useIsDesktop, usePlaces } from '../ui';

const KIND_TEXT: Record<string, string> = { add: 'Added', use: 'Used', move: 'Moved', return: 'Put back', expect: 'Ordered', arrive: 'Arrived', adjust: 'Edited', remove: 'Removed', flat: 'Went flat', charged: 'Charged' };

export function ProductPage() {
  const { id = '' } = useParams();
  const desktop = useIsDesktop();
  const { data: p, error, isLoading } = useQuery({ queryKey: ['product', id], queryFn: () => api.products.get(id) });
  const [sheet, setSheet] = useState<null | 'add' | 'use' | 'move' | 'expect'>(null);
  const { run, busy } = useAction();
  const panels = useEnabledWebModules().flatMap((m) => m.productPanels ?? []);
  const photoInput = useRef<HTMLInputElement>(null);

  if (isLoading) return <Loading />;
  if (error || !p) return <><Header title="Item" back="/stock" /><div className="content"><ErrorBox error={error} /></div></>;

  const inStock = p.entries.filter((e) => e.status === 'in_stock');
  const expected = p.entries.filter((e) => e.status === 'expected');
  const min = p.product.minQuantity ?? 0;
  const scale = Math.max(min, p.inStock + p.expected, 1);
  const renewal = p.category?.name === 'Renewals';
  const unit = p.product.unit;

  async function uploadPhoto(file: File) {
    await run(async () => {
      const { id: fileId } = await api.files.upload(file);
      return api.products.update(p!.product.id, { photoFileIds: [fileId, ...p!.product.photoFileIds].slice(0, 6) });
    }, 'Photo added');
  }

  return (
    <>
      <Header title={desktop ? p.product.name : ''} back="/stock">
        <Link className="iconbtn" to={`/products/${p.product.id}/edit`} aria-label="Edit"><Icon name="edit" /></Link>
      </Header>
      <div className={`content ${desktop ? 'split' : ''}`}>
        <div className="col-a">
          <div className="hero">
            <button type="button" className="tile lg" style={{ border: 0, padding: 0 }} aria-label="Add a photo" onClick={() => photoInput.current?.click()}>
              {p.product.photoFileIds[0] ? <img src={api.files.url(p.product.photoFileIds[0])} alt="" /> : <ProductTile s={p} size="lg" />}
            </button>
            <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0])} />
            <div className="stack" style={{ gap: 6, minWidth: 0 }}>
              <h2>{p.product.name}</h2>
              {p.product.aliases.length > 0 && <div className="aliases">{p.product.aliases.map((a) => <span key={a} className="pill p-plain">{a}</span>)}</div>}
            </div>
          </div>

          <div className="card pad">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="big-qty">
                {renewal ? (
                  p.daysToExpiry !== null ? <><b>{Math.max(0, p.daysToExpiry)}</b><span className="muted">{p.daysToExpiry < 0 ? 'days: renewal is overdue' : `day${p.daysToExpiry === 1 ? '' : 's'} until it renews`}</span></> : <><b>—</b><span className="muted">No renewal date yet</span></>
                ) : p.product.rechargeable ? <><b>{num(p.charged ?? 0)}</b><span className="muted">charged · {num(p.flat ?? 0)} flat</span></> : <><b>{num(p.inStock)}</b><span className="muted">{qty(p.inStock, unit).replace(/^[\d.,¼½¾⅓⅔]+\s?/, '') || 'in the house'}</span></>}
              </div>
              <StatusPills s={p} />
            </div>
            {(min > 0 || p.expected > 0) && (
              <div className="meter" aria-hidden="true"><i style={{ width: `${(p.inStock / scale) * 100}%`, background: p.status.low ? 'var(--low)' : 'var(--accent)' }} /><i style={{ width: `${(p.expected / scale) * 100}%`, background: 'var(--coming)', opacity: 0.45 }} /></div>
            )}
            <div className="small muted">
              {min > 0 ? <>Low below {qty(min, unit)}. </> : null}
              {p.expected > 0 ? <>With {qty(p.expected, unit)} on the way you'll have {num(p.inStock + p.expected)}, so it's {p.status.low ? 'still low' : <b style={{ color: 'var(--ink)' }}>not on the shopping list</b>}.</> : null}
              {p.nextExpiry ? <> {renewal ? 'Renews' : 'Next to expire'}: {longDate(p.nextExpiry)}.</> : null}
              {p.product.wish ? <> On the wish list.</> : null}
            </div>
            <div className="btnrow">
              {p.product.rechargeable && (p.flat ?? 0) > 0 && <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.stock.charge({ productId: p.product.id, quantity: p.flat ?? 0 }), 'All charged')}><Icon name="zap" size="sm" />Charged {num(p.flat ?? 0)}</button>}
              {!renewal && (
                <>
                  <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.products.setOnList(p.product.id, !p.product.onShoppingList), p.product.onShoppingList ? 'Taken off the shopping list' : 'Put on the shopping list')}>
                    <Icon name="cart" size="sm" />{p.product.onShoppingList ? 'Take off the list' : 'Put on the list'}
                  </button>
                  <button type="button" className="btn small" onClick={() => setSheet('expect')}><Icon name="truck" size="sm" />Expect a delivery</button>
                </>
              )}
            </div>
          </div>

          <div className="section">
            <div className="label">Where it is</div>
            {inStock.length === 0 && expected.length === 0 ? <p className="muted small">None in the house.</p> : (
              <div className="list">
                {inStock.map((e) => <EntryRow key={e.id} p={p} e={e} />)}
                {expected.map((e) => (
                  <div className="loc-row" key={e.id}>
                    <span className="code" style={{ background: 'var(--coming-bg)', color: 'var(--coming)' }}>EXP</span>
                    <span className="item-main"><span className="item-name">Expected · {e.expected?.source}</span><span className="item-meta">{e.expected?.eta ? `Due ${shortDate(e.expected.eta)}` : 'No date'}{e.place ? ` · goes to ${e.place.path}` : ''}</span></span>
                    <span className="qty">{num(e.quantity)}</span>
                    <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.stock.arrive({ entryIds: [e.id] }), 'Arrived and added to stock')}>Arrived</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Variants p={p} />
        </div>

        <div className="col-b">
          {panels.map((Panel, i) => <Panel key={i} product={p} />)}
          <div className="section">
            <div className="label">Details <Link to={`/products/${p.product.id}/edit`}>Edit</Link></div>
            <div className="card pad">
              <dl className="kv">
                <dt>Category</dt><dd>{p.category?.name ?? '—'}</dd>
                <dt>Counted in</dt><dd>{unit}</dd>
                <dt>{renewal ? 'Renews every' : 'Shelf life'}</dt><dd>{p.product.shelfLifeDays ? `${p.product.shelfLifeDays} days` : <span className="muted">None</span>}</dd>
                <dt>Low below</dt><dd>{p.product.minQuantity ?? <span className="muted">Not set</span>}</dd>
                <dt>Buy from</dt><dd>{p.product.preferredShopIds.length ? p.shops.map((s) => s.name).join(', ') : p.shops.length ? `Any shop (${p.shops.map((s) => s.name).join(', ')})` : <span className="muted">No shop sells this category</span>}</dd>
                <dt>New stock goes to</dt><dd>{p.product.defaultPlaceId ? (p.places.find((x) => x.id === p.product.defaultPlaceId)?.path ?? 'Set') : <span className="muted">Where most of it is</span>}</dd>
                {p.product.nfcTags.length > 0 && <><dt>NFC tags</dt><dd>{p.product.nfcTags.length}</dd></>}
              </dl>
            </div>
            {p.product.notes && <div className="card pad"><b>Notes</b><p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{p.product.notes}</p></div>}
            {p.product.links.length > 0 && (
              <div className="list">{p.product.links.map((l) => <a key={l.url} className="item" href={l.url} target="_blank" rel="noreferrer"><Icon name="link" /><span className="item-main"><span className="item-name">{l.title || new URL(l.url).hostname}</span><span className="item-meta">{l.url}</span></span></a>)}</div>
            )}
          </div>
          {p.history.length > 0 && (
            <div className="section">
              <div className="label">History</div>
              <div className="list">
                {p.history.slice(0, 8).map((h) => (
                  <div className="item" key={h.id}><span className="item-main"><span className="item-name">{KIND_TEXT[h.kind] ?? h.kind} {num(Math.abs(h.quantity))}</span><span className="item-meta">{h.note && h.note !== 'temporary' && h.note !== 'permanent' ? `${h.note} · ` : ''}{ago(h.at)}{ago(h.at).match(/\d+ (day|wk)/) ? ' ago' : ''}</span></span></div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {renewal ? (
        <div className="dock">
          <Link className="btn" to={`/products/${p.product.id}/edit`}><Icon name="edit" />Edit</Link>
          <button className="btn primary" type="button" disabled={busy} onClick={() => run(() => api.products.renew(p.product.id), 'Renewed. The clock starts again from today.')}><Icon name="undo" />Renewed</button>
        </div>
      ) : (
      <div className="dock">
        <button className="btn" type="button" onClick={() => setSheet('use')} disabled={p.inStock <= 0}><Icon name="minus" />{p.product.rechargeable ? 'Went flat' : 'Use'}</button>
        <button className="btn" type="button" onClick={() => setSheet('move')} disabled={p.inStock <= 0}><Icon name="move" />Move</button>
        <button className="btn primary" type="button" onClick={() => setSheet('add')}><Icon name="plus" />Add</button>
      </div>
      )}
      {sheet === 'add' && <AddSheet p={p} onClose={() => setSheet(null)} />}
      {sheet === 'use' && <UseSheet p={p} onClose={() => setSheet(null)} />}
      {sheet === 'move' && <MoveSheet p={p} onClose={() => setSheet(null)} />}
      {sheet === 'expect' && <ExpectSheet p={p} onClose={() => setSheet(null)} />}
    </>
  );
}

function EntryRow({ p, e }: { p: ProductDetail; e: StockEntryView }) {
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(e.expiresOn ?? '');
  const away = e.currentPlace && e.currentPlace.id !== e.place?.id;
  const renewal = p.category?.name === 'Renewals';
  const at = e.currentPlaceId ?? e.placeId ?? undefined;
  return (
    <div className="loc-row" style={{ flexWrap: 'wrap' }}>
      {e.place?.code ? <span className="code">{e.place.code}</span> : <span className="tile" style={{ width: 32, height: 32, borderRadius: 9 }}><Icon name="pin" size="sm" /></span>}
      <span className="item-main">
        <span className="item-name">{e.place ? <PlaceText p={e.place} /> : 'No place set'}</span>
        <span className="item-meta">
          {away ? <span style={{ color: 'var(--away)' }}>Now in {e.currentPlace!.path} · </span> : null}
          {e.charge === 'flat' ? 'Flat · ' : e.charge === 'charged' ? 'Charged · ' : ''}
          {e.variantName ? `${e.variantName} · ` : ''}
          {e.expiresOn ? (renewal ? `Renews ${shortDate(e.expiresOn)}` : `Expires ${expiryText(e.expiresOn, null)}`) : 'No expiry'}
          {' · '}<button type="button" className="link small" onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Change'}</button>
        </span>
      </span>
      {away && <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.stock.returnHome({ productId: p.product.id, entryId: e.id }), 'Put back')}>Put back</button>}
      <span className="stepper">
        <button type="button" aria-label="Use one" disabled={busy || (p.product.rechargeable && e.charge === 'flat')} onClick={() => run(() => api.stock.use({ productId: p.product.id, quantity: Math.min(1, e.quantity), placeId: at }), (r) => `${p.product.rechargeable ? 'Marked flat' : 'Used'} · ${stockText(r)} left`)}><Icon name="minus" size="sm" /></button>
        <output>{num(e.quantity)}</output>
        <button type="button" aria-label="Add one" disabled={busy} onClick={() => run(() => api.stock.updateEntry(e.id, { quantity: e.quantity + 1 }), (r) => `Added · ${stockText(r)}`)}><Icon name="plus" size="sm" /></button>
      </span>
      {editing && (
        <div className="inputrow" style={{ width: '100%' }}>
          <input className="input" type="date" value={date} onChange={(ev) => setDate(ev.target.value)} aria-label="Expiry date" />
          <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.stock.updateEntry(e.id, { expiresOn: date || null }), 'Expiry changed').then(() => setEditing(false))}>Save</button>
          <button type="button" className="btn small danger" disabled={busy} onClick={() => run(() => api.stock.removeEntry(e.id), 'Removed')}><Icon name="trash" size="sm" /></button>
        </div>
      )}
    </div>
  );
}

function Variants({ p }: { p: ProductDetail }) {
  const { run, busy } = useAction();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  return (
    <div className="section">
      <div className="label">Brands &amp; barcodes <button type="button" className="link" onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : 'Add'}</button></div>
      {p.variants.length > 0 && (
        <div className="list">
          {p.variants.map((v) => (
            <div className="item" key={v.id}>
              <span className="tile">{v.imageUrl ? <img src={v.imageUrl} alt="" loading="lazy" /> : <Icon name="scan" />}</span>
              <span className="item-main"><span className="item-name">{v.name}</span><span className="item-meta">{[...v.barcodes.map((b) => b), ...v.shopCodes.map((c) => `shop code ${c.code}`)].join(' · ') || 'No barcode'}{v.source !== 'local' ? ` · from ${v.source}` : ''}</span></span>
              <button type="button" className="iconbtn ghost" aria-label={`Remove ${v.name}`} disabled={busy} onClick={() => run(() => api.products.removeVariant(v.id), 'Removed')}><Icon name="trash" size="sm" /></button>
            </div>
          ))}
        </div>
      )}
      {!p.variants.length && !adding && <p className="muted small">No brands yet. Scan a barcode to add one, or add it here.</p>}
      {adding && (
        <div className="card pad">
          <label className="field"><span>Brand or pack</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Andrex 9 rolls" /></label>
          <label className="field"><span>Barcode (optional)</span><input className="input mono" inputMode="numeric" value={barcode} onChange={(e) => setBarcode(e.target.value)} /></label>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => run(() => api.products.addVariant(p.product.id, { name: name.trim(), barcodes: barcode.trim() ? [barcode.trim()] : [] }), 'Added').then((r) => { if (r) { setAdding(false); setName(''); setBarcode(''); } })}>Add brand</button>
        </div>
      )}
    </div>
  );
}

function AddSheet({ p, onClose }: { p: ProductDetail; onClose: () => void }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [n, setN] = useState(1);
  const [placeId, setPlaceId] = useState<string | null>(p.product.defaultPlaceId ?? p.places[0]?.id ?? null);
  const [expiresOn, setExpiresOn] = useState('');
  const [variantId, setVariantId] = useState<string>('');
  return (
    <Sheet title={`Add ${p.product.name.toLowerCase()}`} onClose={onClose}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>How many {p.product.unit === 'each' ? '' : `(${p.product.unit})`}</b><Stepper value={n} onChange={setN} min={0.1} label="quantity" /></div>
      <label className="field"><span>Where</span><PlaceSelect value={placeId} onChange={setPlaceId} places={places} /></label>
      <label className="field"><span>Expires (optional)</span><input className="input" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} /><small>{p.product.shelfLifeDays ? `Leave blank to use the ${p.product.shelfLifeDays}-day shelf life.` : 'Leave blank for no expiry.'}</small></label>
      {p.variants.length > 0 && (
        <label className="field"><span>Brand</span><select className="input" value={variantId} onChange={(e) => setVariantId(e.target.value)}><option value="">Not saying</option>{p.variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      )}
      <button type="button" className="btn primary block" disabled={busy || n <= 0} onClick={() => run(() => api.stock.add({ productId: p.product.id, quantity: n, placeId, expiresOn: expiresOn || undefined, variantId: variantId || null }), (r) => `Added ${num(n)} · ${stockText(r)}`).then((r) => r && onClose())}>
        Add {qty(n, p.product.unit)}
      </button>
    </Sheet>
  );
}

function UseSheet({ p, onClose }: { p: ProductDetail; onClose: () => void }) {
  const { run, busy } = useAction();
  const available = p.product.rechargeable ? (p.charged ?? 0) : p.inStock;
  const [n, setN] = useState(Math.min(1, available));
  const [from, setFrom] = useState<string>('');
  const placesWithStock = [...new Map(p.entries.filter((e) => e.status === 'in_stock').map((e) => [e.currentPlace?.id ?? e.place?.id ?? '', e.currentPlace ?? e.place])).values()].filter((x) => !!x);
  return (
    <Sheet title={p.product.rechargeable ? 'Mark as flat' : `Use ${p.product.name.toLowerCase()}`} onClose={onClose}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>How many</b><Stepper value={n} onChange={setN} min={0.1} max={available} label="quantity" /></div>
      {placesWithStock.length > 1 && (
        <label className="field"><span>From</span><select className="input" value={from} onChange={(e) => setFrom(e.target.value)}><option value="">Whatever expires first</option>{placesWithStock.map((pl) => <option key={pl!.id} value={pl!.id}>{pl!.path}</option>)}</select></label>
      )}
      <button type="button" className="btn primary block" disabled={busy || n <= 0} onClick={() => run(() => api.stock.use({ productId: p.product.id, quantity: n, placeId: from || undefined }), (r) => `${p.product.rechargeable ? 'Marked flat' : 'Used'} ${num(n)} · ${stockText(r)} left`).then((r) => r && onClose())}>
        {p.product.rechargeable ? `Mark ${num(n)} flat` : `Use ${qty(n, p.product.unit)}`}
      </button>
    </Sheet>
  );
}

function MoveSheet({ p, onClose }: { p: ProductDetail; onClose: () => void }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [to, setTo] = useState<string | null>(null);
  const [mode, setMode] = useState<'temporary' | 'permanent'>('temporary');
  const [n, setN] = useState(p.inStock);
  return (
    <Sheet title={`Move ${p.product.name.toLowerCase()}`} onClose={onClose}>
      <Seg label="Kind of move" value={mode} onChange={setMode} options={[['temporary', 'For now (out of place)'], ['permanent', 'Its new home']]} />
      <p className="small muted">{mode === 'temporary' ? "It stays listed under its usual place and shows as out of place until it's put back." : 'Where it usually lives changes.'}</p>
      <label className="field"><span>To</span><PlaceSelect value={to} onChange={setTo} places={places} allowNone={false} /></label>
      {p.inStock > 1 && <div className="row" style={{ justifyContent: 'space-between' }}><b>How many</b><Stepper value={n} onChange={setN} min={0.1} max={p.inStock} label="quantity" /></div>}
      <button type="button" className="btn primary block" disabled={busy || !to} onClick={() => run(() => api.stock.move({ productId: p.product.id, toPlaceId: to!, quantity: n, mode }), 'Moved').then((r) => r && onClose())}>Move</button>
    </Sheet>
  );
}

function ExpectSheet({ p, onClose }: { p: ProductDetail; onClose: () => void }) {
  const { run, busy } = useAction();
  const [n, setN] = useState(Math.max(1, (p.product.minQuantity ?? 1) - p.inStock));
  const [source, setSource] = useState(p.shops[0] ? `${p.shops[0].name} delivery` : '');
  const [eta, setEta] = useState('');
  return (
    <Sheet title="Expect a delivery" onClose={onClose}>
      <p className="small muted">Ordered but not here yet. It counts towards stock, so it won't go on the shopping list.</p>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>How many</b><Stepper value={n} onChange={setN} min={0.1} label="quantity" /></div>
      <label className="field"><span>Coming from</span><input className="input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Tesco delivery" /></label>
      <label className="field"><span>Due (optional)</span><input className="input" type="date" value={eta} onChange={(e) => setEta(e.target.value)} /></label>
      <button type="button" className="btn primary block" disabled={busy || !source.trim()} onClick={() => run(() => api.stock.expect({ productId: p.product.id, quantity: n, source: source.trim(), eta: eta || null }), 'Added to deliveries').then((r) => r && onClose())}>Expect {qty(n, p.product.unit)}</button>
    </Sheet>
  );
}
