import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { ShoppingItem, ShoppingList } from '@larder/core';
import { api } from '../api';
import { Icon } from '../icons';
import { num, qty, stockText } from '../format';
import { useEnabledWebModules } from '../modules';
import { Empty, ErrorBox, Header, Loading, ProductTile, Stepper, useAction, useDebounced, useIsDesktop } from '../ui';

type Ticks = Record<string, { quantity: number; price?: number }>;
const load = (key: string): Ticks => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Ticks;
  } catch {
    return {};
  }
};

function reason(i: ShoppingItem): string {
  const s = i.summary;
  if (i.reason === 'manual') return 'Added by hand';
  const parts = [s.inStock + s.expected <= 0 ? 'None left' : `${stockText(s)} left`];
  if (s.product.minQuantity !== null) parts.push(`low below ${num(s.product.minQuantity)}`);
  if (s.expected) parts.push(`${num(s.expected)} on the way`);
  return parts.join(' · ');
}

export function Shopping() {
  const { shopId } = useParams();
  const desktop = useIsDesktop();
  const summary = useQuery({ queryKey: ['shopping'], queryFn: api.shopping.summary });
  const anywhere = shopId === 'anywhere';
  const list = useQuery({ queryKey: ['shopping', shopId], queryFn: () => api.shopping.forShop(shopId!), enabled: !!shopId && !anywhere });
  const unassigned = useQuery({ queryKey: ['shopping', 'unassigned'], queryFn: api.shopping.unassigned, enabled: anywhere });
  const panels = useEnabledWebModules().flatMap((m) => m.shoppingPanels ?? []);
  const key = `larder.ticks.${shopId}`;
  const [ticks, setTicks] = useState<Ticks>(() => load(key));
  const { run, busy } = useAction();

  useEffect(() => setTicks(load(key)), [key]);
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(ticks));
  }, [key, ticks]);

  if (summary.isLoading) return <Loading />;
  if (summary.error) return <div className="content"><ErrorBox error={summary.error} /></div>;
  const s = summary.data!;
  if (!shopId) {
    const go = s.suggestedShopId ?? s.shops[0]?.shop.id;
    if (go) return <Navigate to={`/shop/${go}`} replace />;
    return (
      <>
        <Header title="Shopping" />
        <div className="content"><Empty title="No shops yet"><span className="muted small">Add the shops you use. Larder builds a list for each one from whatever's running low.</span><Link className="btn primary small" to="/shops">Add shops</Link></Empty></div>
      </>
    );
  }

  const groups: ShoppingList['groups'] = anywhere ? (unassigned.data ?? []) : (list.data?.groups ?? []);
  const shop = s.shops.find((x) => x.shop.id === shopId)?.shop;
  const items = groups.flatMap((g) => g.items);
  const ticked = items.filter((i) => ticks[i.summary.product.id]);
  const loading = anywhere ? unassigned.isLoading : list.isLoading;

  const toggle = (i: ShoppingItem) => setTicks((t) => {
    const next = { ...t };
    if (next[i.summary.product.id]) delete next[i.summary.product.id];
    else next[i.summary.product.id] = { quantity: i.quantity };
    return next;
  });

  async function finish() {
    const r = await run(() => api.shopping.purchase({ shopId: anywhere ? null : shopId, items: ticked.map((i) => ({ productId: i.summary.product.id, quantity: ticks[i.summary.product.id]!.quantity, price: ticks[i.summary.product.id]!.price })) }),
      `${ticked.length} item${ticked.length === 1 ? '' : 's'} added to stock and taken off the list`);
    if (r) setTicks({});
  }

  return (
    <>
      <Header title={anywhere ? 'Somewhere else' : `At ${shop?.name ?? 'the shop'}`}><Link className="iconbtn" to="/shops" aria-label="Shops"><Icon name="store" /></Link></Header>
      <div className={`content ${desktop ? 'two-col' : ''}`}>
        <div className="section" style={{ gap: 18 }}>
          <div className="chips">
            {s.shops.map((x) => <Link key={x.shop.id} className={`chip ${x.shop.id === shopId ? 'on' : ''}`} to={`/shop/${x.shop.id}`}>{x.shop.name} <span className="n">{x.count}</span></Link>)}
            {s.unassigned > 0 && <Link className={`chip ${anywhere ? 'on' : ''}`} to="/shop/anywhere">Somewhere else <span className="n">{s.unassigned}</span></Link>}
          </div>
          <p className="small muted">{anywhere ? 'Things to buy that none of your shops sell. Set a shop on the item, or add categories to a shop.' : `Your ${shop?.name} favourites, plus “Any shop” items in what ${shop?.name} sells.`}</p>
          {loading && <Loading />}
          {!loading && !items.length && <Empty title="Nothing to buy here"><span className="muted small">Everything that can come from {anywhere ? 'anywhere' : shop?.name} is stocked up.</span></Empty>}
          {groups.map((g) => (
            <div className="section" key={g.category?.id ?? 'none'}>
              <div className="label">{g.category?.name ?? 'Other'}</div>
              <div className="list">
                {g.items.map((i) => {
                  const t = ticks[i.summary.product.id];
                  return (
                    <div key={i.summary.product.id} className={`item ${t ? 'done' : ''}`} style={{ flexWrap: 'wrap' }}>
                      <button type="button" className="check" aria-label={`Got ${i.summary.product.name}`} aria-pressed={!!t} onClick={() => toggle(i)}><Icon name="check" size="sm" /></button>
                      <ProductTile s={i.summary} />
                      <Link className="item-main" to={`/products/${i.summary.product.id}`}>
                        <span className="item-name">{i.summary.product.name} <span className="muted" style={{ fontWeight: 500 }}>· {qty(t?.quantity ?? i.quantity, i.summary.product.unit)}</span></span>
                        <span className="item-meta">{reason(i)}</span>
                      </Link>
                      <span className="item-side">{i.anyShop && !anywhere ? <span className="pill p-plain">Any shop</span> : null}</span>
                      {t && (
                        <div className="inputrow" style={{ width: '100%', paddingLeft: 38 }}>
                          <Stepper small value={t.quantity} onChange={(n) => setTicks({ ...ticks, [i.summary.product.id]: { ...t, quantity: n } })} min={0.1} label="how many you bought" />
                          <label className="row small muted" style={{ gap: 6 }}>Paid £<input className="input" style={{ width: 90, padding: '7px 9px' }} inputMode="decimal" placeholder="optional" value={t.price ?? ''} onChange={(e) => { const v = e.target.value.trim(); setTicks({ ...ticks, [i.summary.product.id]: { ...t, price: v === '' || Number.isNaN(Number(v)) ? undefined : Number(v) } }); }} /></label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {!anywhere && <AddToList shopId={shopId} />}
        </div>
        {(panels.length > 0 && list.data) ? (
          <aside className={desktop ? 'side' : 'section'}>{panels.map((P, idx) => <P key={idx} list={list.data!} />)}</aside>
        ) : null}
      </div>
      <div className="dock">
        <button type="button" className="btn primary" disabled={!ticked.length || busy} onClick={finish}>{ticked.length ? `Done · add ${ticked.length} item${ticked.length === 1 ? '' : 's'} to stock` : 'Tick items as you shop'}</button>
      </div>
    </>
  );
}

function AddToList({ shopId }: { shopId: string }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 200);
  const { run } = useAction();
  const { data } = useQuery({ queryKey: ['search', dq], queryFn: () => api.search(dq), enabled: dq.length > 1 });
  const hits = useMemo(() => (data?.sections.find((s) => s.id === 'stock')?.results ?? []).slice(0, 4), [data]);
  return (
    <div className="section">
      <div className="label">Add something else</div>
      <label className="search"><Icon name="plus" /><input placeholder="Something that isn't low yet" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Add to the shopping list" /></label>
      {hits.length > 0 && (
        <div className="list">
          {hits.map((h) => h.product && (
            <button key={h.id} type="button" className="item" onClick={() => run(() => api.products.setOnList(h.id, true), `${h.title} is on the list`).then(() => setQ(''))}>
              <ProductTile s={h.product} /><span className="item-main"><span className="item-name">{h.title}</span><span className="item-meta">You have {stockText(h.product)}</span></span><span className="pill p-plain">Add to list</span>
            </button>
          ))}
        </div>
      )}
      {dq.length > 1 && !hits.length && (
        <button type="button" className="btn small" onClick={() => run(async () => { await api.products.create({ name: dq, onShoppingList: true, preferredShopIds: [shopId] }); }, `${dq} is on the list`).then(() => setQ(''))}><Icon name="plus" size="sm" />Add “{dq}” as a new item on the list</button>
      )}
    </div>
  );
}
