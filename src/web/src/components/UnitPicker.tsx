/**
 * Picking a unit from the household's list (Bought in, Contains), with a search box, and adding a
 * count word Larder doesn't have yet ("Add a unit", the same small form as Settings → Units).
 */
import { useState } from 'react';
import type { Unit, UnitKind } from '@larder/core';
import { api } from '../api';
import { useUnits } from '../units';
import { Sheet, useAction } from '../ui';

/** Adds a count word to the unit list: its singular and plural. */
export function AddUnitForm({ onAdded, onCancel, start = '' }: { onAdded?: (u: Unit) => void; onCancel?: () => void; start?: string }) {
  const { run, busy } = useAction();
  const [one, setOne] = useState(start);
  const [many, setMany] = useState('');
  async function add() {
    const u = await run(() => api.units.add({ one: one.trim(), many: many.trim() }), (x) => `Added "${x.one}" to the units`);
    if (!u) return;
    setOne('');
    setMany('');
    onAdded?.(u);
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="inputrow" style={{ flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: '1 1 120px' }}><span>One</span><input className="input" value={one} onChange={(e) => setOne(e.target.value)} placeholder="sleeve" aria-label="One of it" /></label>
        <label className="field" style={{ flex: '1 1 120px' }}><span>Several</span><input className="input" value={many} onChange={(e) => setMany(e.target.value)} placeholder="sleeves" aria-label="Several" /></label>
      </div>
      <small className="muted">A word things are bought in or contain, like “sleeve”. Weights and volumes are all there already.</small>
      <div className="btnrow">
        <button type="button" className="btn small primary" disabled={busy || !one.trim() || !many.trim()} onClick={() => void add()}>Add unit</button>
        {onCancel && <button type="button" className="btn small ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

/**
 * A button showing the unit; pressing it opens the list to pick from. `kinds` limits it (Bought in: counts,
 * and g or ml for things bought loose), and `exclude` leaves some out (Contains can't be what it's bought in).
 */
export function UnitPicker({ value, onChange, kinds, only, exclude = [], label, empty = 'Pick' }: {
  value: string | null; onChange: (key: string) => void; kinds: UnitKind[]; only?: string[]; exclude?: string[]; label: string; empty?: string;
}) {
  const units = useUnits();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const current = value ? units.find(value) : null;
  const words = q.trim().toLowerCase();
  const shown = units.all.filter((u) => kinds.includes(u.kind) && (!only || only.includes(u.key)) && !exclude.includes(u.key) && (!words || u.one.toLowerCase().includes(words) || u.many.toLowerCase().includes(words)));
  const pick = (key: string) => {
    onChange(key);
    setOpen(false);
    setQ('');
    setAdding(false);
  };
  return (
    <>
      <button type="button" className="btn small" aria-label={label} onClick={() => setOpen(true)}>{current ? current.one : value || empty}</button>
      {open && (
        <Sheet title={label} onClose={() => setOpen(false)}>
          <input className="input" autoFocus placeholder="Search units" aria-label="Search units" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips wrap" style={{ maxHeight: '40vh', overflowY: 'auto' }}>
            {shown.map((u) => <button key={u.key} type="button" className={`chip ${current?.key === u.key ? 'on' : ''}`} onClick={() => pick(u.key)}>{u.one}</button>)}
            {!shown.length && <span className="small muted">No unit like that.</span>}
          </div>
          {kinds.includes('count') && (adding
            ? <AddUnitForm start={q.trim()} onAdded={(u) => pick(u.key)} onCancel={() => setAdding(false)} />
            : <button type="button" className="link small" style={{ justifySelf: 'start' }} onClick={() => setAdding(true)}>Add a unit</button>)}
        </Sheet>
      )}
    </>
  );
}
