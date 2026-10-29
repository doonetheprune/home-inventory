/** Label sheets: pick what to label and a sheet layout, then print. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, defineWebModule, Empty, Header, Icon, Loading, PrintSetup, QrCode, useQuery } from '@larder/web-sdk';

interface Label { kind: 'place' | 'product'; id: string; code: string | null; title: string; subtitle: string }
interface Area { id: string; name: string; path: string; labels: number }

/** Sheet layouts in millimetres, from the label makers' templates (A4). */
const LAYOUTS = {
  l7160: { name: 'Avery L7160 · 21 per sheet · 63.5 × 38.1 mm', cols: 3, rows: 7, w: 63.5, h: 38.1, top: 15.15, left: 7.25, gapX: 2.5, gapY: 0, cut: false },
  l7163: { name: 'Avery L7163 · 14 per sheet · 99.1 × 38.1 mm', cols: 2, rows: 7, w: 99.1, h: 38.1, top: 15.15, left: 4.65, gapX: 2.5, gapY: 0, cut: false },
  l7651: { name: 'Avery L7651 · 65 per sheet · 38.1 × 21.2 mm', cols: 5, rows: 13, w: 38.1, h: 21.2, top: 10.7, left: 4.75, gapX: 2.5, gapY: 0, cut: false },
  plain: { name: 'Plain A4 with cut lines · 24 per sheet', cols: 3, rows: 8, w: 70, h: 37.125, top: 0, left: 0, gapX: 0, gapY: 0, cut: true },
} as const;
type LayoutId = keyof typeof LAYOUTS;
const MM = 96 / 25.4;

/** What the QR holds: a link when Larder has a public address, else Larder's own code (its scanner reads both). */
function qrValue(l: Label, base: string | null): string {
  if (base) return `${base}/#/${l.kind === 'place' ? 'places' : 'products'}/${l.id}`;
  return `larder:${l.kind}:${l.id}`;
}

function Sheet({ labels, layout, base }: { labels: Label[]; layout: LayoutId; base: string | null }) {
  const L = LAYOUTS[layout];
  const small = L.h < 25;
  const qr = Math.min(L.h - (small ? 3 : 6), 30);
  return (
    <div className="label-sheet" style={{ width: '210mm', height: '297mm', position: 'relative', background: '#fff', breakAfter: 'page', overflow: 'hidden' }}>
      {labels.map((l, i) => {
        const col = i % L.cols;
        const row = Math.floor(i / L.cols);
        return (
          <div key={`${l.kind}:${l.id}`} style={{
            position: 'absolute', left: `${L.left + col * (L.w + L.gapX)}mm`, top: `${L.top + row * (L.h + L.gapY)}mm`, width: `${L.w}mm`, height: `${L.h}mm`,
            display: 'flex', alignItems: 'center', gap: small ? '1.5mm' : '3mm', padding: small ? '1mm 1.5mm' : '3mm', boxSizing: 'border-box', color: '#000',
            outline: L.cut ? '0.2mm dashed #999' : undefined, outlineOffset: L.cut ? '-0.1mm' : undefined,
          }}>
            <QrCode value={qrValue(l, base)} size={`${qr}mm`} title={l.code ?? l.title} />
            <div style={{ minWidth: 0, display: 'grid', gap: '0.5mm' }}>
              <b style={{ fontFamily: 'var(--f-mono)', fontSize: small ? '9pt' : l.code ? '15pt' : '10pt', lineHeight: 1.05, overflowWrap: 'anywhere' }}>{l.code ?? l.title}</b>
              {!small && l.code && <span style={{ fontSize: '7.5pt', lineHeight: 1.15 }}>{l.title}</span>}
              {!small && l.subtitle && <span style={{ fontSize: '6.5pt', color: '#444', lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.subtitle}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LabelSheets() {
  const areas = useQuery({ queryKey: ['printing', 'areas'], queryFn: () => api.modules.call<Area[]>('printing', 'GET', '/areas') });
  const server = useQuery({ queryKey: ['settings', 'server'], queryFn: api.settings.server, staleTime: 60_000 });
  const products = useQuery({ queryKey: ['products', 'list', {}], queryFn: () => api.products.list() });
  const [area, setArea] = useState<string | 'items' | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [layout, setLayout] = useState<LayoutId>(() => ((typeof localStorage !== 'undefined' && localStorage.getItem('larder.labelLayout')) as LayoutId) || 'l7160');
  useEffect(() => {
    try { localStorage.setItem('larder.labelLayout', layout); } catch { /* private window: fine */ }
  }, [layout]);
  const selected = area ?? areas.data?.[0]?.id ?? 'items';
  const labelsQuery = useQuery({
    queryKey: ['printing', 'labels', selected, chosen],
    queryFn: () => api.modules.call<Label[]>('printing', 'GET', `/labels?${new URLSearchParams(selected === 'items' ? { products: chosen.join(',') } : { place: selected })}`),
    enabled: selected !== 'items' || chosen.length > 0,
  });
  const labels = selected === 'items' && !chosen.length ? [] : labelsQuery.data ?? [];
  const L = LAYOUTS[layout];
  const perSheet = L.cols * L.rows;
  const sheets = useMemo(() => Array.from({ length: Math.ceil(labels.length / perSheet) }, (_, i) => labels.slice(i * perSheet, (i + 1) * perSheet)), [labels, perSheet]);

  // Shrink the preview to fit the screen; printing uses real millimetres.
  const wrap = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.6);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setZoom(Math.min(1, (el.clientWidth - 36) / (210 * MM))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const matching = (products.data ?? []).filter((s) => !filter.trim() || s.product.name.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 40);

  return (
    <>
      <PrintSetup margin="0" />
      <Header title="Label sheets" back="/more">
        <button type="button" className="iconbtn" aria-label="Print" onClick={() => window.print()} disabled={!labels.length}><Icon name="print" /></button>
      </Header>
      <div className="content print-layout">
        <div className="stack" style={{ alignContent: 'start' }}>
          <div className="label">Labels for</div>
          <div className="chips wrap">
            {(areas.data ?? []).map((a) => (
              <button type="button" key={a.id} className={`chip ${selected === a.id ? 'on' : ''}`} onClick={() => setArea(a.id)}>{a.name}<span className="n">{a.labels + 1}</span></button>
            ))}
            <button type="button" className={`chip ${selected === 'items' ? 'on' : ''}`} onClick={() => setArea('items')}>Chosen items<span className="n">{chosen.length}</span></button>
          </div>
          {selected === 'items' && (
            <div className="card">
              <div style={{ padding: 10 }}><input className="input" placeholder="Find items" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find items to label" /></div>
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {matching.map((s) => (
                  <label key={s.product.id} className="toggle" style={{ cursor: 'pointer' }}>
                    <span>{s.product.name}<br /><span className="small muted">{s.places[0]?.path ?? s.category?.name ?? ''}</span></span>
                    <input type="checkbox" checked={chosen.includes(s.product.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s.product.id] : chosen.filter((x) => x !== s.product.id))} />
                  </label>
                ))}
              </div>
            </div>
          )}
          <label className="field"><span>Sheet layout</span>
            <select className="input" value={layout} onChange={(e) => setLayout(e.target.value as LayoutId)}>
              {(Object.keys(LAYOUTS) as LayoutId[]).map((id) => <option key={id} value={id}>{LAYOUTS[id].name}</option>)}
            </select>
          </label>
          <p className="small muted">
            {labels.length} label{labels.length === 1 ? '' : 's'} · {sheets.length} sheet{sheets.length === 1 ? '' : 's'}. Each QR opens that place or item in Larder{server.data?.baseUrl ? ', from Larder\'s scanner or a phone\'s camera' : ' from Larder\'s scanner (set LARDER_BASE_URL so phone cameras open them too)'}.
            Print at 100% scale with no margins.
          </p>
          <button type="button" className="btn primary block" disabled={!labels.length} onClick={() => window.print()}><Icon name="print" size="sm" />Print</button>
        </div>
        <div className="paper-wrap" ref={wrap}>
          {areas.isLoading || labelsQuery.isFetching ? <Loading /> : !labels.length ? <Empty title="Nothing to label yet"><span className="small muted">{selected === 'items' ? 'Tick the items to label.' : 'Pick what to label.'}</span></Empty> : (
            <div className="print-area" style={{ zoom }}>
              {sheets.map((page, i) => <div key={i} className="paper" style={{ width: '210mm', maxWidth: 'none', marginBottom: 16, padding: 0, minHeight: 0 }}><Sheet labels={page} layout={layout} base={server.data?.baseUrl ?? null} /></div>)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default defineWebModule({
  id: 'printing',
  pages: [{ path: '/', title: 'Label sheets', icon: 'print', section: 'print', subtitle: 'QR labels for boxes and shelves', component: LabelSheets }],
});
