import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Header, PlaceSelect, Seg, Stepper, useAction, useIsDesktop, usePlaces } from '../ui';

export function GridWizard() {
  const navigate = useNavigate();
  const desktop = useIsDesktop();
  const places = usePlaces();
  const { run, busy } = useAction();
  const [name, setName] = useState('Garage racking');
  const [parentId, setParentId] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('G');
  const [rows, setRows] = useState(4);
  const [cols, setCols] = useState(6);
  const [firstRow, setFirstRow] = useState<'top' | 'bottom'>('top');
  const p = (prefix || 'G').toUpperCase();
  const order = Array.from({ length: rows }, (_, i) => (firstRow === 'top' ? i + 1 : rows - i));

  return (
    <>
      <Header title="Shelves & boxes" back="/places" />
      <div className="content" style={desktop ? { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)', alignItems: 'start' } : undefined}>
        <div className="section" style={{ gap: 18 }}>
          <p className="small muted">For racking, shelving or a stack of boxes. Each box gets a short code you can print on a label.</p>
          <div className="list">
            <label className="numfield"><span><b>Name</b></span><input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: '60%', textAlign: 'right', padding: '8px 10px' }} /></label>
            <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>Inside</b></span><div style={{ minWidth: 180, flex: 1, maxWidth: 320 }}><PlaceSelect value={parentId} onChange={setParentId} places={places} /></div></div>
            <label className="numfield"><span><b>Code starts with</b><small>Short and unique</small></span><input className="input mono" value={prefix} maxLength={4} onChange={(e) => setPrefix(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} style={{ width: 72, textAlign: 'center', padding: '8px 10px' }} /></label>
            <div className="numfield"><span><b>Shelves</b></span><Stepper value={rows} onChange={setRows} min={1} max={20} label="shelves" /></div>
            <div className="numfield"><span><b>Boxes per shelf</b></span><Stepper value={cols} onChange={setCols} min={1} max={20} label="boxes per shelf" /></div>
            <div className="numfield"><span><b>Shelf 1 is</b></span><Seg label="Shelf 1 is" value={firstRow} onChange={setFirstRow} options={[['top', 'Top'], ['bottom', 'Bottom']]} /></div>
          </div>
          <button type="button" className="btn primary block" disabled={busy || !name.trim() || !prefix} onClick={() => run(() => api.places.grid({ parentId, name: name.trim(), prefix: p, rows, columns: cols, firstRow }), (r) => `${r.places.length} places created`).then((r) => r && navigate(`/places/${r.container.id}`))}>
            Create {rows * cols} places
          </button>
        </div>
        <div className="section">
          <div className="label"><span>Preview</span><span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>{p}1-1 to {p}{rows}-{cols}</span></div>
          <div className="rack">
            {order.map((r) => (
              <div className="shelf" key={r}>
                <span className="small muted">Shelf {r}</span>
                <div className="boxes" style={{ gridTemplateColumns: `repeat(${cols}, minmax(40px, 1fr))` }}>
                  {Array.from({ length: cols }, (_, c) => <span key={c} className="box">{p}{r}-{c + 1}</span>)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
