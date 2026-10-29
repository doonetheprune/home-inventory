import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ProductSummary } from '@larder/core';
import { api } from '../api';
import { Icon } from '../icons';
import { stockText } from '../format';
import { Empty, ErrorBox, Header, Loading, PlaceText, ProductTile, Seg, StatusPills, useAction, useCategories, useIsDesktop } from '../ui';

const STATUSES: Array<[string, string]> = [['low', 'Low'], ['expiring', 'Use soon'], ['out_of_place', 'Out of place'], ['expected', 'On the way'], ['in_stock', 'In stock']];

function matches(s: ProductSummary, q: string): boolean {
  if (!q) return true;
  const hay = [s.product.name, ...s.product.aliases, s.category?.name ?? '', s.product.notes, ...s.places.map((p) => `${p.path} ${p.code ?? ''}`)].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

/** One card per type of thing (Food, Tools & DIY…): how many, and what needs attention. */
function TypeCards({ all }: { all: ProductSummary[] }) {
  const categories = useCategories();
  const types = categories
    .map((c) => ({ c, items: all.filter((s) => s.category?.id === c.id) }))
    .filter((t) => t.items.length > 0);
  const count = (items: ProductSummary[], key: 'low' | 'expiringSoon' | 'outOfPlace') => items.filter((s) => s.status[key]).length;
  return (
    <div className="type-grid">
      {types.map(({ c, items }) => {
        const low = count(items, 'low');
        const soon = count(items, 'expiringSoon');
        const away = count(items, 'outOfPlace');
        return (
          <Link key={c.id} className="type-card" to={`/stock?category=${c.id}`}>
            <span className="tile"><Icon name={c.icon} /></span>
            <span className="type-main">
              <b>{c.name}</b>
              <span className="muted small">{items.length} item{items.length === 1 ? '' : 's'}</span>
            </span>
            {(low > 0 || soon > 0 || away > 0) && (
              <span className="pills">
                {low > 0 && <span className="pill p-low">{low} low</span>}
                {soon > 0 && <span className="pill p-soon">{soon} use soon</span>}
                {away > 0 && <span className="pill p-away">{away} moved</span>}
              </span>
            )}
          </Link>
        );
      })}
      <Link className="type-card everything" to="/stock?view=all">
        <span className="tile"><Icon name="box" /></span>
        <span className="type-main"><b>Everything</b><span className="muted small">{all.length} item{all.length === 1 ? '' : 's'}</span></span>
      </Link>
    </div>
  );
}

export function Stock() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const desktop = useIsDesktop();
  const status = params.get('status') ?? 'all';
  const categoryId = params.get('category') ?? '';
  const [q, setQ] = useState('');
  const [groupChoice, setGroup] = useState<'cat' | 'place' | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const categories = useCategories();
  const everything = useQuery({ queryKey: ['products', 'all', ''], queryFn: () => api.products.list({ status: 'all' }) });
  const { data, error, isLoading } = useQuery({ queryKey: ['products', status, categoryId], queryFn: () => api.products.list({ status, categoryId: categoryId || undefined }) });
  // Stock opens on the types of thing; a type, a filter, a search or "Everything" shows the list.
  const overview = !categoryId && status === 'all' && !q && params.get('view') !== 'all';
  // Within one type, group by where things are; across types, by type.
  const group = groupChoice ?? (categoryId ? 'place' : 'cat');
  const list = useMemo(() => (data ?? []).filter((s) => matches(s, q)), [data, q]);
  const groups = useMemo(() => {
    const m = new Map<string, ProductSummary[]>();
    for (const s of list) {
      const key = group === 'cat' ? (s.category?.name ?? 'No category') : (s.places[0]?.path.split(' › ')[0] ?? 'No place set');
      m.set(key, [...(m.get(key) ?? []), s]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en-GB'));
  }, [list, group]);
  const pane = list.find((s) => s.product.id === selected) ?? list[0];
  const category = categories.find((c) => c.id === categoryId);
  const perType = (id: string) => (everything.data ?? []).filter((s) => s.category?.id === id).length;

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    if (key === 'category') next.delete('view');
    setParams(next, { replace: true });
  };

  return (
    <>
      <Header title={category?.name ?? (overview ? 'Stock' : status !== 'all' ? (STATUSES.find(([k]) => k === status)?.[1] ?? 'Stock') : 'Everything')} back={overview ? undefined : '/stock'}>
        <Link className="iconbtn" to="/add" aria-label="Add item"><Icon name="plus" /></Link>
      </Header>
      <div className={`content ${desktop && !overview ? 'two-col' : ''}`}>
        <div className="section" style={{ gap: 18 }}>
          <label className="search"><Icon name="search" /><input type="search" placeholder={category ? `Filter ${category.name.toLowerCase()}` : 'Filter everything'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter this list" /></label>
          {!overview && (
            <div className="chips" role="tablist" aria-label="Type">
              <button type="button" role="tab" aria-selected={!categoryId} className={`chip ${!categoryId ? 'on' : ''}`} onClick={() => setFilter('category', '')}>All types</button>
              {categories.filter((c) => perType(c.id) > 0 || c.id === categoryId).map((c) => (
                <button key={c.id} type="button" role="tab" aria-selected={categoryId === c.id} className={`chip ${categoryId === c.id ? 'on' : ''}`} onClick={() => setFilter('category', c.id)}>
                  {c.name} <span className="n">{perType(c.id)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="chips" aria-label="Show only">
            {STATUSES.map(([k, t]) => <button key={k} type="button" className={`chip ${status === k ? 'on' : ''}`} aria-pressed={status === k} onClick={() => setFilter('status', status === k ? 'all' : k)}>{t}</button>)}
          </div>
          {overview ? (
            everything.isLoading ? <Loading /> : everything.error ? <ErrorBox error={everything.error} /> : (everything.data ?? []).length ? <TypeCards all={everything.data ?? []} /> : (
              <Empty title="Nothing in Larder yet"><Link className="btn small" to="/add"><Icon name="plus" size="sm" />Add an item</Link></Empty>
            )
          ) : (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted small">{list.length} item{list.length === 1 ? '' : 's'}</span>
                <Seg label="Group by" value={group} onChange={setGroup} options={[['place', 'Place'], ['cat', 'Type']]} />
              </div>
              {isLoading && <Loading />}
              {error ? <ErrorBox error={error} /> : null}
              {!isLoading && !list.length && (
                <Empty title={q ? `Nothing matches “${q}”` : 'Nothing here'}>
                  <span className="muted small">{q ? 'Check the spelling, or add it as a new item.' : 'Try another filter, or add something.'}</span>
                  <Link className="btn small" to={`/add${q ? `?name=${encodeURIComponent(q)}` : ''}`}><Icon name="plus" size="sm" />Add {q ? `“${q}”` : 'an item'}</Link>
                </Empty>
              )}
              {list.length > 0 && <div className="stock-head"><span /><span>Item</span><span>Place</span><span>Stock</span></div>}
              {groups.map(([name, items]) => (
                <div className="section" key={name}>
                  <div className="label">{name} <span style={{ fontWeight: 600 }}>{items.length}</span></div>
                  <div className="list stock-table">
                    {items.map((s) => (
                      <a key={s.product.id} className={`item ${desktop && pane?.product.id === s.product.id ? 'sel' : ''}`} href={`#/products/${s.product.id}`}
                        onClick={(e) => { e.preventDefault(); if (desktop) setSelected(s.product.id); else navigate(`/products/${s.product.id}`); }}>
                        <ProductTile s={s} />
                        <span className="item-main">
                          <span className="item-name">{s.product.name}</span>
                          <span className="item-meta">{s.product.aliases[0] ? `${s.product.aliases.slice(0, 2).join(', ')}` : s.category?.name}<span className="m-place">{s.places[0] ? <> · <PlaceText p={s.places[0]} /></> : null}</span></span>
                        </span>
                        <span className="col-place">{s.places[0] ? <PlaceText p={s.places[0]} /> : '—'}</span>
                        <span className="item-side"><span className="qty">{stockText(s)}</span><StatusPills s={s} /></span>
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
        {desktop && !overview && pane && <aside className="side"><StockPane s={pane} /></aside>}
      </div>
    </>
  );
}

function StockPane({ s }: { s: ProductSummary }) {
  const { run, busy } = useAction();
  return (
    <div className="card pad">
      <div className="hero"><ProductTile s={s} size="lg" /><div className="stack" style={{ gap: 4, minWidth: 0 }}><h2 style={{ fontSize: 22 }}>{s.product.name}</h2>{s.category && <span className="muted small">{s.category.name}</span>}</div></div>
      {s.product.aliases.length > 0 && <div className="aliases">{s.product.aliases.map((a) => <span key={a} className="pill p-plain">{a}</span>)}</div>}
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}><b style={{ font: '800 28px/1.1 var(--f-display)' }}>{stockText(s)}</b><StatusPills s={s} /></div>
      <dl className="kv">
        <dt>Usually</dt><dd>{s.places[0] ? <PlaceText p={s.places[0]} /> : 'No place set'}</dd>
        {s.nowIn[0] && <><dt>Now in</dt><dd>{s.nowIn[0].path}</dd></>}
        {s.product.minQuantity !== null && <><dt>Low below</dt><dd>{s.product.minQuantity}</dd></>}
      </dl>
      {s.product.notes && <p className="small muted">{s.product.notes}</p>}
      <div className="btnrow">
        <button className="btn small" type="button" disabled={busy || s.inStock <= 0} onClick={() => run(() => api.stock.use({ productId: s.product.id, quantity: 1 }), (r) => `Used 1 · ${stockText(r)}`)}><Icon name="minus" size="sm" />Use</button>
        <button className="btn small primary" type="button" disabled={busy} onClick={() => run(() => api.stock.add({ productId: s.product.id, quantity: 1 }), (r) => `Added 1 · ${stockText(r)}`)}><Icon name="plus" size="sm" />Add</button>
      </div>
      <Link className="link small" to={`/products/${s.product.id}?add=elsewhere`}>Add at another place</Link>
      <Link className="btn block" to={`/products/${s.product.id}`}>Open full page<Icon name="chev" size="sm" /></Link>
    </div>
  );
}
