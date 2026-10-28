/**
 * Search everything. Results come in sections; stock results have + and −.
 * Keys: Tab moves between results, ↑/↓ count up or down, Enter opens the
 * highlighted result or applies the count, Esc cancels then closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { ProductSummary, SearchResult, Shop } from '@larder/core';
import { api } from '../api';
import { Icon } from '../icons';
import { num, plural, stockText } from '../format';
import { ProductTile, useAction, useDebounced, useShops } from '../ui';

interface Row {
  key: string;
  section: string;
  result: SearchResult;
  kind: 'stepper' | 'renew' | 'flat' | 'link' | 'bought' | 'tolist';
  shopName?: string;
}

const isRenewal = (s: ProductSummary) => s.category?.name === 'Renewals';
const canCount = (r: Row) => r.kind === 'stepper' && !!r.result.product;

function listShop(s: ProductSummary, shops: Shop[]): Shop | undefined {
  if (s.product.preferredShopIds.length) return shops.find((x) => x.id === s.product.preferredShopIds[0]);
  return shops.find((x) => s.product.categoryId && x.sells.includes(s.product.categoryId));
}

export function GlobalSearch() {
  const navigate = useNavigate();
  const shops = useShops();
  const { run } = useAction();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [count, setCount] = useState(0);
  const dq = useDebounced(q.trim(), 120);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { data, isFetching } = useQuery({ queryKey: ['search', dq], queryFn: () => api.search(dq), enabled: open, placeholderData: keepPreviousData, staleTime: 2000 });

  const sections = useMemo(() => {
    const out: Array<{ id: string; title: string; rows: Row[] }> = [];
    for (const s of data?.sections ?? []) {
      const rows: Row[] = s.results.map((r) => {
        let kind: Row['kind'] = 'link';
        if ((r.type === 'product') && r.product) kind = isRenewal(r.product) ? 'renew' : r.product.product.rechargeable ? 'flat' : 'stepper';
        if (r.type === 'wish') kind = 'bought';
        return { key: `${s.id}:${r.id}`, section: s.id, result: r, kind };
      });
      // Offer to put the top stock result on the shopping list if it isn't on one.
      if (s.id === 'stock' && dq) {
        const top = s.results[0]?.product;
        const listed = data?.sections.find((x) => x.id === 'shopping')?.results.some((r) => r.id === top?.product.id);
        const shop = top && listShop(top, shops);
        if (top && !listed && !top.product.onShoppingList && !isRenewal(top) && shop) {
          out.push({ id: s.id, title: s.title, rows });
          out.push({ id: 'shopping', title: 'Shopping lists', rows: [{ key: `tolist:${top.product.id}`, section: 'shopping', kind: 'tolist', shopName: shop.name, result: { type: 'tolist', id: top.product.id, title: `Put ${top.product.name.toLowerCase()} on the list`, subtitle: `Goes on the ${shop.name} list`, href: `/shop/${shop.id}`, product: top } }] });
          continue;
        }
      }
      const existing = out.find((x) => x.id === s.id);
      if (existing) existing.rows.push(...rows);
      else out.push({ id: s.id, title: s.title, rows });
    }
    return out;
  }, [data, dq, shops]);
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const hasStock = sections.some((s) => s.id === 'stock' && s.rows.length);

  useEffect(() => {
    setSel(0);
    setCount(0);
  }, [dq]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const slash = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea, select')) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', slash);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', slash);
    };
  }, []);

  const current = rows[Math.min(sel, rows.length - 1)];

  useEffect(() => {
    box.current?.querySelector('.gs-row.hl')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  async function adjust(s: ProductSummary, delta: number) {
    const unit = s.product.unit;
    await run(
      () => (delta > 0 ? api.stock.add({ productId: s.product.id, quantity: delta }) : api.stock.use({ productId: s.product.id, quantity: -delta })),
      (r) => `${delta > 0 ? 'Added' : 'Used'} ${num(Math.abs(delta))} · ${r.product.name}: ${stockText(r)}`,
    );
    void unit;
  }

  function go(href: string) {
    setOpen(false);
    navigate(href);
  }

  async function act(row: Row, how: 'primary' | 'plus' | 'minus') {
    const s = row.result.product;
    if (row.kind === 'stepper' && s) return adjust(s, how === 'minus' ? -1 : 1);
    if (row.kind === 'renew' && s) return run(() => api.products.renew(s.product.id), `${s.product.name} renewed`);
    if (row.kind === 'flat' && s) return run(() => api.stock.use({ productId: s.product.id, quantity: 1 }), (r) => `1 marked flat · ${stockText(r)}`);
    if (row.kind === 'bought' && s) return run(() => api.stock.add({ productId: s.product.id, quantity: 1 }), `${s.product.name} moved into stock`);
    if (row.kind === 'tolist' && s) return run(() => api.products.setOnList(s.product.id, true), `${s.product.name} is on the ${row.shopName} list`);
    go(row.result.href);
  }

  async function newItem(wish = false) {
    const name = q.trim();
    if (!name) return;
    if (wish) {
      await run(() => api.products.create({ name, wish: true }), `“${name}” is on the wish list`);
      setOpen(false);
      return;
    }
    go(`/add?name=${encodeURIComponent(name)}`);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (count) setCount(0);
      else {
        setOpen(false);
        input.current?.blur();
      }
      return;
    }
    if (!open) setOpen(true);
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!current || !canCount(current)) return;
      const d = e.key === 'ArrowUp' ? 1 : -1;
      if ((current.result.product?.inStock ?? 0) + count + d < 0) return;
      setCount((c) => c + d);
      return;
    }
    if (e.key === 'Tab' && rows.length && open) {
      e.preventDefault();
      setSel((i) => (i + (e.shiftKey ? -1 : 1) + rows.length) % rows.length);
      setCount(0);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!rows.length) return void newItem();
      if (current && count && current.result.product) {
        const c = count;
        setCount(0);
        return void adjust(current.result.product, c);
      }
      if (current) go(current.result.href);
    }
  }

  const keysHint = (() => {
    if (!current) return <><kbd>Enter</kbd> add as a new item · <kbd>Esc</kbd> close</>;
    if (canCount(current) && count) return <><kbd>Enter</kbd> {count > 0 ? 'add' : 'use'} {Math.abs(count)} · <kbd>↑</kbd><kbd>↓</kbd> change amount · <kbd>Esc</kbd> cancel</>;
    if (canCount(current)) return <><kbd>Enter</kbd> open {current.result.title} · <kbd>↑</kbd> add · <kbd>↓</kbd> use · <kbd>Tab</kbd> next result</>;
    return <><kbd>Enter</kbd> open · <kbd>Tab</kbd> next result</>;
  })();

  return (
    <div className="gsearch" ref={box}>
      <div className="gs-box">
        <Icon name="search" />
        <input
          ref={input}
          type="search"
          placeholder="Search or add anything…"
          aria-label="Search or add anything"
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
        />
        {isFetching && open ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> : <kbd className="gs-kbd">/</kbd>}
        <button type="button" className="gs-scan" aria-label="Scan instead" onClick={() => go('/scan')}><Icon name="scan" /></button>
      </div>
      {open && (
        <div className="gs-results" role="listbox" onMouseMove={(e) => {
          const el = (e.target as HTMLElement).closest('[data-idx]');
          if (el) {
            const i = Number(el.getAttribute('data-idx'));
            if (i !== sel) {
              setSel(i);
              setCount(0);
            }
          }
        }}>
          {!dq && !rows.length && <div className="gs-tip">Search covers everything: stock, shopping lists, places, the wish list and shops. Try a name, a nickname like “bog roll”, or a code like “G2-4”.</div>}
          {sections.map((s) => (
            <div key={s.id}>
              <div className="gs-head">{s.title}{dq ? ` · ${s.rows.length}` : ''}</div>
              {s.rows.map((row) => {
                const idx = rows.indexOf(row);
                const hl = idx === sel;
                const p = row.result.product;
                const preview = hl && count && p ? Math.max(0, p.inStock + count) : null;
                return (
                  <div key={row.key} className={`gs-row ${hl ? 'hl' : ''}`} data-idx={idx} role="option" aria-selected={hl}>
                    <a className="gs-main" href={`#${row.result.href}`} onClick={(e) => { e.preventDefault(); go(row.result.href); }}>
                      {p ? <ProductTile s={p} /> : <span className="tile"><Icon name={row.result.type === 'place' ? 'pin' : row.result.type === 'shop' ? 'store' : row.result.type === 'shopping' || row.kind === 'tolist' ? 'cart' : 'box'} /></span>}
                      <span className="item-main">
                        <span className="item-name">{row.result.title}</span>
                        <span className="item-meta">
                          {row.result.subtitle}
                          {p && row.kind !== 'stepper' && row.section !== 'shopping' ? ` · ${stockText(p)}` : ''}
                          {p && p.status.low && row.section === 'stock' ? <span style={{ color: 'var(--low)' }}> · Low</span> : null}
                        </span>
                      </span>
                    </a>
                    <div className="gs-acts">
                      {hl && count && p ? <span className="gs-pending">{count > 0 ? '+' : '−'}{Math.abs(count)}</span> : null}
                      {row.kind === 'stepper' && p ? (
                        <span className="stepper sm">
                          <button type="button" aria-label={`Use one ${p.product.name}`} onClick={() => act(row, 'minus')} disabled={p.inStock <= 0}><Icon name="minus" size="sm" /></button>
                          <output className={preview !== null ? 'preview' : ''}>{preview !== null ? `${num(preview)} ${p.product.unit === 'each' ? '' : plural(p.product.unit, preview)}` : stockText(p)}</output>
                          <button type="button" aria-label={`Add one ${p.product.name}`} onClick={() => act(row, 'plus')}><Icon name="plus" size="sm" /></button>
                        </span>
                      ) : (
                        <button type="button" className="btn small" onClick={() => act(row, 'primary')}>
                          {{ renew: 'Renewed', flat: '1 went flat', bought: 'Bought it', tolist: 'Add to list', link: row.section === 'shopping' || row.section === 'shops' ? 'Open list' : 'Open', stepper: 'Open' }[row.kind]}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {dq && !rows.length && !isFetching && <div className="gs-empty"><b>Nothing called “{dq}” yet</b><br /><span className="small muted">Add it now. You can scan a barcode for it later.</span></div>}
          {dq && (hasStock ? (
            <button type="button" className="gs-line accent" onClick={() => newItem()}><Icon name="plus" size="sm" />Not what you meant? Add “{q.trim()}” as a new item</button>
          ) : (
            <>
              <button type="button" className="gs-new" onClick={() => newItem()}><Icon name="plus" /><span>Add “{q.trim()}” as a new item<br /><span className="small" style={{ fontWeight: 500 }}>Name it, say how many and where it goes</span></span></button>
              <button type="button" className="gs-line" onClick={() => newItem(true)}><Icon name="heart" size="sm" />Add “{q.trim()}” to the wish list instead</button>
            </>
          ))}
          <div className="gs-keys">{keysHint}</div>
        </div>
      )}
    </div>
  );
}
