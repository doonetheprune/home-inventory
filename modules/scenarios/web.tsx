/** Scenarios UI: the list, a scenario by place, its printable page, and a panel on product pages. */
import { useState } from 'react';
import {
  api, defineWebModule, Empty, Header, Icon, Link, Loading, Pill, PrintSetup, qty, Switch, useAction, useModuleParams, useNavigate, useQuery, type ProductDetail,
} from '@larder/web-sdk';

interface Scenario { id: string; name: string; icon: string; notes: string }
interface Counts { items: number; places: number; low: number; wish: number }
interface Line { productId: string; name: string; quantity: number; unit: string; note: string | null; low: boolean; category: string | null; visiting: boolean }
interface Group { place: { id: string; name: string; path: string; code: string | null; photoFileId: string | null } | null; items: Line[] }
interface Detail { scenario: Scenario; counts: Counts; groups: Group[]; missing: Array<{ productId: string; name: string; low: boolean }>; wish: Array<{ productId: string; name: string; notes: string }> }

const ICONS = ['zap', 'gift', 'drop', 'shield', 'paw', 'layers'];
const call = <T,>(method: string, path: string, body?: unknown) => api.modules.call<T>('scenarios', method, path, body);
const useList = () => useQuery({ queryKey: ['scenarios'], queryFn: () => call<Array<Scenario & { counts: Counts }>>('GET', '/') });
const useDetail = (id: string) => useQuery({ queryKey: ['scenarios', id], queryFn: () => call<Detail>('GET', `/${id}`) });
const countText = (c: Counts) => [`${c.items} item${c.items === 1 ? '' : 's'}`, c.low ? `${c.low} low` : null, c.wish ? `${c.wish} wished for` : null].filter(Boolean).join(' · ');

function ScenarioList() {
  const list = useList();
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const create = async () => {
    const s = await run(() => call<Scenario>('POST', '/', { name: name.trim() }), 'Scenario made');
    if (s) navigate(`/m/scenarios/${s.id}`);
  };
  return (
    <>
      <Header title="Scenarios" back="/more" />
      <div className="content" style={{ maxWidth: 760 }}>
        <p className="muted small">Lists for situations: a power cut, Christmas, the dog sitter. Each shows every item, how many and where, ready to print.</p>
        {list.isLoading ? <Loading /> : list.data?.length ? (
          <div className="list">
            {list.data.map((s) => (
              <Link key={s.id} className="item" to={`/m/scenarios/${s.id}`}>
                <span className="tile"><Icon name={ICONS.includes(s.icon) ? s.icon : 'layers'} /></span>
                <span className="item-main"><span className="item-name">{s.name}</span><span className="item-meta">{countText(s.counts)}</span></span>
                <Icon name="chev" size="sm" />
              </Link>
            ))}
          </div>
        ) : <Empty title="No scenarios yet"><span className="small muted">Make one, then add items to it from their pages.</span></Empty>}
        <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
          <input className="input" placeholder="New scenario, e.g. Power cut" value={name} onChange={(e) => setName(e.target.value)} aria-label="New scenario name" />
          <button className="btn primary" disabled={busy || !name.trim()}><Icon name="plus" size="sm" />Make</button>
        </form>
      </div>
    </>
  );
}

function ScenarioPage() {
  const { id } = useModuleParams();
  const d = useDetail(id!);
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  if (d.isLoading) return <Loading />;
  if (!d.data) return <><Header title="Scenario" back="/m/scenarios" /><div className="content"><Empty title="That scenario no longer exists" /></div></>;
  const { scenario, counts, groups, missing, wish } = d.data;
  return (
    <>
      <Header title={scenario.name} back="/m/scenarios">
        <Link className="iconbtn" to={`/m/scenarios/${scenario.id}/print`} aria-label="Print this scenario"><Icon name="print" /></Link>
      </Header>
      <div className="content">
        <div className="stats">
          <div className="stat"><b>{counts.items}</b><span>Items</span></div>
          <div className="stat low"><b>{counts.low}</b><span>Low</span></div>
          <div className="stat"><b style={{ color: 'var(--accent)' }}>{counts.wish}</b><span>Wish list</span></div>
        </div>
        {scenario.notes && <div className="card pad small">{scenario.notes}</div>}
        {!groups.length && !missing.length && !wish.length && <Empty title="Nothing in it yet"><span className="small muted">Open an item and tick this scenario under Scenarios.</span></Empty>}
        <div className="cols-2">
          {groups.map((g) => (
            <div className="section" key={g.place?.id ?? 'none'}>
              <div className="label" style={{ display: 'flex', justifyContent: 'space-between' }}>
                {g.place ? <Link to={`/places/${g.place.id}`}>{g.place.path}</Link> : 'No place set'}
                {g.place?.code && <span className="mono">{g.place.code}</span>}
              </div>
              <div className="list">
                {g.items.map((i) => (
                  <Link className="item" key={i.productId} to={`/products/${i.productId}`}>
                    <span className="item-main">
                      <span className="item-name">{i.name}</span>
                      {(i.visiting || i.category) && <span className="item-meta">{i.visiting ? 'Only here for now' : i.category}</span>}
                    </span>
                    <span style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
                      <span className="qty">{qty(i.quantity, i.unit)}</span>
                      {i.note && (i.low ? <Pill kind="low">{i.note}</Pill> : <span className="small muted">{i.note}</span>)}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
          {missing.length > 0 && (
            <div className="section">
              <div className="label">None in the house</div>
              <div className="list">
                {missing.map((m) => (
                  <Link className="item" key={m.productId} to={`/products/${m.productId}`}>
                    <span className="item-main"><span className="item-name">{m.name}</span></span>
                    {m.low ? <Pill kind="low">On the list</Pill> : <span className="qty">0</span>}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {wish.length > 0 && (
            <div className="section">
              <div className="label" style={{ display: 'flex', justifyContent: 'space-between' }}>On the wish list <Link to="/wishlist">Wish list</Link></div>
              <div className="list">
                {wish.map((w) => (
                  <Link className="item" key={w.productId} to={`/products/${w.productId}`}>
                    <span className="tile"><Icon name="heart" /></span>
                    <span className="item-main"><span className="item-name">{w.name}</span>{w.notes && <span className="item-meta">{w.notes}</span>}</span>
                    <Pill kind="wish">Wished</Pill>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="card pad">
          <b>Remove {scenario.name}</b>
          <p className="small muted">The items stay in Larder; they just leave this scenario.</p>
          {confirm ? (
            <div className="btnrow">
              <button type="button" className="btn" onClick={() => setConfirm(false)}>Keep it</button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => call('DELETE', `/${scenario.id}`), 'Removed').then((r) => r !== undefined && navigate('/m/scenarios', { replace: true }))}>Yes, remove it</button>
            </div>
          ) : <button type="button" className="btn danger" onClick={() => setConfirm(true)}><Icon name="trash" size="sm" />Remove</button>}
        </div>
      </div>
    </>
  );
}

function PrintScenario() {
  const { id } = useModuleParams();
  const d = useDetail(id!);
  const [photos, setPhotos] = useState(true);
  if (d.isLoading) return <Loading />;
  if (!d.data) return <><Header title="Scenario" back="/m/scenarios" /><div className="content"><Empty title="That scenario no longer exists" /></div></>;
  const { scenario, counts, groups, missing } = d.data;
  const anyPhotos = groups.some((g) => g.place?.photoFileId);
  const printed = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <>
      <PrintSetup margin="12mm" />
      <Header title={`${scenario.name} page`} back={`/m/scenarios/${scenario.id}`} />
      <div className="content print-layout">
        <div className="stack" style={{ alignContent: 'start' }}>
          <div className="card">
            <div className="toggle"><span><b>Include place photos</b><br /><span className="small muted">{anyPhotos ? 'Helps someone else find things in the dark' : 'Add photos to places to show them here'}</span></span><Switch checked={photos && anyPhotos} onChange={setPhotos} label="Include place photos" /></div>
          </div>
          <button type="button" className="btn primary block" onClick={() => window.print()}><Icon name="print" size="sm" />Print</button>
        </div>
        <div className="paper-wrap">
          <article className="print-area paper" style={{ padding: '14mm', display: 'grid', gap: 14, alignContent: 'start' }}>
            <div>
              <h2 style={{ fontSize: 30, margin: 0 }}>{scenario.name}</h2>
              <div style={{ fontSize: 12, color: '#555' }}>{counts.items} items in {counts.places} places · printed {printed}</div>
              {scenario.notes && <p style={{ fontSize: 13, margin: '8px 0 0' }}>{scenario.notes}</p>}
            </div>
            {groups.map((g) => (
              <section key={g.place?.id ?? 'none'} style={{ display: 'grid', gridTemplateColumns: photos && g.place?.photoFileId ? '30mm 1fr' : '1fr', gap: 12, borderTop: '1px solid #ddd', paddingTop: 10, breakInside: 'avoid' }}>
                {photos && g.place?.photoFileId && <img src={api.files.url(g.place.photoFileId)} alt="" style={{ width: '30mm', height: '22mm', objectFit: 'cover', borderRadius: 4 }} />}
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, display: 'flex', gap: 8, alignItems: 'center' }}>
                    {g.place?.path ?? 'No place set'}
                    {g.place?.code && <span style={{ fontFamily: 'var(--f-mono)', fontSize: 11, background: '#eee', padding: '1px 5px', borderRadius: 3 }}>{g.place.code}</span>}
                  </div>
                  {g.items.map((i) => (
                    <div key={i.productId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 0' }}>
                      <span style={{ width: 11, height: 11, border: '1.5px solid #333', borderRadius: 2, flex: 'none' }} />
                      <span style={{ flex: 1 }}>{i.name}{i.note && !i.low ? ` (${i.note})` : ''}</span>
                      <b>{qty(i.quantity, i.unit)}</b>
                    </div>
                  ))}
                </div>
              </section>
            ))}
            {missing.length > 0 && (
              <section style={{ borderTop: '1px solid #ddd', paddingTop: 10, fontSize: 13 }}>
                <b>Not in the house:</b> {missing.map((m) => m.name).join(', ')}
              </section>
            )}
          </article>
        </div>
      </div>
    </>
  );
}

function ScenariosPanel({ product }: { product: ProductDetail }) {
  const list = useList();
  const { run, busy } = useAction();
  const tags = (product.product.fields.scenarios as string[] | undefined) ?? [];
  if (!list.data?.length) return null;
  return (
    <div className="section">
      <div className="label">Scenarios</div>
      <div className="chips wrap">
        {list.data.map((s) => {
          const on = tags.includes(s.id);
          return (
            <button type="button" key={s.id} className={`chip ${on ? 'on' : ''}`} aria-pressed={on} disabled={busy}
              onClick={() => void run(() => call('PUT', `/${s.id}/items`, { productId: product.product.id, included: !on }), on ? `Taken out of ${s.name}` : `Added to ${s.name}`)}>
              <Icon name={ICONS.includes(s.icon) ? s.icon : 'layers'} size="sm" />{s.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default defineWebModule({
  id: 'scenarios',
  pages: [
    { path: '/', title: 'Scenarios', icon: 'layers', subtitle: 'Power cut, Christmas…', component: ScenarioList },
    { path: '/:id', title: 'Scenario', component: ScenarioPage },
    { path: '/:id/print', title: 'Print a scenario', component: PrintScenario },
  ],
  productPanels: [ScenariosPanel],
});
