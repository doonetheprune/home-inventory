/** Small shared UI pieces and hooks. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { PlaceRef, ProductSummary } from '@larder/core';
import { api, ApiError } from './api';
import { Icon } from './icons';
import { statusPills, stockText } from './format';

/* ---------- toasts ---------- */
interface ToastMsg { text: string; error?: boolean; action?: { label: string; run: () => void } }
const ToastCtx = createContext<(t: ToastMsg | string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const [show, setShow] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const toast = useCallback((t: ToastMsg | string) => {
    setMsg(typeof t === 'string' ? { text: t } : t);
    setShow(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShow(false), typeof t !== 'string' && t.action ? 5000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className={`toast ${show ? 'show' : ''} ${msg?.error ? 'err' : ''}`} role="status" aria-live="polite">
        <span>{msg?.text}</span>
        {msg?.action && (
          <button type="button" onClick={() => { msg.action!.run(); setShow(false); }}>{msg.action.label}</button>
        )}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an async action: shows errors as toasts and refreshes data afterwards. */
export function useAction() {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string | ((r: T) => string | undefined)): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        const text = typeof success === 'function' ? success(r) : success;
        if (text) toast(text);
        await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
        return r;
      } catch (err) {
        toast({ text: err instanceof ApiError ? err.message : 'Something went wrong.', error: true });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [qc, toast],
  );
  return { run, busy };
}

/* ---------- hooks ---------- */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useIsDesktop(): boolean {
  const q = '(min-width: 900px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

/** Live updates: refresh data whenever the server says something changed. */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let timer: number | undefined;
    const es = new EventSource('api/v1/events');
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' }), 250);
    };
    for (const t of ['stock.changed', 'product.created', 'product.updated', 'product.deleted', 'place.changed', 'shop.changed', 'category.changed', 'settings.changed']) es.addEventListener(t, refresh);
    return () => {
      es.close();
      window.clearTimeout(timer);
    };
  }, [enabled, qc]);
}

/** Lists that most forms need. */
export function usePlaces() {
  return useQuery({ queryKey: ['places', 'list'], queryFn: api.places.list, staleTime: 30_000 }).data ?? [];
}
export function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: api.categories.list, staleTime: 60_000 }).data ?? [];
}
export function useShops() {
  return useQuery({ queryKey: ['shops'], queryFn: api.shops.list, staleTime: 60_000 }).data ?? [];
}
export function useModules() {
  return useQuery({ queryKey: ['modules'], queryFn: api.modules.list, staleTime: 60_000 }).data ?? [];
}

/* ---------- components ---------- */
export function Header({ title, back, children }: { title: string; back?: string | true; children?: ReactNode }) {
  return (
    <header className="hdr">
      {back && (
        back === true ? (
          <button type="button" className="iconbtn ghost" aria-label="Back" onClick={() => history.back()}><Icon name="back" /></button>
        ) : (
          <Link className="iconbtn ghost" to={back} aria-label="Back"><Icon name="back" /></Link>
        )
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function Loading() {
  return <div className="loading"><div className="spinner" aria-label="Loading" /></div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="error">{error instanceof Error ? error.message : 'Something went wrong.'}</div>;
}

export function Pill({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`pill p-${kind}`}>{children}</span>;
}

export function StatusPills({ s }: { s: ProductSummary }) {
  const pills = statusPills(s);
  if (!pills.length) return null;
  return <span className="pills">{pills.map((p) => <Pill key={p.text} kind={p.kind}>{p.text}</Pill>)}</span>;
}

export function categoryIcon(s: Pick<ProductSummary, 'category' | 'product'>): string {
  if (s.product.rechargeable) return 'battery';
  return s.category?.icon ?? 'box';
}

export function ProductTile({ s, size }: { s: ProductSummary; size?: 'lg' }) {
  const photo = s.product.photoFileIds[0];
  return (
    <span className={`tile ${size ?? ''}`}>
      {photo ? <img src={api.files.url(photo)} alt="" loading="lazy" /> : <Icon name={categoryIcon(s)} size={size} />}
    </span>
  );
}

export function PlaceText({ p }: { p: PlaceRef | null | undefined }) {
  if (!p) return <span className="muted">No place set</span>;
  const parent = p.path.split(' › ').slice(0, -1).join(' › ');
  return (
    <>
      {parent ? `${parent} › ` : ''}
      {p.name}
      {p.code ? <> <code>{p.code}</code></> : null}
    </>
  );
}

/** A product as a row in a list. */
export function ProductRow({ s, to, meta, side }: { s: ProductSummary; to?: string; meta?: ReactNode; side?: ReactNode }) {
  const body = (
    <>
      <ProductTile s={s} />
      <span className="item-main">
        <span className="item-name">{s.product.name}</span>
        <span className="item-meta">{meta ?? (s.places[0] ? <PlaceText p={s.places[0]} /> : s.category?.name ?? '')}</span>
      </span>
      <span className="item-side">{side ?? <><span className="qty">{stockText(s)}</span><StatusPills s={s} /></>}</span>
    </>
  );
  return to === undefined ? <div className="item">{body}</div> : <Link className="item" to={to}>{body}</Link>;
}

export function Stepper({ value, onChange, min = 0, max = 99999, step = 1, label, small }: { value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; label: string; small?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const set = (n: number) => onChange(Math.min(max, Math.max(min, Math.round(n * 1000) / 1000)));
  return (
    <span className={`stepper ${small ? 'sm' : ''}`}>
      <button type="button" aria-label={`Less ${label}`} onClick={() => set(value - step)} disabled={value <= min}><Icon name="minus" size="sm" /></button>
      <input aria-label={label} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => { const n = Number(text); if (!Number.isNaN(n)) set(n); else setText(String(value)); }} />
      <button type="button" aria-label={`More ${label}`} onClick={() => set(value + step)} disabled={value >= max}><Icon name="plus" size="sm" /></button>
    </span>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

export function PlaceSelect({ value, onChange, places, allowNone = true, label = 'Place', id }: { value: string | null; onChange: (v: string | null) => void; places: PlaceRef[]; allowNone?: boolean; label?: string; id?: string }) {
  return (
    <select id={id} className="input" aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">No place</option>}
      {places.map((p) => <option key={p.id} value={p.id}>{p.path}{p.code ? ` (${p.code})` : ''}</option>)}
    </select>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grip" />
        <div className="row"><h2 className="grow">{title}</h2><button type="button" className="iconbtn ghost" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="card empty"><b>{title}</b>{children}</div>;
}
