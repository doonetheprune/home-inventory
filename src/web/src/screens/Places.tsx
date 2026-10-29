import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { PlaceNodeT } from '@larder/core';
import { api } from '../api';
import { Icon } from '../icons';
import { Empty, ErrorBox, Header, Loading, PlaceSelect, Sheet, useAction, useIsDesktop, usePlaces } from '../ui';

const ROOM_ICON = (name: string) => (/garage|shed|work/i.test(name) ? 'wrench' : /kitchen|pantry|fridge|freezer/i.test(name) ? 'apple' : /loft|attic/i.test(name) ? 'gift' : /outside|garden|tank/i.test(name) ? 'drop' : /hall|bath/i.test(name) ? 'pin' : 'home');

function codeRange(n: PlaceNodeT): string | null {
  const codes = n.children.map((c) => c.place.code).filter((c): c is string => !!c);
  if (!codes.length) return null;
  return codes.length > 1 ? `${codes[0]}–${codes[codes.length - 1]}` : codes[0]!;
}

export function PlaceTree({ nodes, current, filter }: { nodes: PlaceNodeT[]; current?: string; filter?: string }) {
  const f = filter?.trim().toLowerCase();
  const visible = (n: PlaceNodeT): boolean => !f || `${n.path} ${n.place.code ?? ''}`.toLowerCase().includes(f) || n.children.some(visible);
  return (
    <div className="list">
      {nodes.filter(visible).map((n) => (
        <details className="loc" key={n.place.id} open={!!f || n.children.some((c) => c.place.id === current || c.children.some((g) => g.place.id === current))}>
          <summary>
            <span className="tile"><Icon name={ROOM_ICON(n.place.name)} /></span>
            <span className="item-main"><Link className="item-name" to={`/places/${n.place.id}`} onClick={(e) => e.stopPropagation()}>{n.place.name}</Link><span className="item-meta">{n.itemCount} item{n.itemCount === 1 ? '' : 's'}{n.children.length ? ` · ${n.children.length} spot${n.children.length === 1 ? '' : 's'}` : ''}</span></span>
            {n.place.code && <span className="code">{n.place.code}</span>}
            {n.children.length > 0 && <Icon name="chev" className="chev" />}
          </summary>
          {n.children.filter(visible).map((c) => (
            <Link key={c.place.id} className={`subloc ${c.place.id === current ? 'cur' : ''}`} to={`/places/${c.place.id}`} style={{ paddingLeft: 66 }}>
              <span className="grow">{c.place.name}</span>
              {(c.place.code || codeRange(c)) && <span className="code">{c.place.code ?? codeRange(c)}</span>}
              <span className="muted small" style={{ minWidth: 24, textAlign: 'right' }}>{c.itemCount}</span>
            </Link>
          ))}
        </details>
      ))}
    </div>
  );
}

export function Places() {
  const desktop = useIsDesktop();
  const { data, error, isLoading } = useQuery({ queryKey: ['places', 'tree'], queryFn: api.places.tree });
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const total = useMemo(() => (data ?? []).reduce((n, x) => n + 1 + x.children.length, 0), [data]);

  return (
    <>
      <Header title="Places" back="/more">
        <button type="button" className="iconbtn" aria-label="Add a place" onClick={() => setAdding(true)}><Icon name="plus" /></button>
      </Header>
      <div className={`content ${desktop ? 'two-col' : ''}`}>
        <div className="section">
          <label className="search"><Icon name="search" /><input placeholder="Find a place or code" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a place" /></label>
          {isLoading && <Loading />}
          {error ? <ErrorBox error={error} /> : null}
          {data && !data.length && <Empty title="No places yet"><span className="muted small">Start with rooms (Kitchen, Garage, Shed), then the cupboards, shelves and boxes inside them.</span><button type="button" className="btn primary small" onClick={() => setAdding(true)}>Add a room</button></Empty>}
          {data && data.length > 0 && <PlaceTree nodes={data} filter={filter} />}
          {total > 0 && <p className="small muted">{total} places. Tap a room to see what's inside.</p>}
        </div>
        <aside className={desktop ? 'side' : 'section'}>
          <Link className="card pad" to="/grid" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <span className="tile lg" style={{ background: 'var(--accent-soft)' }}><Icon name="grid" size="lg" /></span>
            <span className="item-main"><b style={{ fontFamily: 'var(--f-display)', fontSize: 17 }}>Set up shelves or boxes</b><span className="small muted">“4 shelves, 6 boxes each” makes G1-1 to G4-6 in one go</span></span>
            <Icon name="chev" className="muted" />
          </Link>
          <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" size="sm" />Add a place</button>
        </aside>
      </div>
      {adding && <PlaceSheet onClose={() => setAdding(false)} />}
    </>
  );
}

export function PlaceSheet({ onClose, parentId = null, edit }: { onClose: () => void; parentId?: string | null; edit?: { id: string; name: string; code: string | null; parentId: string | null; notes: string } }) {
  const places = usePlaces();
  const { run, busy } = useAction();
  const [name, setName] = useState(edit?.name ?? '');
  const [code, setCode] = useState(edit?.code ?? '');
  const [parent, setParent] = useState<string | null>(edit ? edit.parentId : parentId);
  const [notes, setNotes] = useState(edit?.notes ?? '');
  const save = () =>
    run(() => (edit ? api.places.update(edit.id, { name: name.trim(), code: code.trim() || null, parentId: parent, notes }) : api.places.create({ name: name.trim(), code: code.trim() || null, parentId: parent, notes })), edit ? 'Saved' : `${name.trim()} added`).then((r) => r && onClose());
  return (
    <Sheet title={edit ? `Edit ${edit.name}` : 'Add a place'} onClose={onClose}>
      <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kitchen, Top drawer, Shelf 2…" autoFocus /></label>
      <label className="field"><span>Inside</span><PlaceSelect value={parent} onChange={setParent} places={places.filter((p) => p.id !== edit?.id)} /></label>
      <label className="field"><span>Short code (optional)</span><input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} placeholder="e.g. K2" /><small>Printed on labels and typed into search. Must be unique.</small></label>
      <label className="field"><span>Notes</span><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <button type="button" className="btn primary block" disabled={busy || !name.trim()} onClick={save}>{edit ? 'Save' : 'Add place'}</button>
    </Sheet>
  );
}
