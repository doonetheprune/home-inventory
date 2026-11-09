import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { isLoose, parseAmount, type IdentifyResult, type LookupResult, type Place, type ProductSummary } from '@larder/core';
import { api, ApiError } from '../api';
import { Icon } from '../icons';
import { plural, qty, stockText } from '../format';
import { readBarcode, useBarcodeScanner } from '../components/useBarcodeScanner';
import { grabFrame } from '../components/camera';
import { usePhotoReader, type PhotoReading } from '../components/photoReader';
import { Header, PlaceSelect, ProductTile, Seg, Stepper, useAction, useDebounced, useIsDesktop, usePlaces, useToast } from '../ui';
import { UnitPicker } from '../components/UnitPicker';
import { notBoughtIn } from '../components/ProductForm';
import { useUnits } from '../units';

/** What new things are most often bought in, as chips on the card; More… has the rest of the list. */
const CHIPS = ['box', 'bag', 'jar', 'bottle', 'carton', 'tin', 'pack', 'each'];

type Mode = 'add' | 'use' | 'move' | 'putaway' | 'look';
const MODES: Array<[Mode, string]> = [['add', 'Add'], ['use', 'Use'], ['move', 'Move'], ['putaway', 'Put away'], ['look', 'Look up']];
const MODE_CHIP: Record<Mode, [string, string]> = {
  add: ['plus', 'Adding to stock'], use: ['minus', 'Using up'], move: ['move', 'Move: item, then where it’s going'], putaway: ['inbox', 'Put away: item, then shelf'], look: ['search', 'Look up only'],
};

/** A barcode just scanned that nothing knew, kept while the AI reads the pack. */
interface Kept { code: string; external: LookupResult | null; suggestions: ProductSummary[] }
interface AiDraft { photo: Blob | null; reading: PhotoReading; code: string | null; external: LookupResult | null; suggestions: ProductSummary[] }
/** What's being looked up: a barcode, a barcode found online that the AI is reading, or a photo the AI is reading. */
type Looking = false | 'code' | 'barcode' | 'photo';

export function Scan() {
  const [params, setParams] = useSearchParams();
  const desktop = useIsDesktop();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>((params.get('mode') as Mode) || 'add');
  const [camera, setCamera] = useState(() => !desktop && localStorage.getItem('larder.camera') === 'on');
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [looking, setLooking] = useState<Looking>(false);
  const [typed, setTyped] = useState('');
  /** For move and put away: the item waiting for a place. */
  const [pending, setPending] = useState<ProductSummary | null>(null);
  /** Scanning a shelf in add mode makes it the target for the next items. */
  const [target, setTarget] = useState<{ id: string; label: string } | null>(null);
  /** What the AI read from a photo, as a new item to check and add. */
  const [aiDraft, setAiDraft] = useState<AiDraft | null>(null);
  /**
   * The photo the AI is reading (or has read). One taken with the camera stays
   * still in the viewfinder until its card is done, so it's clear the photo was taken.
   */
  const [taken, setTaken] = useState<{ photo: Blob; shot: boolean } | null>(null);
  const takenUrl = usePhotoUrl(taken?.photo);
  /** Set from the press until the reading's back, so a double tap doesn't send two photos. */
  const shooting = useRef(false);
  const places = usePlaces();
  const video = useRef<HTMLVideoElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const { run } = useAction();
  const reader = usePhotoReader();
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const moving = mode === 'move' || mode === 'putaway';
  /**
   * While a card is open the camera holds still, so a second read (or a misread
   * as the phone moves) can't replace what's being entered. Moving is the
   * exception: after the item, it's waiting for the shelf's label.
   */
  const holding = !!looking || !!aiDraft || (!!result && !(pending && moving));
  const hold = useRef(holding);
  hold.current = holding;
  /** The code just dealt with: the camera leaves it alone for a moment, though it may still be in view. */
  const settled = useRef<{ code: string; until: number }>({ code: '', until: 0 });

  const identify = useCallback(async (code: string, from: 'camera' | 'hand' = 'hand') => {
    setLooking('code');
    try {
      const r = await api.identify(code);
      // Waiting for a shelf: the camera catching another item's barcode doesn't change the item.
      if (from === 'camera' && pending && (mode === 'move' || mode === 'putaway') && r.kind !== 'place') return;
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
      // Found online, with Read barcode results with AI on: the AI works out the rest (counted in tea bags, a box of 80).
      const describe = readerRef.current?.describe;
      if (r.kind === 'external' && describe) {
        setLooking('barcode');
        try {
          const reading = await describe(r.result);
          setResult(null);
          setAiDraft({ photo: null, reading, code: r.code, external: r.result, suggestions: r.suggestions });
          return;
        } catch (err) {
          toast({ text: `${err instanceof ApiError ? err.message : "The AI couldn't read it."} Here's what the barcode database says.`, error: true });
        }
      }
      setResult(r);
    } catch (err) {
      toast({ text: err instanceof ApiError ? err.message : 'That code could not be looked up.', error: true });
    } finally {
      setLooking(false);
    }
  }, [mode, pending, run, toast]);

  const { state, error } = useBarcodeScanner(video, camera, (code) => {
    if (hold.current) return;
    if (code === settled.current.code && Date.now() < settled.current.until) return;
    void identify(code, 'camera');
  });

  useEffect(() => {
    const code = params.get('code');
    if (code) {
      void identify(code);
      const next = new URLSearchParams(params);
      next.delete('code');
      setParams(next, { replace: true });
    }
  }, [params, identify, setParams]);

  // Opened from a place ("Scan here", "Put away here"): it's where things go until another shelf is scanned.
  const placeParam = params.get('place');
  useEffect(() => {
    if (!placeParam) return;
    const p = places.find((x) => x.id === placeParam);
    if (!p) return;
    setTarget({ id: p.id, label: p.code ?? p.name });
    const next = new URLSearchParams(params);
    next.delete('place');
    setParams(next, { replace: true });
  }, [placeParam, places, params, setParams]);

  useEffect(() => {
    localStorage.setItem('larder.camera', camera ? 'on' : 'off');
  }, [camera]);

  const done = () => {
    const code = result?.code ?? aiDraft?.code;
    if (code) settled.current = { code, until: Date.now() + 3000 };
    setResult(null);
    setAiDraft(null);
    setTaken(null);
  };

  /**
   * Take photo (or Read it with AI on a new barcode's card): a photo (what the
   * camera sees now, or one uploaded) goes to the AI for its name and details. A
   * barcode in the photo, read here, says first whether it's already in Larder.
   * `keep` is a barcode just scanned that nothing knew.
   */
  async function readWithAi(given?: Blob, keep?: Kept) {
    if (!reader || shooting.current) return;
    const el = given ? null : video.current;
    if (!given && (state !== 'on' || !el)) {
      setCamera(true);
      toast('Starting the camera: point it at the front of the pack, then press Read it with AI again.');
      return;
    }
    shooting.current = true;
    setLooking('photo');
    try {
      const photo = given ?? (await grabFrame(el!));
      if (!given) navigator.vibrate?.(40);
      setTaken({ photo, shot: !given });
      const reading = reader.read(photo);
      reading.catch(() => undefined);
      const barcode = keep?.code ?? (await readBarcode(photo));
      const known = !keep && barcode ? await api.identify(barcode).catch(() => null) : null;
      if (known?.kind === 'product') {
        setResult(known);
        return;
      }
      const r = await reading;
      setResult(null);
      setAiDraft({ photo: r.photo ?? photo, reading: r, code: barcode, external: keep?.external ?? (known?.kind === 'external' ? known.result : null), suggestions: keep?.suggestions ?? (known?.kind === 'external' ? known.suggestions : []) });
    } catch (err) {
      setTaken(null);
      toast({ text: err instanceof ApiError ? err.message : "The photo couldn't be read. Try again.", error: true });
    } finally {
      shooting.current = false;
      setLooking(false);
    }
  }
  const readRef = useRef(readWithAi);
  readRef.current = readWithAi;

  // Add by photo (from Home) arrives with the camera wanted.
  useEffect(() => {
    if (params.get('ai')) {
      setMode('add');
      setCamera(true);
      const next = new URLSearchParams(params);
      next.delete('ai');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  // Space or a volume button is Take photo, like a camera's shutter, when nothing's open.
  useEffect(() => {
    if (!reader || mode !== 'add' || state !== 'on' || holding) return;
    const onKey = (e: KeyboardEvent) => {
      if (![' ', 'AudioVolumeDown', 'AudioVolumeUp', 'VolumeDown', 'VolumeUp', 'Camera'].includes(e.key)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      void readRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reader, mode, state, holding]);

  // What the camera's doing, on the chip at the top of it.
  const [chipIcon, chipText]: [string, string] = looking === 'photo' ? ['sparkle', 'Reading the photo…']
    : looking === 'barcode' ? ['sparkle', 'Working it out…']
    : looking && camera ? ['clock', 'Looking it up…']
    : holding && camera ? ['clock', 'Paused: finish this one first']
    : [MODE_CHIP[mode][0], pending ? `Now scan where ${pending.product.name.toLowerCase()} goes` : target && mode === 'add' ? `Adding to ${target.label}` : target && mode === 'putaway' ? `Putting away in ${target.label}` : MODE_CHIP[mode][1]];
  // Take photo, while the camera's on or starting (the AI reads it): barcodes still scan by themselves.
  const shutter = !!reader && mode === 'add' && camera && state !== 'error';
  const by = reader?.by ?? null;

  return (
    <>
      <Header title="Scan" back="/" />
      <div className={`content ${desktop ? 'scan-grid' : ''}`}>
        <div className="section">
          <Seg label="What a scan does" value={mode} onChange={(m) => { setMode(m); setPending(null); }} options={MODES} />
          <div className="viewfinder" aria-label="Camera">
            <video ref={video} playsInline muted hidden={state !== 'on'} />
            {state === 'on' && taken?.shot && takenUrl && <img className="vf-still" src={takenUrl} alt="The photo you took" />}
            {state === 'on' && <><div className="frame-corners" />{!holding && <div className="line" />}</>}
            <div className="vf-top">
              <span className="vf-chip"><Icon name={chipIcon} size="sm" />{chipText}</span>
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
          {reader && mode === 'add' && (
            <div className="stack" style={{ gap: 8 }}>
              {shutter && (
                <button type="button" className="btn primary block" disabled={state !== 'on' || holding} onClick={() => void readWithAi()}>
                  {looking === 'photo' && taken?.shot ? <><Icon name="sparkle" />Reading the photo…</> : <><Icon name="camera" />Take photo</>}
                </button>
              )}
              <span className="small muted">
                {shutter ? `Barcodes scan by themselves. No barcode? Take a photo of the front of the pack and ${by ?? 'the AI'} names it. ` : `No barcode? ${by ?? 'The AI'} can name it from a photo of the pack. `}
                <button type="button" className="link small" onClick={() => upload.current?.click()}>{shutter ? 'Or upload a photo' : 'Upload a photo'}</button>
              </span>
              <input ref={upload} type="file" accept="image/*" hidden data-testid="scan-upload" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void readWithAi(f); }} />
            </div>
          )}
          <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { void identify(typed.trim()); setTyped(''); } }}>
            <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type a barcode or code like G2-4" aria-label="Barcode or code" inputMode="text" />
            <button className="btn" disabled={!typed.trim() || !!looking}>Look up</button>
          </form>
          <div className="card hint"><Icon name="keyboard" size="sm" /><span>Using a USB or Bluetooth scanner? Just scan on any screen. Larder picks it up and opens the result here.</span></div>
        </div>

        {/* On a phone the result sits at the bottom of the screen, so Add is in reach without scrolling past the camera. */}
        <div className={`section ${looking || result || pending || aiDraft ? 'scan-result' : ''}`}>
          {looking === 'code' && <div className="sheet-card"><div className="row"><div className="spinner" /><span className="muted">Looking it up…</span></div></div>}
          {looking === 'barcode' && (
            <div className="sheet-card">
              <div className="row" style={{ gap: 10 }}><div className="spinner" /><b>Found it online. {by ?? 'The AI'} is working out the details…</b></div>
              <span className="small muted">What it’s counted in, what it comes in, its type and how long it keeps. This takes a few seconds.</span>
            </div>
          )}
          {looking === 'photo' && (
            <div className="sheet-card">
              <div className="match">
                {takenUrl && <span className="tile lg"><img src={takenUrl} alt="" /></span>}
                <div className="item-main">
                  <div className="row" style={{ gap: 10 }}><div className="spinner" /><b>Reading the photo with {by ?? 'the AI'}…</b></div>
                  <span className="small muted">This takes a few seconds.</span>
                </div>
              </div>
            </div>
          )}
          {!looking && aiDraft && (
            <NewItemCard key={aiDraft.code ?? 'photo'} code={aiDraft.code} external={aiDraft.external} suggestions={aiDraft.suggestions} reading={aiDraft.reading} photo={aiDraft.photo ?? undefined}
              mode={mode} target={target} onDone={done} onIdentified={(r) => { setAiDraft(null); setResult(r); }} />
          )}
          {!looking && pending && !result && (
            <div className="sheet-card">
              <div className="match"><ProductTile s={pending} size="lg" /><div className="item-main"><h3>{pending.product.name}</h3><span className="small muted">Scan the shelf label, or pick the place.</span></div></div>
              <MovePicker p={pending} mode={mode} initial={target?.id ?? null} onDone={() => setPending(null)} />
            </div>
          )}
          {!looking && result && !aiDraft && <ResultCard r={result} mode={mode} target={target} onClearTarget={() => setTarget(null)} onDone={done} onIdentified={(r) => setResult(r)} pending={pending} setPending={setPending}
            onReadWithAi={reader ? (keep) => void readWithAi(undefined, keep) : undefined} />}
          {!looking && !result && !pending && !aiDraft && (
            <div className="card empty">
              <b>Ready</b>
              <span className="muted small">
                {mode === 'add' && 'Scan something, then Add, then the next. Scan a shelf label first to put everything after it on that shelf; anything without a place waits in Places → To sort.'}
                {mode === 'use' && 'Scan something you’ve used up.'}
                {mode === 'move' && 'Scan the item you’re taking somewhere, then scan where it’s going. It will show as out of place.'}
                {mode === 'putaway' && (target ? `Scan each item, then Put away: it lives in ${target.label} from now on.` : 'Scan the item, then the shelf it lives on.')}
                {mode === 'look' && 'Scan anything to see what it is and where it lives.'}
              </span>
              {target && (mode === 'add' || mode === 'putaway') && <span className="pill p-wish">{mode === 'add' ? 'Adding to' : 'Putting away in'} {target.label} <button type="button" className="link small" onClick={() => setTarget(null)}>Clear</button></span>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function MovePicker({ p, mode, initial = null, onDone }: { p: ProductSummary; mode: Mode; initial?: string | null; onDone: () => void }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [to, setTo] = useState<string | null>(initial);
  return (
    <div className="inputrow">
      <PlaceSelect value={to} onChange={setTo} places={places} allowNone={false} label="Where it's going" />
      <button type="button" className="btn primary" disabled={!to || busy} onClick={() => run(() => api.stock.move({ productId: p.product.id, toPlaceId: to!, mode: mode === 'putaway' ? 'permanent' : 'temporary' }), mode === 'putaway' ? 'Put away' : 'Moved').then((r) => r && onDone())}>{mode === 'putaway' ? 'Put away' : 'Move'}</button>
    </div>
  );
}

function ResultCard({ r, mode, target, onClearTarget, onDone, onIdentified, pending, setPending, onReadWithAi }: {
  r: IdentifyResult; mode: Mode; target: { id: string; label: string } | null; onClearTarget: () => void; onDone: () => void; onIdentified: (r: IdentifyResult) => void;
  pending: ProductSummary | null; setPending: (p: ProductSummary | null) => void; onReadWithAi?: (keep: Kept) => void;
}) {
  if (r.kind === 'product') return <ProductResult s={r.product} variantName={r.variant?.name ?? null} code={r.code} mode={mode} target={target} onDone={onDone} pending={pending} setPending={setPending} />;
  if (r.kind === 'place') return <PlaceResult place={r.place} path={r.path} mode={mode} onClearTarget={onClearTarget} onDone={onDone} />;
  return (
    <NewItemCard code={r.code} external={r.kind === 'external' ? r.result : null} suggestions={r.kind === 'external' ? r.suggestions : []}
      tried={r.kind === 'unknown' ? r.providersTried : []} failed={r.kind === 'unknown' ? r.providersFailed : []}
      mode={mode} target={target} onDone={onDone} onIdentified={onIdentified}
      onReadWithAi={onReadWithAi && r.kind === 'unknown' ? () => onReadWithAi({ code: r.code, external: null, suggestions: [] }) : undefined} />
  );
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
        <MovePicker p={s} mode={mode} initial={target?.id ?? null} onDone={() => { setPending(null); onDone(); }} />
      </div>
    );
  }
  const use = mode === 'use';
  const available = s.product.rechargeable ? (s.charged ?? 0) : s.inStock;
  // Add and Use count whole ones of what it's bought in: the barcode is on the box.
  const added = qty(n, s.product.unit);
  return (
    <div className="sheet-card">
      {header}
      <p className="small"><span className="pill p-ok">In Larder</span> <span className="muted">You have {stockText(s)}.{s.status.low ? ' Running low.' : ''}</span></p>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>{plural(s.product.unit, 2) ? `How many ${plural(s.product.unit, 2)}?` : 'How many?'}</b><Stepper value={n} onChange={setN} min={0.1} max={use ? Math.max(available, 0.1) : 99999} label="quantity" /></div>
      {!use && <WhereLine placeId={placeId} onChange={setPlaceId} places={places} />}
      <div className="btnrow">
        <button type="button" className="btn" onClick={onDone}>Skip</button>
        <button type="button" className="btn primary" disabled={busy || (use && available <= 0)} onClick={() => run(
          () => (use ? api.stock.use({ productId: s.product.id, quantity: n }) : api.stock.add({ productId: s.product.id, quantity: n, placeId })),
          (x) => `${use ? (s.product.rechargeable ? 'Marked flat' : 'Used') : 'Added'} ${use ? qty(n, s.product.unit) : added} · ${stockText(x)} now. Ready for the next scan.`,
        ).then((x) => x && onDone())}>
          {use ? (s.product.rechargeable ? `Mark ${n} flat` : `Use ${qty(n, s.product.unit)}`) : `Add ${added}`}
        </button>
      </div>
    </div>
  );
}

/**
 * Where scanned stock goes, as a line rather than a picker: the shelf scanned
 * last, or the item's usual place. "Change" opens the picker for the odd one;
 * anything without a place can be sorted later (Places → To sort).
 */
function WhereLine({ placeId, onChange, places }: { placeId: string | null; onChange: (id: string | null) => void; places: ReturnType<typeof usePlaces> }) {
  const [open, setOpen] = useState(false);
  const place = places.find((p) => p.id === placeId);
  if (open) return <label className="field"><span>Where</span><PlaceSelect value={placeId} onChange={(v) => { onChange(v); setOpen(false); }} places={places} /></label>;
  return (
    <p className="small muted" style={{ margin: 0 }}>
      {place ? <>Goes to <b style={{ color: 'var(--ink)' }}>{place.path}</b>.</> : 'No place yet: it waits in Places → To sort.'}{' '}
      <button type="button" className="link small" onClick={() => setOpen(true)}>{place ? 'Change' : 'Choose'}</button>
    </p>
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

/** Lookup providers by the names people know them by. */
const PROVIDER_NAMES: Record<string, string> = { openfoodfacts: 'Open Food Facts', openbeautyfacts: 'Open Beauty Facts', openproductsfacts: 'Open Products Facts' };

/** A photo still on the phone, as an address for an <img>, tidied away afterwards. */
function usePhotoUrl(photo: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!photo) return;
    const u = URL.createObjectURL(photo);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [photo]);
  return photo ? url : null;
}

/**
 * Something new to Larder, from a barcode (found online, or not) and/or a photo
 * the AI read: named, remembered and added in one press, then on to the next.
 */
function NewItemCard({ code, external, suggestions, tried = [], failed = [], reading, photo, mode, target, onDone, onIdentified, onReadWithAi }: {
  code: string | null; external: LookupResult | null; suggestions: ProductSummary[]; tried?: string[]; failed?: string[];
  reading?: PhotoReading; photo?: Blob; mode: Mode; target: { id: string; label: string } | null;
  onDone: () => void; onIdentified: (r: IdentifyResult) => void; onReadWithAi?: () => void;
}) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const photoUrl = usePhotoUrl(photo);
  const units = useUnits();
  const [name, setName] = useState(reading?.name ?? external?.name ?? '');
  const [choice, setChoice] = useState<string>(suggestions[0] ? suggestions[0].product.id : 'new');
  // Bought in, and what one contains as the AI or the barcode database read it ("400 g", "20 tea bags"): is it a box or a weight?
  const printed = parseAmount(units, external?.quantityText);
  const [boughtIn, setBoughtIn] = useState<string>(reading?.boughtIn ?? 'each');
  const [contents, setContents] = useState<{ amount: number; unit: string } | null>(reading?.contents ?? (printed ? { amount: printed.amount, unit: printed.unit } : null));
  // A multipack of separate things is that many added: a 4-pack of tins is 4 tins.
  const [n, setN] = useState(printed && printed.count > 1 ? printed.count : 1);
  const [placeId, setPlaceId] = useState<string | null>(target?.id ?? null);
  const [shopId, setShopId] = useState<string | null>(reading?.shop?.id ?? null);
  const dq = useDebounced(name.trim(), 250);
  const { data } = useQuery({ queryKey: ['search', dq], queryFn: () => api.search(dq), enabled: !external && dq.length > 2 });
  // The plain kind the AI gave ("Herbal tea") finds an item the household keeps for any brand of it.
  const kind = reading?.kind?.trim() ?? '';
  const byKind = useQuery({ queryKey: ['search', kind], queryFn: () => api.search(kind), enabled: !external && kind.length > 2 });
  const stockIn = (r: typeof data) => r?.sections.find((s) => s.id === 'stock')?.results.map((x) => x.product!).filter(Boolean) ?? [];
  // Turn about, so the best match for the kind isn't pushed out by near matches for the name.
  const byName = stockIn(data);
  const forKind = stockIn(byKind.data);
  const candidates: ProductSummary[] = external ? suggestions
    : Array.from({ length: Math.max(byName.length, forKind.length) }, (_, i) => [byName[i], forKind[i]]).flat()
      .filter((c, i, all): c is ProductSummary => !!c && all.findIndex((x) => x?.product.id === c.product.id) === i).slice(0, 3);
  const brand = reading?.brand ?? (external ? [external.brand, external.name, external.quantityText].filter(Boolean).join(' ') : null);
  const adding = mode === 'add';
  const into = choice !== 'new' ? candidates.find((c) => c.product.id === choice) : undefined;
  // Add counts whole ones of what it's bought in: the item's, or what's picked here for a new one.
  const unit = into ? into.product.unit : boughtIn;
  const fits = !!contents && contents.unit !== boughtIn && !isLoose(units, { unit: boughtIn });

  /** A shop's own brand Larder doesn't have: add the shop, so this goes on its list. */
  async function addShop(shop: NonNullable<PhotoReading['shop']>) {
    const made = await run(() => (shop.preset ? api.shops.addPreset(shop.name) : api.shops.create({ name: shop.name, sells: reading?.categoryId ? [reading.categoryId] : [] })), `${shop.name} added to your shops`);
    if (made) setShopId(made.id);
  }

  /** Remembers the barcode (or makes the item), keeps the photo, and when adding, adds the stock too: one press. */
  async function save() {
    const fields = {
      name: name.trim(),
      unit: boughtIn,
      contents: fits ? contents : null,
      ...(reading ? { categoryId: reading.categoryId, shelfLifeDays: reading.shelfLifeDays, aliases: reading.aliases } : {}),
      preferredShopIds: shopId ? [shopId] : [],
    };
    const res = await run(async () => {
      let productId: string;
      let variantId: string | null = null;
      let identified: IdentifyResult | null = null;
      if (code) {
        const rem = await api.remember({
          barcode: code, productId: into?.product.id, create: into ? undefined : fields, variantName: brand || name.trim(),
          imageUrl: external?.imageUrl ?? null, source: external?.provider ?? reading?.by.toLowerCase(),
        });
        productId = rem.product.product.id;
        variantId = rem.variant.id;
        identified = { kind: 'product', code, product: rem.product, variant: rem.variant };
      } else {
        productId = into ? into.product.id : (await api.products.create(fields)).id;
        if (brand) variantId = (await api.products.addVariant(productId, { name: brand, source: reading?.by.toLowerCase() ?? 'local' })).id;
      }
      // The photo the AI read becomes the item's photo, if it hasn't one, and this brand's.
      if (photo) {
        const { id } = await api.files.upload(new File([photo], 'photo.jpg', { type: photo.type || 'image/jpeg' }));
        const item = await api.products.get(productId);
        if (!item.product.photoFileIds.length) await api.products.update(productId, { photoFileIds: [id] });
        if (variantId && !item.variants.find((v) => v.id === variantId)?.photoFileId) await api.products.updateVariant(variantId, { photoFileId: id });
      }
      const after = adding ? await api.stock.add({ productId, quantity: n, placeId }) : null;
      return { identified, after, productId };
    }, (x) => (adding && x.after ? `Added ${qty(n, x.after.product.unit)} · ${x.after.product.name}. Ready for the next scan.` : 'Saved. Next time this barcode is instant.'));
    if (!res) return;
    if (adding || !res.identified) onDone();
    else onIdentified(res.identified);
  }

  const tile = photoUrl ?? external?.imageUrl ?? null;
  return (
    <div className="sheet-card">
      <div className="match">
        <span className="tile lg">{tile ? <img src={tile} alt="" /> : <Icon name={external ? 'scan' : 'info'} size="lg" />}</span>
        <div className="item-main">
          <h3>{brand || (external ? [external.brand, external.name].filter(Boolean).join(' ') : reading ? reading.name : 'New to Larder')}</h3>
          <div className="src">{external?.quantityText && <span>{external.quantityText}</span>}{code && <code>{code}</code>}</div>
        </div>
      </div>
      <p className="small">
        <span className="pill p-wish">New</span>{' '}
        <span className="muted">
          {reading ? (
            <>
              {photo ? `Read from the photo by ${reading.by}` : `Found in ${external ? PROVIDER_NAMES[external.provider] ?? external.provider : 'a barcode database'}, worked out by ${reading.by}`}
              {reading.sources?.length ? <>, looked up on {reading.sources.map((x, i, all) => (
                <Fragment key={x.url}>{i ? (i === all.length - 1 ? ' and ' : ', ') : ''}<a href={x.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{x.name}</a></Fragment>
              ))}</> : null}
              .{reading.notes.map((x) => ` ${x}`).join('')}{reading.readable ? ' Check the name.' : " It couldn't make it out: check the name."}

            </>
          ) : external ? `Not in Larder yet. Found in ${PROVIDER_NAMES[external.provider] ?? external.provider}.` : (
            <>
              {tried.length ? `${tried.join(', ')} ${tried.length === 1 ? "doesn't" : "don't"} know this barcode. ` : ''}
              {failed.length ? `Couldn't reach ${failed.join(', ')} just now. ` : ''}
              {!tried.length && !failed.length ? "Larder doesn't know this code yet. " : ''}
              Name it once and Larder will remember it.
            </>
          )}
        </span>
      </p>
      {onReadWithAi && (
        <button type="button" className="btn small" style={{ justifySelf: 'start' }} disabled={busy} onClick={onReadWithAi}>
          <Icon name="sparkle" size="sm" />Read it with AI
        </button>
      )}
      <label className="field"><span>{external || reading ? 'Call it' : 'What is it?'}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!external && !reading}
        onKeyDown={(e) => { if (e.key === 'Enter' && !busy && (choice !== 'new' || name.trim())) void save(); }} /></label>
      {candidates.length > 0 && (
        <div className="field"><span>Is it a brand of something you already have?</span>
          <div className="stack" style={{ gap: 8 }}>
            {candidates.map((c) => (
              <button key={c.product.id} type="button" className={`choice ${choice === c.product.id ? 'on' : ''}`} onClick={() => setChoice(c.product.id)}>
                <span className="radio" /><span className="item-main"><span className="item-name">{c.product.name}</span><span className="item-meta">You have {stockText(c)} · adds this as a brand</span></span>
              </button>
            ))}
            <button type="button" className={`choice ${choice === 'new' ? 'on' : ''}`} onClick={() => setChoice('new')}><span className="radio" /><span className="item-main"><span className="item-name">No, it’s something new</span><span className="item-meta">Creates “{name.trim() || 'a new item'}”</span></span></button>
          </div>
        </div>
      )}
      {choice === 'new' && (
        <div className="field"><span>Bought in</span>
          <div className="chips wrap">
            {CHIPS.map((k) => <button key={k} type="button" className={`chip ${boughtIn === k ? 'on' : ''}`} aria-pressed={boughtIn === k} onClick={() => setBoughtIn(k)}>{units.find(k)?.one ?? k}</button>)}
            {!CHIPS.includes(boughtIn) && <span className="chip on">{units.find(boughtIn)?.one ?? boughtIn}</span>}
            <UnitPicker value={null} onChange={setBoughtIn} kinds={['count', 'weight', 'volume']} exclude={notBoughtIn(units)} label="Bought in" empty="More…" />
          </div>
          {!isLoose(units, { unit: boughtIn }) && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="small">Each {boughtIn === 'each' ? 'one' : (units.find(boughtIn)?.one ?? boughtIn)} contains</span>
              <input className="input" type="number" inputMode="decimal" min={0} step="any" style={{ width: 90 }} value={contents?.amount ?? ''} aria-label="How much one contains" placeholder="20"
                onChange={(e) => setContents(Number(e.target.value) > 0 ? { amount: Number(e.target.value), unit: contents?.unit ?? 'g' } : null)} />
              <UnitPicker value={contents?.unit ?? null} onChange={(k) => setContents({ amount: contents?.amount ?? 1, unit: k })} kinds={['count', 'weight', 'volume']} exclude={['each', boughtIn]} label="What it contains" empty="Pick a unit" />
              {contents && !fits && <small style={{ color: 'var(--low)' }}>A {units.find(boughtIn)?.one ?? boughtIn} can't contain {plural(contents.unit, 2)}.</small>}
            </div>
          )}
        </div>
      )}
      {reading?.shop && !shopId && choice === 'new' && (
        <p className="small muted" style={{ margin: 0 }}>{reading.shop.name}’s own brand, and {reading.shop.name} isn’t one of your shops. <button type="button" className="link small" disabled={busy} onClick={() => void addShop(reading.shop!)}>Add {reading.shop.name}</button></p>
      )}
      {adding && (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}><b>{plural(unit, 2) ? `How many ${plural(unit, 2)}?` : 'How many?'}</b><Stepper value={n} onChange={setN} min={0.1} max={99999} label="quantity" /></div>
          <WhereLine placeId={placeId} onChange={setPlaceId} places={places} />
        </>
      )}
      <div className="btnrow">
        <button type="button" className="btn" onClick={onDone}>Skip</button>
        <button type="button" className="btn primary" disabled={busy || (choice === 'new' && !name.trim())} onClick={() => void save()}>
          {adding ? `Add ${qty(n, unit)}${into ? ` to ${into.product.name}` : ''}` : 'Save and continue'}
        </button>
      </div>
    </div>
  );
}
