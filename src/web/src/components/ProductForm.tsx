/** The product fields form, shared by Add by name and Edit. */
import type { Category, Link as LinkT, PlaceRef, Shop } from '@larder/core';
import { Stepper, Switch, PlaceSelect } from '../ui';
import { plural, sameUnit, usageSentence, worthText } from '../format';

export interface ProductFormValue {
  name: string;
  aliases: string;
  categoryId: string | null;
  unit: string;
  shelfLifeDays: number | null;
  /** Comes in: the pack's name ('' for none) and how many of the unit it holds. */
  packName: string;
  packHolds: number;
  /** We use: how many of the unit (null for no usage) every `usageEvery` days or weeks. */
  usageAmount: number | null;
  usageEvery: number;
  usagePer: 'day' | 'week';
  /** Larder takes them out of stock by itself. */
  takeOut: boolean;
  /** With a usage: the current one started, or counting from (YYYY-MM-DD); '' for none. */
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
  return { name, aliases: '', categoryId: null, unit: 'each', shelfLifeDays: null, packName: '', packHolds: 20, usageAmount: null, usageEvery: 1, usagePer: 'day', takeOut: false, inUseSince: '', minQuantity: null, stockUpTo: null, preferredShopIds: [], defaultPlaceId: null, notes: '', links: '', wish: false, rechargeable: false };
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
    pack: packOf(v),
    usage: v.usageAmount ? { amount: v.usageAmount, everyDays: everyDays(v), auto: v.takeOut } : null,
    // Only with a usage: an item's open date (no usage) is the Use sheet's, so saving doesn't clear it.
    ...(v.usageAmount ? { inUseSince: v.inUseSince || null } : {}),
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

/** The pack the form describes, or null (none, holds 1, or the same as what it's counted in). */
export const packOf = (v: ProductFormValue) => (v.packName.trim() && v.packHolds > 1 && !sameUnit(v.packName, v.unit) ? { name: v.packName.trim(), holds: v.packHolds } : null);
/** Today on this device, as YYYY-MM-DD. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const addDaysIso = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const everyDays = (v: ProductFormValue) => Math.max(1, Math.round(v.usageEvery)) * (v.usagePer === 'week' ? 7 : 1);
/** Containers, not the thing used: counting these with a usage is probably a slip. */
const CONTAINERS = new Set(['box', 'pack', 'packet', 'case', 'multipack', 'tray', 'bundle', 'crate']);

/** The form's fields for an item's pack and usage. */
export function usageForm(p: { pack?: { name: string; holds: number } | null; usage?: { amount: number; everyDays: number; auto: boolean } | null; inUseSince: string | null }): Pick<ProductFormValue, 'packName' | 'packHolds' | 'usageAmount' | 'usageEvery' | 'usagePer' | 'takeOut' | 'inUseSince'> {
  const u = p.usage ?? null;
  const weeks = !!u && u.everyDays % 7 === 0;
  return {
    packName: p.pack?.name ?? '', packHolds: p.pack?.holds ?? 20,
    usageAmount: u?.amount ?? null, usageEvery: u ? (weeks ? u.everyDays / 7 : u.everyDays) : 1, usagePer: weeks ? 'week' : 'day',
    takeOut: u?.auto ?? false, inUseSince: u ? (p.inUseSince ?? '') : '',
  };
}

export function ProductForm({ value, onChange, categories, shops, places, showName = true }: {
  value: ProductFormValue; onChange: (v: ProductFormValue) => void; categories: Category[]; shops: Shop[]; places: PlaceRef[]; showName?: boolean;
}) {
  const set = <K extends keyof ProductFormValue>(k: K, v: ProductFormValue[K]) => onChange({ ...value, [k]: v });
  const cat = categories.find((c) => c.id === value.categoryId);
  const renewal = cat?.name === 'Renewals';
  const unit = value.unit.trim() || 'each';
  const many = unit === 'each' ? '' : plural(unit, 2);
  const pack = packOf(value);
  const usage = value.usageAmount ? { amount: value.usageAmount, everyDays: everyDays(value), auto: value.takeOut } : null;
  const usageAllowed = !renewal && !value.rechargeable;
  const packSlip = !!value.packName.trim() && sameUnit(value.packName, unit);
  const containerSlip = !!usage && !pack && (unit === 'each' || CONTAINERS.has(unit.toLowerCase()));
  // Switched on, Larder counts from today, unless the one in use still has days left (it was taken out
  // when it was started, so counting from an older day would take those days out again).
  const takeOut = (on: boolean) => {
    const today = localToday();
    const running = !!usage && !!value.inUseSince && addDaysIso(value.inUseSince, usage.everyDays) > today;
    onChange({ ...value, takeOut: on, ...(on && !value.takeOut && !running ? { inUseSince: today } : {}) });
  };
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
        <div className="numfield"><span><b>Counted in</b><small>The single thing you use: a tea bag, a roll, a sensor. For things you weigh or pour: g, kg, ml or L</small></span>
          <input className="input" list="units" style={{ width: 150, flexShrink: 0 }} value={value.unit} onChange={(e) => set('unit', e.target.value)} aria-label="Unit" />
          <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
        </div>
        <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>Comes in</b><small>{pack ? `How you buy it: adding 1 ${pack.name} adds ${pack.holds}${many ? ` ${many}` : ''}` : 'How you buy it, e.g. a box of 20. Leave it if you buy them singly'}</small>
            {packSlip && <small style={{ color: 'var(--low)' }}>A {unit} can't come in {plural(unit, 2)}. Count what's inside (tea bags, say) and say how many a {unit} holds.</small>}</span>
          {!value.packName && !pack ? <button type="button" className="btn small" aria-label="Set what it comes in" onClick={() => set('packName', 'box')}>Set</button> : (
            <div className="row" style={{ flexWrap: 'wrap', gap: 6, flex: '1 1 100%' }}>
              <input className="input" style={{ width: 90 }} value={value.packName} onChange={(e) => set('packName', e.target.value)} aria-label="What it comes in" placeholder="box" />
              <span className="small">of</span>
              <Stepper small value={value.packHolds} onChange={(n) => set('packHolds', Math.max(2, n))} min={2} label="how many one holds" />
              {many && <span className="small">{many}</span>}
              <button type="button" className="link small" onClick={() => onChange({ ...value, packName: '', packHolds: 20 })}>Clear</button>
            </div>
          )}
        </div>
        {usageAllowed && (
          <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>We use</b><small>{usage ? usageSentence({ unit, pack, usage }) : 'How fast it goes, so Larder knows when it runs out'}</small>
              {containerSlip && <small style={{ color: 'var(--low)' }}>Counting {unit === 'each' ? 'whole packs' : plural(unit, 2)}? If you use what's inside one at a time, count those (Counted in: tea bag) and say what it comes in.</small>}</span>
            {usage === null ? <button type="button" className="btn small" aria-label="Set how fast it's used" onClick={() => onChange({ ...value, usageAmount: 1 })}>Set</button> : (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, flex: '1 1 100%' }}>
                {/* Two halves that each stay on one line: "1 tea bags" and "every 1 day". */}
                <span className="row" style={{ gap: 6 }}>
                  <Stepper small value={value.usageAmount!} onChange={(n) => set('usageAmount', n > 0 ? n : value.usageAmount)} min={0.1} step={1} label={`how many ${many || 'of them'}`} />
                  {many && <span className="small">{many}</span>}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <span className="small">every</span>
                  <Stepper small value={value.usageEvery} onChange={(n) => set('usageEvery', Math.max(1, Math.round(n)))} min={1} label="every how many" />
                  <select className="input" style={{ width: 'auto' }} value={value.usagePer} onChange={(e) => set('usagePer', e.target.value as 'day' | 'week')} aria-label="Days or weeks">
                    <option value="day">{value.usageEvery === 1 ? 'day' : 'days'}</option>
                    <option value="week">{value.usageEvery === 1 ? 'week' : 'weeks'}</option>
                  </select>
                </span>
                <button type="button" className="link small" onClick={() => onChange({ ...value, usageAmount: null, takeOut: false, inUseSince: '' })}>Clear</button>
              </div>
            )}
          </div>
        )}
        {usageAllowed && usage && (
          <div className="numfield"><span><b>Take them out of stock for me</b><small>{value.takeOut ? 'Larder takes them out as they\'re used, so you don\'t press Use. Press Use only for an extra one' : 'Or press Use as each one is used'}</small></span>
            <Switch checked={value.takeOut} onChange={takeOut} label="Take them out of stock for me" />
          </div>
        )}
        {usageAllowed && usage && (
          <div className="numfield"><span><b>{usage.everyDays >= 2 && usage.amount <= 1 ? 'The one in use started' : 'Counting from'}</b><small>{value.takeOut ? 'Larder takes the next out once this period is up. Blank: none started yet, so the next Use starts one' : 'Leave blank if none has been started'}</small></span>
            <input className="input" type="date" style={{ width: 170 }} value={value.inUseSince} onChange={(e) => set('inUseSince', e.target.value)} aria-label="Started on" />
          </div>
        )}
        <div className="numfield"><span><b>Running low below</b><small>Puts it on the shopping list{usage && value.minQuantity ? ` · ${worthText((value.minQuantity * usage.everyDays) / usage.amount)}` : ''}</small></span>
          {value.minQuantity === null ? <button type="button" className="btn small" onClick={() => set('minQuantity', 1)}>Set</button> : <div className="row"><Stepper value={value.minQuantity} onChange={(n) => set('minQuantity', n)} label="minimum" /><button type="button" className="link small" onClick={() => set('minQuantity', null)}>Clear</button></div>}
        </div>
        <div className="numfield"><span><b>Stock up to</b><small>How many to have after buying more</small></span>
          {value.stockUpTo === null ? <button type="button" className="btn small" onClick={() => set('stockUpTo', Math.max(1, (value.minQuantity ?? 0) * 3))}>Set</button> : <div className="row"><Stepper value={value.stockUpTo} onChange={(n) => set('stockUpTo', n)} label="stock up to" /><button type="button" className="link small" onClick={() => set('stockUpTo', null)}>Clear</button></div>}
        </div>
        <div className="numfield"><span><b>{renewal ? 'Renews every' : 'Shelf life'}</b><small>{renewal ? 'Days, e.g. 365 for yearly' : 'Days from when it’s added, for food and renewals'}</small>
          {!renewal && usage && value.shelfLifeDays ? <small style={{ color: 'var(--low)' }}>New stock gets an expiry date this far ahead. If you meant how long one lasts once started, that’s We use: clear this.</small> : null}</span>
          {value.shelfLifeDays === null ? <button type="button" className="btn small" onClick={() => set('shelfLifeDays', renewal ? 365 : 7)}>Set</button> : <div className="row"><Stepper value={value.shelfLifeDays} onChange={(n) => set('shelfLifeDays', Math.max(1, Math.round(n)))} min={1} label="shelf life in days" /><button type="button" className="link small" onClick={() => set('shelfLifeDays', null)}>Clear</button></div>}
        </div>
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
