import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { IdentifyResult, Place, ProductSummary } from '@larder/core';
import { api, ApiError } from '../api';
import { Icon } from '../icons';
import { qty, stockText } from '../format';
import { useBarcodeScanner } from '../components/useBarcodeScanner';
import { Header, PlaceSelect, ProductTile, Seg, Stepper, useAction, useCategories, useDebounced, useIsDesktop, usePlaces, useToast } from '../ui';

type Mode = 'add' | 'use' | 'move' | 'putaway' | 'look';
const MODES: Array<[Mode, string]> = [['add', 'Add'], ['use', 'Use'], ['move', 'Move'], ['putaway', 'Put away'], ['look', 'Look up']];
const MODE_CHIP: Record<Mode, [string, string]> = {
  add: ['plus', 'Adding to stock'], use: ['minus', 'Using up'], move: ['move', 'Move: item, then where it’s going'], putaway: ['inbox', 'Put away: item, then shelf'], look: ['search', 'Look up only'],
};

export function Scan() {
  const [params, setParams] = useSearchParams();
  const desktop = useIsDesktop();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>((params.get('mode') as Mode) || 'add');
  const [camera, setCamera] = useState(() => !desktop && localStorage.getItem('larder.camera') === 'on');
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [looking, setLooking] = useState(false);
  const [typed, setTyped] = useState('');
  /** For move and put away: the item waiting for a place. */
  const [pending, setPending] = useState<ProductSummary | null>(null);
  /** Scanning a shelf in add mode makes it the target for the next items. */
  const [target, setTarget] = useState<{ id: string; label: string } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const { run } = useAction();

  const identify = useCallback(async (code: string) => {
    setLooking(true);
    try {
      const r = await api.identify(code);
      if (r.kind === 'place') {
        if (pending && (mode === 'move' || mode === 'putaway')) {
          const p = pending;
          setPending(null);
          setResult(null);
          await run(() => api.stock.move({ productId: p.product.id, toPlaceId: r.place.id, mode: mode === 'putaway' ? 'permanent' : 'temporary' }), `${p.product.name} ${mode === 'putaway' ? 'put away in' : 'moved to'} ${r.place.code ?? r.place.name}`);
          return;
        }
        if (mode === 'add') setTarget({ id: r.place.id, label: r.place.code ?? r.place.name });
      }
      if (r.kind === 'product' && (mode === 'move' || mode === 'putaway')) setPending(r.product);
      setResult(r);
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'That code could not be looked up.', error: true });
    } finally {
      setLooking(false);
    }
  }, [mode, pending, run, toast]);

  const { state, error } = useBarcodeScanner(video, camera, (code) => void identify(code));

  useEffect(() => {
    const code = params.get('code');
    if (code) {
      void identify(code);
      const next = new URLSearchParams(params);
      next.delete('code');
      setParams(next, { replace: true });
    }
  }, [params, identify, setParams]);

  useEffect(() => {
    localStorage.setItem('larder.camera', camera ? 'on' : 'off');
  }, [camera]);

  const done = () => setResult(null);

  return (
    <>
      <Header title="Scan" back="/" />
      <div className={`content ${desktop ? 'scan-grid' : ''}`}>
        <div className="section">
          <Seg label="What a scan does" value={mode} onChange={(m) => { setMode(m); setPending(null); }} options={MODES} />
          <div className="viewfinder" aria-label="Camera">
            <video ref={video} playsInline muted hidden={state !== 'on'} />
            {state === 'on' && <><div className="frame-corners" /><div className="line" /></>}
            <div className="vf-top">
              <span className="vf-chip"><Icon name={MODE_CHIP[mode][0]} size="sm" />{pending ? `Now scan where ${pending.product.name.toLowerCase()} goes` : target && mode === 'add' ? `Adding to ${target.label}` : MODE_CHIP[mode][1]}</span>
              {camera && <button type="button" className="vf-chip" onClick={() => setCamera(false)}>Stop camera</button>}
            </div>
            {state !== 'on' && (
              <div className="vf-idle">
                {state === 'starting' ? <div className="spinner" /> : <Icon name="camera" size="lg" />}
                {error ? <p className="small">{error}</p> : <p className="small">{state === 'starting' ? 'Starting the camera…' : 'Scan barcodes, QR labels and shelf codes with your camera.'}</p>}
                {state !== 'starting' && <button type="button" className="btn small" onClick={() => setCamera(true)}>{error ? 'Try again' : 'Start camera'}</button>}
              </div>
            )}
          </div>
          <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { void identify(typed.trim()); setTyped(''); } }}>
            <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type a barcode or code like G2-4" aria-label="Barcode or code" inputMode="text" />
            <button className="btn" disabled={!typed.trim() || looking}>Look up</button>
          </form>
          <div className="card hint"><Icon name="keyboard" size="sm" /><span>Using a USB or Bluetooth scanner? Just scan on any screen. Larder picks it up and opens the result here.</span></div>
        </div>

        <div className="section">
          {looking && <div className="sheet-card"><div className="row"><div className="spinner" /><span className="muted">Looking it up…</span></div></div>}
          {!looking && pending && !result && (
            <div className="sheet-card">
              <div className="match"><ProductTile s={pending} size="lg" /><div className="item-main"><h3>{pending.product.name}</h3><span className="small muted">Scan the shelf label, or pick the place.</span></div></div>
              <MovePicker p={pending} mode={mode} onDone={() => setPending(null)} />
            </div>
          )}
          {!looking && result && <ResultCard r={result} mode={mode} target={target} onClearTarget={() => setTarget(null)} onDone={done} onIdentified={(r) => setResult(r)} pending={pending} setPending={setPending} />}
          {!looking && !result && !pending && (
            <div className="card empty">
              <b>Ready</b>
              <span className="muted small">
                {mode === 'add' && 'Scan something to add it. Scan a shelf label first to put everything you scan after it on that shelf.'}
                {mode === 'use' && 'Scan something you’ve used up.'}
                {mode === 'move' && 'Scan the item you’re taking somewhere, then scan where it’s going. It will show as out of place.'}
                {mode === 'putaway' && 'Scan the item, then the shelf it lives on.'}
                {mode === 'look' && 'Scan anything to see what it is and where it lives.'}
              </span>
              {target && <span className="pill p-wish">Adding to {target.label} <button type="button" className="link small" onClick={() => setTarget(null)}>Clear</button></span>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function MovePicker({ p, mode, onDone }: { p: ProductSummary; mode: Mode; onDone: () => void }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [to, setTo] = useState<string | null>(null);
  return (
    <div className="inputrow">
      <PlaceSelect value={to} onChange={setTo} places={places} allowNone={false} label="Where it's going" />
      <button type="button" className="btn primary" disabled={!to || busy} onClick={() => run(() => api.stock.move({ productId: p.product.id, toPlaceId: to!, mode: mode === 'putaway' ? 'permanent' : 'temporary' }), mode === 'putaway' ? 'Put away' : 'Moved').then((r) => r && onDone())}>{mode === 'putaway' ? 'Put away' : 'Move'}</button>
    </div>
  );
}

function ResultCard({ r, mode, target, onClearTarget, onDone, onIdentified, pending, setPending }: {
  r: IdentifyResult; mode: Mode; target: { id: string; label: string } | null; onClearTarget: () => void; onDone: () => void; onIdentified: (r: IdentifyResult) => void;
  pending: ProductSummary | null; setPending: (p: ProductSummary | null) => void;
}) {
  if (r.kind === 'product') return <ProductResult s={r.product} variantName={r.variant?.name ?? null} code={r.code} mode={mode} target={target} onDone={onDone} pending={pending} setPending={setPending} />;
  if (r.kind === 'place') return <PlaceResult place={r.place} path={r.path} mode={mode} onClearTarget={onClearTarget} onDone={onDone} />;
  return <NewCodeResult r={r} onIdentified={onIdentified} />;
}

function ProductResult({ s, variantName, code, mode, target, onDone, pending, setPending }: {
  s: ProductSummary; variantName: string | null; code: string; mode: Mode; target: { id: string; label: string } | null; onDone: () => void;
  pending: ProductSummary | null; setPending: (p: ProductSummary | null) => void;
}) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [n, setN] = useState(1);
  const [placeId, setPlaceId] = useState<string | null>(target?.id ?? s.product.defaultPlaceId ?? s.places[0]?.id ?? null);
  const header = (
    <div className="match">
      <ProductTile s={s} size="lg" />
      <div className="item-main">
        <h3>{s.product.name}</h3>
        <div className="src">{variantName && <span>{variantName}</span>}<code>{code}</code></div>
      </div>
    </div>
  );
  if (mode === 'look') {
    return (
      <div className="sheet-card">
        {header}
        <p className="small muted">You have <b style={{ color: 'var(--ink)' }}>{stockText(s)}</b>{s.places[0] ? ` · ${s.places[0].path}` : ''}{s.nowIn[0] ? ` · now in ${s.nowIn[0].path}` : ''}.</p>
        <div className="btnrow"><button type="button" className="btn" onClick={onDone}>Scan next</button><Link className="btn primary" to={`/products/${s.product.id}`}>Open</Link></div>
      </div>
    );
  }
  if (mode === 'move' || mode === 'putaway') {
    return (
      <div className="sheet-card">
        {header}
        <p className="small muted">{pending ? 'Now scan the shelf label, or pick the place.' : ''}</p>
        <MovePicker p={s} mode={mode} onDone={() => { setPending(null); onDone(); }} />
      </div>
    );
  }
  const use = mode === 'use';
  const available = s.product.rechargeable ? (s.charged ?? 0) : s.inStock;
  return (
    <div className="sheet-card">
      {header}
      <p className="small muted">You have {stockText(s)}.{s.status.low ? ' Running low.' : ''}</p>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>How many?</b><Stepper value={n} onChange={setN} min={0.1} max={use ? Math.max(available, 0.1) : 99999} label="quantity" /></div>
      {!use && (
        <label className="field"><span>Where</span><PlaceSelect value={placeId} onChange={setPlaceId} places={places} /></label>
      )}
      <div className="btnrow">
        <button type="button" className="btn" onClick={onDone}>Skip</button>
        <button type="button" className="btn primary" disabled={busy || (use && available <= 0)} onClick={() => run(
          () => (use ? api.stock.use({ productId: s.product.id, quantity: n }) : api.stock.add({ productId: s.product.id, quantity: n, placeId })),
          (x) => `${use ? (s.product.rechargeable ? 'Marked flat' : 'Used') : 'Added'} ${qty(n, s.product.unit)} · ${stockText(x)} now. Ready for the next scan.`,
        ).then((x) => x && onDone())}>
          {use ? (s.product.rechargeable ? `Mark ${n} flat` : `Use ${qty(n, s.product.unit)}`) : `Add ${qty(n, s.product.unit)}`}
        </button>
      </div>
    </div>
  );
}

function PlaceResult({ place, path, mode, onClearTarget, onDone }: { place: Place; path: string; mode: Mode; onClearTarget: () => void; onDone: () => void }) {
  return (
    <div className="sheet-card">
      <div className="match"><span className="tile lg"><Icon name="qr" size="lg" /></span><div className="item-main"><h3>{place.code ? `${place.code} · ${place.name}` : place.name}</h3><div className="src">{path}</div></div></div>
      <p className="small muted">{mode === 'add' ? 'Everything you scan next goes here, until you scan another shelf.' : mode === 'move' || mode === 'putaway' ? 'Scan the item first, then this label.' : 'A place label.'}</p>
      <div className="btnrow">
        {mode === 'add' && <button type="button" className="btn" onClick={() => { onClearTarget(); onDone(); }}>Don’t use it</button>}
        <Link className="btn" to={`/places/${place.id}`}>See what’s here</Link>
        <button type="button" className="btn primary" onClick={onDone}>Scan next</button>
      </div>
    </div>
  );
}

function NewCodeResult({ r, onIdentified }: { r: Extract<IdentifyResult, { kind: 'external' | 'unknown' }>; onIdentified: (r: IdentifyResult) => void }) {
  const categories = useCategories();
  const { run, busy } = useAction();
  const external = r.kind === 'external' ? r.result : null;
  const [name, setName] = useState(external ? external.name : '');
  const [choice, setChoice] = useState<string>(r.kind === 'external' && r.suggestions[0] ? r.suggestions[0].product.id : 'new');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const dq = useDebounced(name.trim(), 250);
  const { data } = useQuery({ queryKey: ['search', dq], queryFn: () => api.search(dq), enabled: r.kind === 'unknown' && dq.length > 2 });
  const candidates: ProductSummary[] = r.kind === 'external' ? r.suggestions : (data?.sections.find((s) => s.id === 'stock')?.results.map((x) => x.product!).filter(Boolean) ?? []).slice(0, 3);
  const variantName = external ? [external.brand, external.name, external.quantityText].filter(Boolean).join(' ') : name;

  async function save() {
    const res = await run(() => api.remember({
      barcode: r.code,
      productId: choice !== 'new' ? choice : undefined,
      create: choice === 'new' ? { name: name.trim(), categoryId } : undefined,
      variantName: variantName || name.trim(),
      imageUrl: external?.imageUrl ?? null,
      source: external?.provider,
    }), 'Saved. Next time this barcode is instant.');
    if (res) onIdentified({ kind: 'product', code: r.code, product: res.product, variant: res.variant });
  }

  return (
    <div className="sheet-card">
      <div className="match">
        <span className="tile lg">{external?.imageUrl ? <img src={external.imageUrl} alt="" /> : <Icon name={external ? 'scan' : 'info'} size="lg" />}</span>
        <div className="item-main">
          <h3>{external ? [external.brand, external.name].filter(Boolean).join(' ') : 'New one on us'}</h3>
          <div className="src">{external && <span className="pill p-ok">{external.provider}</span>}{external?.quantityText && <span>{external.quantityText}</span>}<code>{r.code}</code></div>
        </div>
      </div>
      {r.kind === 'unknown' && <p className="small muted">{r.providersTried.length ? `${r.providersTried.join(', ')} ${r.providersTried.length === 1 ? "doesn't" : "don't"} know this barcode.` : "Larder doesn't know this code yet."} Name it once and Larder will remember it.</p>}
      <label className="field"><span>{external ? 'Call it' : 'What is it?'}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!external} /></label>
      <div className="field"><span>Is it a brand of something you already have?</span>
        <div className="stack" style={{ gap: 8 }}>
          {candidates.map((c) => (
            <button key={c.product.id} type="button" className={`choice ${choice === c.product.id ? 'on' : ''}`} onClick={() => setChoice(c.product.id)}>
              <span className="radio" /><span className="item-main"><span className="item-name">{c.product.name}</span><span className="item-meta">You have {stockText(c)} · adds this barcode as a brand</span></span>
            </button>
          ))}
          <button type="button" className={`choice ${choice === 'new' ? 'on' : ''}`} onClick={() => setChoice('new')}><span className="radio" /><span className="item-main"><span className="item-name">No, it’s something new</span><span className="item-meta">Creates “{name.trim() || 'a new item'}”</span></span></button>
        </div>
      </div>
      {choice === 'new' && (
        <div className="chips wrap">{categories.map((c) => <button key={c.id} type="button" className={`chip sm ${categoryId === c.id ? 'on' : ''}`} onClick={() => setCategoryId(categoryId === c.id ? null : c.id)}>{c.name}</button>)}</div>
      )}
      <button type="button" className="btn primary block" disabled={busy || (choice === 'new' && !name.trim())} onClick={save}>Save and continue</button>
    </div>
  );
}
