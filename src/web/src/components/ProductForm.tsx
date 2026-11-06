/** The product fields form, shared by Add by name and Edit. */
import type { Category, Link as LinkT, PlaceRef, Shop } from '@larder/core';
import { Stepper, Switch, PlaceSelect } from '../ui';

export interface ProductFormValue {
  name: string;
  aliases: string;
  categoryId: string | null;
  unit: string;
  shelfLifeDays: number | null;
  /** Days each one lasts once started, for things used one after another. */
  lastsDays: number | null;
  /** When the one in use was started (YYYY-MM-DD), or '' when none is in use. */
  inUseSince: string;
  minQuantity: number | null;
  stockUpTo: number | null;
  preferredShopIds: string[];
  defaultPlaceId: string | null;
  notes: string;
  links: string;
  wish: boolean;
  rechargeable: boolean;
}

export const UNITS = ['each', 'pack', 'roll', 'tin', 'bottle', 'bag', 'box', 'jar', 'carton', 'tablet', 'dose', 'pair', 'battery', 'L', 'ml', 'kg', 'g', 'm'];

export function emptyForm(name = ''): ProductFormValue {
  return { name, aliases: '', categoryId: null, unit: 'each', shelfLifeDays: null, lastsDays: null, inUseSince: '', minQuantity: null, stockUpTo: null, preferredShopIds: [], defaultPlaceId: null, notes: '', links: '', wish: false, rechargeable: false };
}

export function toPayload(v: ProductFormValue) {
  const links: LinkT[] = v.links
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .map((url) => ({ url, title: '' }));
  return {
    name: v.name.trim(),
    aliases: v.aliases.split(',').map((a) => a.trim()).filter(Boolean),
    categoryId: v.categoryId,
    unit: v.unit.trim() || 'each',
    shelfLifeDays: v.shelfLifeDays,
    lastsDays: v.lastsDays,
    inUseSince: v.lastsDays ? v.inUseSince || null : null,
    minQuantity: v.minQuantity,
    stockUpTo: v.stockUpTo,
    preferredShopIds: v.preferredShopIds,
    defaultPlaceId: v.defaultPlaceId,
    notes: v.notes,
    links,
    wish: v.wish,
    rechargeable: v.rechargeable,
  };
}

export function ProductForm({ value, onChange, categories, shops, places, showName = true }: {
  value: ProductFormValue; onChange: (v: ProductFormValue) => void; categories: Category[]; shops: Shop[]; places: PlaceRef[]; showName?: boolean;
}) {
  const set = <K extends keyof ProductFormValue>(k: K, v: ProductFormValue[K]) => onChange({ ...value, [k]: v });
  const cat = categories.find((c) => c.id === value.categoryId);
  const renewal = cat?.name === 'Renewals';
  const toggleShop = (id: string) => set('preferredShopIds', value.preferredShopIds.includes(id) ? value.preferredShopIds.filter((s) => s !== id) : [...value.preferredShopIds, id]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      {showName && (
        <label className="field"><span>Name</span><input className="input" value={value.name} onChange={(e) => set('name', e.target.value)} required /></label>
      )}
      <label className="field"><span>Other names</span><input className="input" value={value.aliases} onChange={(e) => set('aliases', e.target.value)} placeholder="loo roll, toilet paper" /><small>Separate with commas. Search and voice use these.</small></label>

      <div className="section">
        <div className="label">Category</div>
        <div className="chips wrap">
          {categories.map((c) => <button key={c.id} type="button" className={`chip ${value.categoryId === c.id ? 'on' : ''}`} onClick={() => onChange({ ...value, categoryId: value.categoryId === c.id ? null : c.id, rechargeable: c.name === 'Batteries' ? value.rechargeable : false })}>{c.name}</button>)}
        </div>
      </div>

      <div className="list">
        <div className="numfield"><span><b>Counted in</b><small>What one of these is</small></span>
          <input className="input" list="units" style={{ width: 130 }} value={value.unit} onChange={(e) => set('unit', e.target.value)} aria-label="Unit" />
          <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
        </div>
        <div className="numfield"><span><b>Running low below</b><small>Puts it on the shopping list</small></span>
          {value.minQuantity === null ? <button type="button" className="btn small" onClick={() => set('minQuantity', 1)}>Set</button> : <div className="row"><Stepper value={value.minQuantity} onChange={(n) => set('minQuantity', n)} label="minimum" /><button type="button" className="link small" onClick={() => set('minQuantity', null)}>Clear</button></div>}
        </div>
        <div className="numfield"><span><b>Stock up to</b><small>How many to have after buying more</small></span>
          {value.stockUpTo === null ? <button type="button" className="btn small" onClick={() => set('stockUpTo', Math.max(1, (value.minQuantity ?? 0) * 3))}>Set</button> : <div className="row"><Stepper value={value.stockUpTo} onChange={(n) => set('stockUpTo', n)} label="stock up to" /><button type="button" className="link small" onClick={() => set('stockUpTo', null)}>Clear</button></div>}
        </div>
        <div className="numfield"><span><b>{renewal ? 'Renews every' : 'Shelf life'}</b><small>{renewal ? 'Days, e.g. 365 for yearly' : 'Days from when it’s added, for food and renewals'}</small></span>
          {value.shelfLifeDays === null ? <button type="button" className="btn small" onClick={() => set('shelfLifeDays', renewal ? 365 : 7)}>Set</button> : <div className="row"><Stepper value={value.shelfLifeDays} onChange={(n) => set('shelfLifeDays', Math.max(1, Math.round(n)))} min={1} label="shelf life in days" /><button type="button" className="link small" onClick={() => set('shelfLifeDays', null)}>Clear</button></div>}
        </div>
        {!renewal && (
          <div className="numfield"><span><b>Each one lasts</b><small>Days once started, for things used one after another (a sensor, lenses, a filter)</small></span>
            {value.lastsDays === null ? <button type="button" className="btn small" aria-label="Set how long each one lasts" onClick={() => set('lastsDays', 14)}>Set</button> : <div className="row"><Stepper value={value.lastsDays} onChange={(n) => set('lastsDays', Math.max(1, Math.round(n)))} min={1} label="days each one lasts" /><button type="button" className="link small" onClick={() => onChange({ ...value, lastsDays: null, inUseSince: '' })}>Clear</button></div>}
          </div>
        )}
        {!renewal && value.lastsDays !== null && (
          <div className="numfield"><span><b>The one in use started</b><small>Leave blank if none is in use. Using one sets it to today</small></span>
            <input className="input" type="date" style={{ width: 170 }} value={value.inUseSince} onChange={(e) => set('inUseSince', e.target.value)} aria-label="The one in use started" />
          </div>
        )}
        <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>New stock goes to</b><small>Its usual place</small></span>
          <div style={{ minWidth: 200, flex: 1, maxWidth: 360 }}><PlaceSelect value={value.defaultPlaceId} onChange={(v) => set('defaultPlaceId', v)} places={places} /></div>
        </div>
      </div>

      <div className="section">
        <div className="label">Where to buy</div>
        <div className="chips wrap">
          <button type="button" className={`chip ${value.preferredShopIds.length === 0 ? 'on' : ''}`} onClick={() => set('preferredShopIds', [])}>Any shop</button>
          {shops.map((s) => <button key={s.id} type="button" className={`chip ${value.preferredShopIds.includes(s.id) ? 'on' : ''}`} onClick={() => toggleShop(s.id)}>{s.name}</button>)}
        </div>
        <small className="muted">“Any shop” means any shop that sells its category.</small>
      </div>

      <div className="list">
        <div className="toggle"><span><b>Wish list</b><br /><span className="small muted">Want it, don't have it yet</span></span><Switch checked={value.wish} onChange={(v) => set('wish', v)} label="Wish list" /></div>
        {(cat?.name === 'Batteries' || value.rechargeable) && (
          <div className="toggle"><span><b>Rechargeable</b><br /><span className="small muted">Count charged and flat separately</span></span><Switch checked={value.rechargeable} onChange={(v) => set('rechargeable', v)} label="Rechargeable" /></div>
        )}
      </div>

      <label className="field"><span>Notes</span><textarea className="input" value={value.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Policy number, who borrowed it, which size fits…" /></label>
      <label className="field"><span>Links</span><textarea className="input" value={value.links} onChange={(e) => set('links', e.target.value)} placeholder="https://… (one per line)" style={{ minHeight: 60 }} /></label>
    </div>
  );
}
