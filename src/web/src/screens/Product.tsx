import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { ProductDetail, ProductSummary, StockEntryView } from '@larder/core';
import { api, ApiError } from '../api';
import { Icon } from '../icons';
import { ago, dayText, expiryText, longDate, measureQty, num, ownUsage, packsText, plural, qty, shortDate, stockText, usageSentence, usageText, weighsText, worthText } from '../format';
import { useEnabledWebModules } from '../modules';
import { ErrorBox, Header, Loading, PlaceSelect, PlaceText, ProductTile, Seg, Sheet, StatusPills, Stepper, Switch, useAction, useIsDesktop, usePlaces, useShops } from '../ui';
import { NfcTags } from '../components/NfcTags';
import { rotatePhoto } from '../components/camera';

const KIND_TEXT: Record<string, string> = { add: 'Added', use: 'Used', move: 'Moved', return: 'Put back', expect: 'Ordered', arrive: 'Arrived', adjust: 'Edited', remove: 'Removed', flat: 'Went flat', charged: 'Charged', finish: 'Finished the open one' };

export function ProductPage() {
  const { id = '' } = useParams();
  const desktop = useIsDesktop();
  const { data: p, error, isLoading } = useQuery({ queryKey: ['product', id], queryFn: () => api.products.get(id) });
  // "?add=elsewhere" (from the stock list) opens straight on adding at another place.
  const [params] = useSearchParams();
  const [sheet, setSheet] = useState<null | 'add' | 'elsewhere' | 'use' | 'move' | 'expect'>(params.get('add') === 'elsewhere' ? 'elsewhere' : null);
  const { run, busy } = useAction();
  const panels = useEnabledWebModules().flatMap((m) => m.productPanels ?? []);
  const photoInput = useRef<HTMLInputElement>(null);

  if (isLoading) return <Loading />;
  if (error || !p) return <><Header title="Item" back="/stock" /><div className="content"><ErrorBox error={error} /></div></>;

  const inStock = p.entries.filter((e) => e.status === 'in_stock');
  const expected = p.entries.filter((e) => e.status === 'expected');
  const pending = p.entries.filter((e) => e.status === 'pending');
  const min = p.product.minQuantity ?? 0;
  const scale = Math.max(min, p.inStock + p.expected + p.pending, 1);
  const renewal = p.category?.name === 'Renewals';
  const unit = p.product.unit;
  // Larder takes these out, one lasting days: the one in use can be swapped early.
  const startNext = !!p.product.usage?.auto && p.inUse && p.product.usage.everyDays >= 2 && !p.product.usage.unit;
  // In the item's own unit (4 g a day of a 400 g jar is 0.01 jar a day), for how long the minimum lasts.
  const own = p.product.usage ? ownUsage(p.product.unit, p.product.size, p.product.usage) : null;

  async function uploadPhoto(file: File) {
    await run(async () => {
      const { id: fileId } = await api.files.upload(file);
      return api.products.update(p!.product.id, { photoFileIds: [fileId, ...p!.product.photoFileIds].slice(0, 6) });
    }, 'Photo added');
  }

  /** Turns the item's photo a quarter turn: saved as a new photo in its place. */
  async function rotateMainPhoto() {
    const [first, ...rest] = p!.product.photoFileIds;
    if (!first) return;
    await run(async () => {
      const res = await fetch(api.files.url(first), { credentials: 'same-origin' });
      if (!res.ok) throw new ApiError("Couldn't open the photo to turn it.", res.status, 'not_found');
      const turned = await rotatePhoto(await res.blob());
      const { id } = await api.files.upload(new File([turned], 'photo.jpg', { type: 'image/jpeg' }));
      return api.products.update(p!.product.id, { photoFileIds: [id, ...rest] });
    }, 'Photo turned');
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
              {p.product.photoFileIds[0] && (
                <button type="button" className="link small" style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6 }} disabled={busy} onClick={() => void rotateMainPhoto()}>
                  <Icon name="rotate" size="sm" />Rotate photo
                </button>
              )}
            </div>
          </div>

          <div className="card pad">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="big-qty">
                {renewal ? (
                  p.daysToExpiry !== null ? <><b>{Math.max(0, p.daysToExpiry)}</b><span className="muted">{p.daysToExpiry < 0 ? 'days: renewal is overdue' : `day${p.daysToExpiry === 1 ? '' : 's'} until it renews`}</span></> : <><b>—</b><span className="muted">No renewal date yet</span></>
                ) : p.product.rechargeable ? <><b>{num(p.charged ?? 0)}</b><span className="muted">charged · {num(p.flat ?? 0)} flat</span></> : <><b>{num(p.inStock)}</b><span className="muted">{qty(p.inStock, unit).replace(/^[\d.,¼½¾⅓⅔]+\s?/, '') || 'in the house'}{packsText(p.product.pack, p.inStock) ? ` · ${packsText(p.product.pack, p.inStock)}` : ''}{measureQty(unit, p.product.size, p.product.usage, p.inStock) ? ` · ${measureQty(unit, p.product.size, p.product.usage, p.inStock)}` : ''}</span></>}
              </div>
              <StatusPills s={p} />
            </div>
            {(min > 0 || p.expected > 0 || p.pending > 0) && (
              <div className="meter" aria-hidden="true"><i style={{ width: `${(p.inStock / scale) * 100}%`, background: p.status.low ? 'var(--low)' : 'var(--accent)' }} /><i style={{ width: `${((p.expected + p.pending) / scale) * 100}%`, background: 'var(--coming)', opacity: 0.45 }} /></div>
            )}
            <div className="small muted">
              {p.product.usage ? <><UsageLine p={p} />{' '}</> : null}
              {p.inUse && !p.product.usage && p.product.inUseSince ? <>One open since {shortDate(p.product.inUseSince)}{p.inStock + p.expected + p.pending <= 0 ? ', the last one' : ''}. </> : null}
              {min > 0 ? <>Low below {qty(min, unit)}{own ? ` (${worthText((min * own.everyDays) / own.amount)})` : ''}. </> : null}
              {p.expected + p.pending > 0 ? <>With {qty(p.expected + p.pending, unit)} {p.pending ? (p.expected ? `on order (${num(p.pending)} not confirmed)` : 'in a pending order') : 'on the way'} you'll have {num(p.inStock + p.expected + p.pending)}, so it's {p.status.low ? 'still low' : <b style={{ color: 'var(--ink)' }}>not on the shopping list</b>}.</> : null}
              {p.nextExpiry ? <> {renewal ? 'Renews' : 'Next to expire'}: {longDate(p.nextExpiry)}.</> : null}
              {p.product.wish ? <> On the wish list.</> : null}
            </div>
            <div className="btnrow">
              {startNext && <button type="button" className="btn small" disabled={busy || p.inStock <= 0} onClick={() => run(() => api.stock.use({ productId: p.product.id, quantity: Math.min(p.product.usage!.amount, p.inStock), open: true }), (r) => `Started a new one · ${stockText(r)} left`)}><Icon name="undo" size="sm" />Came off early: start the next one now</button>}
              {p.inUse && !startNext && (!p.product.usage || (p.product.usage.everyDays >= 2 && !p.product.usage.unit)) && <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.stock.finished(p.product.id), p.product.usage ? 'Finished: none in use now' : 'Finished: none open now')}><Icon name="check" size="sm" />{p.product.usage ? 'Finished early' : 'Finished the open one'}</button>}
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
            <div className="label">Where it is {!renewal && <button type="button" className="link" onClick={() => setSheet('elsewhere')}>Add somewhere else</button>}</div>
            {inStock.length === 0 && expected.length === 0 && pending.length === 0 ? <p className="muted small">None in the house.</p> : (
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
                {pending.map((e) => (
                  <div className="loc-row" key={e.id} style={{ flexWrap: 'wrap' }}>
                    <span className="code" style={{ background: 'var(--coming-bg)', color: 'var(--coming)' }}>ORD</span>
                    <span className="item-main"><span className="item-name">Pending order · {e.expected?.source}</span><span className="item-meta">Not confirmed yet{e.expected?.eta ? ` · due ${shortDate(e.expected.eta)}` : ''}</span></span>
                    <span className="qty">{num(e.quantity)}</span>
                    <span className="row" style={{ gap: 6 }}>
                      <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.stock.confirmOrders({ entryIds: [e.id] }), 'Confirmed: on the way')}>Confirm</button>
                      <button type="button" className="btn small ghost" disabled={busy} onClick={() => run(() => api.stock.cancelOrders({ entryIds: [e.id] }), 'Removed from the pending order')}>Remove</button>
                    </span>
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
                {p.product.pack ? <><dt>Comes in</dt><dd>{plural(p.product.pack.name, 2)} of {num(p.product.pack.holds)}</dd></> : null}
                {weighsText(unit, p.product.size) ? <><dt>Weighs</dt><dd>{weighsText(unit, p.product.size)}</dd></> : null}
                {p.product.usage ? <><dt>We use</dt><dd>{usageText(unit, p.product.usage)}{p.product.usage.auto ? ', taken out by Larder' : ''}</dd></> : null}
                <dt>Low below</dt><dd>{p.product.minQuantity ?? <span className="muted">Not set</span>}</dd>
                {p.product.stockUpTo != null && <><dt>Stock up to</dt><dd>{p.product.stockUpTo}</dd></>}
                <dt>Buy from</dt><dd>{p.product.preferredShopIds.length ? p.shops.map((s) => s.name).join(', ') : p.shops.length ? `Any shop (${p.shops.map((s) => s.name).join(', ')})` : <span className="muted">No shop sells this category</span>}</dd>
                <dt>New stock goes to</dt><dd>{p.product.defaultPlaceId ? (p.places.find((x) => x.id === p.product.defaultPlaceId)?.path ?? 'Set') : <span className="muted">Where most of it is</span>}</dd>
              </dl>
            </div>
            {p.product.notes && <div className="card pad"><b>Notes</b><p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{p.product.notes}</p></div>}
            {p.product.links.length > 0 && (
              <div className="list">{p.product.links.map((l) => <a key={l.url} className="item" href={l.url} target="_blank" rel="noreferrer"><Icon name="link" /><span className="item-main"><span className="item-name">{l.title || new URL(l.url).hostname}</span><span className="item-meta">{l.url}</span></span></a>)}</div>
            )}
          </div>
          <NfcTags tags={p.product.nfcTags} productId={p.product.id} />
          {p.history.length > 0 && (
            <div className="section">
              <div className="label">History</div>
              <div className="list">
                {p.history.slice(0, 8).map((h) => (
                  <div className="item" key={h.id}><span className="item-main"><span className="item-name">{KIND_TEXT[h.kind] ?? h.kind}{h.quantity ? ` ${num(Math.abs(h.quantity))}` : ''}</span><span className="item-meta">{h.note && h.note !== 'temporary' && h.note !== 'permanent' ? `${h.note} · ` : ''}{ago(h.at)}{ago(h.at).match(/\d+ (day|wk)/) ? ' ago' : ''}</span></span></div>
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
      {sheet === 'elsewhere' && <AddSheet p={p} elsewhere onClose={() => setSheet(null)} />}
      {sheet === 'use' && <UseSheet p={p} onClose={() => setSheet(null)} />}
      {sheet === 'move' && <MoveSheet p={p} onClose={() => setSheet(null)} />}
      {sheet === 'expect' && <ExpectSheet p={p} onClose={() => setSheet(null)} />}
    </>
  );
}

/** "Uses 2 tea bags a day, taken out by Larder. Enough until 26 Nov." or, for one lasting days, "One in use until 20 Nov." */
function UsageLine({ p }: { p: ProductDetail }) {
  const u = p.product.usage!;
  const until = p.runsOutOn ? <b style={{ color: 'var(--ink)' }}>{dayText(p.runsOutOn, p.daysToRunOut)}</b> : null;
  const none = p.inStock <= 0;
  return (
    <>
      Uses {usageText(p.product.unit, u)}{u.auto ? ', taken out by Larder' : ''}.{' '}
      {/* Used by weight: how long one lasts ("A 400 g jar lasts 100 days."), and no "one in use" apart from the stock. */}
      {u.unit ? <>{usageSentence({ unit: p.product.unit, pack: p.product.pack ?? null, size: p.product.size, usage: u })}{' '}</> : null}
      {p.inUseUntil && u.everyDays >= 2 && !u.unit ? <>One in use until {shortDate(p.inUseUntil)}{none ? ', and none left after it' : ''}. </> : null}
      {u.auto && !p.product.inUseSince ? <>None in use: the next Use starts one, and Larder takes them out from then. </> : null}
      {until && !(none && p.inUseUntil && u.everyDays >= 2 && !u.unit) ? (none && !p.inUseUntil ? <>None left. </> : <>Enough until {until}. </>) : null}
    </>
  );
}

/**
 * Whether a plain Use starts one: with a usage Larder doesn't take out, always; with one it does,
 * only when none is started (otherwise it's an extra). Something used by weight isn't started one
 * at a time, so a Use is just a use, unless Larder has stopped taking it out.
 */
function startsOne(p: ProductDetail): boolean {
  const u = p.product.usage;
  if (u?.unit) return u.auto && !p.product.inUseSince;
  return !!u && (!u.auto || !p.product.inUseSince);
}

/** What a Use did, in a toast: Larder's own takes make a plain Use an extra. */
function usedText(p: ProductDetail, r: ProductSummary, n: number, open: boolean): string {
  const u = p.product.usage;
  const what = p.product.rechargeable ? 'Marked flat' : !u || (u.unit && !u.auto) ? (open ? 'Opened' : 'Used') : startsOne(p) ? 'Started' : open ? 'Started a new one:' : 'Used an extra';
  return `${what} ${num(n)} · ${stockText(r)} left${r.runsOutOn ? `, enough until ${dayText(r.runsOutOn, r.daysToRunOut)}` : ''}`;
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
        <button type="button" aria-label="Use one" disabled={busy || (p.product.rechargeable && e.charge === 'flat')} onClick={() => run(() => api.stock.use({ productId: p.product.id, quantity: Math.min(1, e.quantity), placeId: at }), (r) => usedText(p, r, Math.min(1, e.quantity), false))}><Icon name="minus" size="sm" /></button>
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
              <span className="tile">{v.photoFileId ? <img src={api.files.url(v.photoFileId)} alt="" loading="lazy" /> : v.imageUrl ? <img src={v.imageUrl} alt="" loading="lazy" /> : <Icon name="scan" />}</span>
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

/** Add stock: to its usual place, or (elsewhere) somewhere else picked by the person. */
function AddSheet({ p, onClose, elsewhere = false }: { p: ProductDetail; onClose: () => void; elsewhere?: boolean }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [n, setN] = useState(1);
  // With a pack, Add counts packs by default (1 box = 20 tea bags); the counted unit is a tap away.
  const pack = p.product.pack ?? null;
  const [inPacks, setInPacks] = useState(!!pack);
  const counted = inPacks && pack ? Math.round(n * pack.holds * 1000) / 1000 : n;
  const [placeId, setPlaceId] = useState<string | null>(elsewhere ? null : (p.product.defaultPlaceId ?? p.places[0]?.id ?? null));
  const [expiresOn, setExpiresOn] = useState('');
  const [variantId, setVariantId] = useState<string>('');
  // Bought it: with a price, shop or receipt it's kept in the purchase history too.
  const shops = useShops();
  const [price, setPrice] = useState('');
  const [shopId, setShopId] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);
  const receiptInput = useRef<HTMLInputElement>(null);
  const bought = price.trim() !== '' || !!shopId || !!receipt;
  const priceOk = price.trim() === '' || Number(price) >= 0;

  async function add() {
    if (!bought) return api.stock.add({ productId: p.product.id, quantity: counted, placeId, expiresOn: expiresOn || undefined, variantId: variantId || null });
    const receiptFileId = receipt ? (await api.files.upload(receipt)).id : null;
    const [r] = await api.shopping.purchase({
      shopId: shopId || null,
      items: [{ productId: p.product.id, quantity: counted, placeId, ...(price.trim() !== '' ? { price: Number(price) } : {}), ...(expiresOn ? { expiresOn } : {}), variantId: variantId || null }],
      ...(receiptFileId ? { evidence: { receiptFileId } } : {}),
    });
    return r!;
  }

  return (
    <Sheet title={elsewhere ? `Add ${p.product.name.toLowerCase()} somewhere else` : `Add ${p.product.name.toLowerCase()}`} onClose={onClose}>
      {elsewhere && <p className="small muted">For a second place it's kept, like spare rolls in the bathroom as well as the utility room. To say something's been moved, use Move instead.</p>}
      <label className="field"><span>Where</span><PlaceSelect value={placeId} onChange={setPlaceId} places={places} allowNone={!elsewhere} label="Where" />{elsewhere && !placeId && <small>Pick the place.</small>}</label>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}><b>How many {pack ? '' : p.product.unit === 'each' ? '' : `(${p.product.unit})`}</b>
        <span className="row" style={{ gap: 6 }}>
          <Stepper value={n} onChange={setN} min={0.1} label="quantity" />
          {pack && (
            <select className="input" style={{ width: 'auto' }} value={inPacks ? 'pack' : 'unit'} onChange={(e) => setInPacks(e.target.value === 'pack')} aria-label="In">
              <option value="pack">{plural(pack.name, n)} of {num(pack.holds)}</option>
              <option value="unit">{p.product.unit === 'each' ? 'single ones' : plural(p.product.unit, n)}</option>
            </select>
          )}
        </span>
      </div>
      <label className="field"><span>Expires (optional)</span><input className="input" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} /><small>{p.product.shelfLifeDays ? `Leave blank to use the ${p.product.shelfLifeDays}-day shelf life.` : 'Leave blank for no expiry.'}</small></label>
      {p.variants.length > 0 && (
        <label className="field"><span>Brand</span><select className="input" value={variantId} onChange={(e) => setVariantId(e.target.value)}><option value="">Not saying</option>{p.variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      )}
      {!elsewhere && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="inputrow" style={{ flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: '1 1 110px' }}><span>Price paid (optional)</span><input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="2.50" /></label>
            {shops.length > 0 && (
              <label className="field" style={{ flex: '2 1 160px' }}><span>Shop</span><select className="input" value={shopId} onChange={(e) => setShopId(e.target.value)}><option value="">Not saying</option>{shops.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            )}
          </div>
          <input ref={receiptInput} type="file" accept="image/*" capture="environment" hidden data-testid="add-receipt-photo" onChange={(e) => { setReceipt(e.target.files?.[0] ?? null); e.target.value = ''; }} />
          <button type="button" className="link small" style={{ justifySelf: 'start' }} onClick={() => (receipt ? setReceipt(null) : receiptInput.current?.click())}>{receipt ? 'Receipt photo added · take it off' : 'Add a photo of the receipt'}</button>
          {bought && <small className="muted">Kept in the purchase history with {[price.trim() !== '' ? 'the price' : null, shopId ? 'the shop' : null, receipt ? 'the receipt' : null].filter(Boolean).join(' and ')}.</small>}
        </div>
      )}
      <button type="button" className="btn primary block" disabled={busy || n <= 0 || (elsewhere && !placeId) || !priceOk} onClick={() => run(add, (r) => `Added ${inPacks && pack ? `${qty(n, pack.name)} (${qty(counted, p.product.unit)})` : num(n)}${placeId ? ` to ${places.find((x) => x.id === placeId)?.name ?? 'there'}` : ''} · ${stockText(r)}`).then((r) => r && onClose())}>
        Add {inPacks && pack ? `${qty(n, pack.name)} (${qty(counted, p.product.unit)})` : qty(n, p.product.unit)}
      </button>
    </Sheet>
  );
}

function UseSheet({ p, onClose }: { p: ProductDetail; onClose: () => void }) {
  const { run, busy } = useAction();
  const available = p.product.rechargeable ? (p.charged ?? 0) : p.inStock;
  // Anything without a usage can be marked open (the butter in the fridge). When Larder takes them out, a Use is
  // an extra unless it starts a new one now (a sensor that came off early); without, or with none started,
  // using one starts it, and starting one takes its usual amount (2 lenses).
  const usage = p.product.usage ?? null;
  const starts = startsOne(p);
  // Starting one used by weight takes a whole one (its usual amount is grams).
  const [n, setN] = useState(Math.min(starts && !usage!.unit ? usage!.amount : 1, available));
  const [from, setFrom] = useState<string>('');
  const [open, setOpen] = useState(false);
  const extra = !!usage?.auto && !starts;
  const canOpen = !p.product.rechargeable && (!usage || (extra && usage.everyDays >= 2 && !usage.unit));
  const placesWithStock = [...new Map(p.entries.filter((e) => e.status === 'in_stock').map((e) => [e.currentPlace?.id ?? e.place?.id ?? '', e.currentPlace ?? e.place])).values()].filter((x) => !!x);
  return (
    <Sheet title={p.product.rechargeable ? 'Mark as flat' : `Use ${p.product.name.toLowerCase()}`} onClose={onClose}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>How many</b><Stepper value={n} onChange={setN} min={0.1} max={available} label="quantity" /></div>
      {placesWithStock.length > 1 && (
        <label className="field"><span>From</span><select className="input" value={from} onChange={(e) => setFrom(e.target.value)}><option value="">Whatever expires first</option>{placesWithStock.map((pl) => <option key={pl!.id} value={pl!.id}>{pl!.path}</option>)}</select></label>
      )}
      {extra && <p className="small muted" style={{ margin: 0 }}>Larder already takes out {usageText(p.product.unit, usage!)} by itself, so this is an extra one.</p>}
      {usage && starts && <p className="small muted" style={{ margin: 0 }}>{usage.auto ? `None in use: using one starts it, and Larder takes out ${usageText(p.product.unit, usage)} from then.` : 'Using one starts it: it\'s the one in use from today.'}</p>}
      {canOpen && (
        <div className="toggle" style={{ padding: 0 }}>
          <span><b>{usage ? 'Started a new one now' : 'Opened, still using it'}</b><br /><span className="small muted">{usage ? 'The one in use came off early: this one starts today' : 'It shows as open until you say it\'s finished'}</span></span>
          <Switch checked={open} onChange={setOpen} label={usage ? 'Started a new one now' : 'Opened, still using it'} />
        </div>
      )}
      <button type="button" className="btn primary block" disabled={busy || n <= 0} onClick={() => run(() => api.stock.use({ productId: p.product.id, quantity: n, placeId: from || undefined, ...(canOpen && open ? { open: true } : {}) }), (r) => usedText(p, r, n, canOpen && open)).then((r) => r && onClose())}>
        {p.product.rechargeable ? `Mark ${num(n)} flat` : canOpen && open ? `${usage ? 'Start' : 'Open'} ${qty(n, p.product.unit)}` : `Use ${qty(n, p.product.unit)}${extra ? ' extra' : ''}`}
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
  const [n, setN] = useState(Math.max(1, (p.product.stockUpTo ?? p.product.minQuantity ?? 1) - p.inStock - p.expected - p.pending));
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
