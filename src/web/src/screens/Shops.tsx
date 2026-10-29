import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useEnabledWebModules } from '../modules';
import { Icon } from '../icons';
import { Header, useAction, useCategories, useIsDesktop, useShops } from '../ui';

export function Shops() {
  const desktop = useIsDesktop();
  const shops = useShops();
  const panels = useEnabledWebModules().flatMap((m) => (m.shopPanels ?? []).map((P, i) => ({ key: `${m.id}-${i}`, P })));
  const categories = useCategories();
  const summary = useQuery({ queryKey: ['shopping'], queryFn: api.shopping.summary });
  const presets = useQuery({ queryKey: ['shops', 'presets'], queryFn: api.shops.presets, staleTime: Infinity });
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const missing = (presets.data ?? []).filter((p) => !shops.some((s) => s.name.toLowerCase() === p.name.toLowerCase()));
  const count = (id: string) => summary.data?.shops.find((s) => s.shop.id === id)?.count ?? 0;

  return (
    <>
      <Header title="Shops" back="/more" />
      <div className="content">
        <p className="small muted">Items set to “Any shop” only show up at shops that sell that kind of thing. Tap a category to change what a shop sells.</p>
        <div className={desktop ? 'cards-2' : 'stack'} style={{ gap: 12 }}>
          {shops.map((s) => (
            <div className="card pad" key={s.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b style={{ fontFamily: 'var(--f-display)', fontSize: 17 }}>{s.name}</b>
                <div className="row" style={{ gap: 4 }}>
                  <Link className="small" to={`/shop/${s.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>{count(s.id)} on the list</Link>
                  <button type="button" className="iconbtn ghost" aria-label={`Remove ${s.name}`} disabled={busy} onClick={() => run(() => api.shops.remove(s.id), `${s.name} removed`)}><Icon name="trash" size="sm" /></button>
                </div>
              </div>
              <div className="chips wrap">
                {categories.filter((c) => c.name !== 'Renewals').map((c) => {
                  const on = s.sells.includes(c.id);
                  return <button key={c.id} type="button" className={`chip sm ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => run(() => api.shops.update(s.id, { sells: on ? s.sells.filter((x) => x !== c.id) : [...s.sells, c.id] }), `${s.name} ${on ? 'no longer sells' : 'now sells'} ${c.name}`)}>{c.name}</button>;
                })}
              </div>
              {panels.map(({ key, P }) => <P key={key} shop={s} />)}
            </div>
          ))}
        </div>
        {missing.length > 0 && (
          <div className="section">
            <div className="label">Add a shop</div>
            <div className="chips wrap">{missing.map((p) => <button key={p.name} type="button" className="chip" disabled={busy} onClick={() => run(() => api.shops.addPreset(p.name), `${p.name} added`)}><Icon name="plus" size="sm" />{p.name}</button>)}</div>
          </div>
        )}
        <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => api.shops.create({ name: name.trim(), sells: [] }), `${name.trim()} added`).then(() => setName('')); }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Another shop, e.g. the farm shop" aria-label="Shop name" />
          <button className="btn" disabled={!name.trim() || busy}>Add</button>
        </form>
      </div>
    </>
  );
}
