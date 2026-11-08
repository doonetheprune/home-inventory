/** The product fields form, shared by Add by name and Edit. */
import type { Category, Link as LinkT, PlaceRef, Shop } from '@larder/core';
import { Stepper, Switch, PlaceSelect } from '../ui';
import { measureName, measureOf, measuresLike, num, ownUsage, perOne, plural, sameUnit, usageSentence, worthText, type Measure } from '../format';

export interface ProductFormValue {
  name: string;
  aliases: string;
  categoryId: string | null;
  unit: string;
  shelfLifeDays: number | null;
  /** Comes in: the pack's name ('' for none) and how many of the unit it holds. */
  packName: string;
  packHolds: number;
  /** Weighs: what one of the unit weighs or holds (null for not set, 0 while it's being typed). */
  sizeAmount: number | null;
  sizeUnit: Measure;
  /** We use: how much (null for no usage) every `usageEvery` days or weeks, in the unit or in `usageUnit` ('' for the unit). */
  usageAmount: number | null;
  usageUnit: Measure | '';
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
  return { name, aliases: '', categoryId: null, unit: 'each', shelfLifeDays: null, packName: '', packHolds: 20, sizeAmount: null, sizeUnit: 'g', usageAmount: null, usageUnit: '', usageEvery: 1, usagePer: 'day', takeOut: false, inUseSince: '', minQuantity: null, stockUpTo: null, preferredShopIds: [], defaultPlaceId: null, notes: '', links: '', wish: false, rechargeable: false };
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
    size: sizeOf(v),
    usage: v.usageAmount ? { amount: v.usageAmount, everyDays: everyDays(v), auto: v.takeOut, unit: usageUnitOf(v) } : null,
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
/** What one weighs, or null (not set, nothing typed yet, or counted by weight already). */
export const sizeOf = (v: ProductFormValue) => (v.sizeAmount && v.sizeAmount > 0 && !measureOf(v.unit.trim() || 'each') ? { amount: v.sizeAmount, unit: v.sizeUnit } : null);
/** What the usage is in: a weight or volume when Larder can turn it into the unit, else the unit (null). */
const usageUnitOf = (v: ProductFormValue) => (v.usageUnit && perOne(v.unit.trim() || 'each', sizeOf(v), v.usageUnit) ? v.usageUnit : null);
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

/** The form's fields for an item's pack, size and usage. */
export function usageForm(p: { pack?: { name: string; holds: number } | null; size?: { amount: number; unit: Measure } | null; usage?: { amount: number; everyDays: number; auto: boolean; unit?: Measure | null } | null; inUseSince: string | null }): Pick<ProductFormValue, 'packName' | 'packHolds' | 'sizeAmount' | 'sizeUnit' | 'usageAmount' | 'usageUnit' | 'usageEvery' | 'usagePer' | 'takeOut' | 'inUseSince'> {
  const u = p.usage ?? null;
  const weeks = !!u && u.everyDays % 7 === 0;
  return {
    packName: p.pack?.name ?? '', packHolds: p.pack?.holds ?? 20,
    sizeAmount: p.size?.amount ?? null, sizeUnit: p.size?.unit ?? 'g',
    usageAmount: u?.amount ?? null, usageUnit: u?.unit ?? '', usageEvery: u ? (weeks ? u.everyDays / 7 : u.everyDays) : 1, usagePer: weeks ? 'week' : 'day',
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
  const size = sizeOf(value);
  const ownMeasure = measureOf(unit);
  const one = unit === 'each' ? 'item' : unit;
  const usage = value.usageAmount ? { amount: value.usageAmount, everyDays: everyDays(value), auto: value.takeOut, unit: usageUnitOf(value) } : null;
  // In the unit, for how long the minimum lasts.
  const own = usage ? ownUsage(unit, size, usage) : null;
  const usageAllowed = !renewal && !value.rechargeable;
  const packSlip = !!value.packName.trim() && sameUnit(value.packName, unit);
  const containerSlip = !!usage && !pack && !usage.unit && (unit === 'each' || CONTAINERS.has(unit.toLowerCase()));
  // What "We use" can be said in besides the unit: by weight once Larder knows what one weighs.
  const measureChoices = size ? measuresLike(size.unit) : ownMeasure ? measuresLike(ownMeasure).filter((m) => m !== ownMeasure) : [];
  /** A new unit for the usage, keeping what it means (1 jar every 100 days is 400 g every 100 days). */
  const setUsageUnit = (to: Measure | '') => {
    const from = usageUnitOf(value);
    const inOwn = from ? (value.usageAmount ?? 0) / (perOne(unit, size, from) ?? 1) : (value.usageAmount ?? 0);
    const amount = to ? inOwn * (perOne(unit, size, to) ?? 1) : inOwn;
    onChange({ ...value, usageUnit: to, usageAmount: value.usageAmount === null ? null : Math.round(amount * 1000) / 1000 || value.usageAmount });
  };
  /** No weight any more: a usage by weight goes back to the unit. */
  const clearSize = () => {
    const from = usageUnitOf(value);
    const per = from ? perOne(unit, size, from) : null;
    onChange({ ...value, sizeAmount: null, usageUnit: '', usageAmount: value.usageAmount !== null && per ? Math.round((value.usageAmount / per) * 1000) / 1000 || value.usageAmount : value.usageAmount });
  };
  /** A weight in ml instead of g (or back): a usage by weight follows it. */
  const setSizeUnit = (m: Measure) => onChange({ ...value, sizeUnit: m, ...(value.usageUnit && !measuresLike(m).includes(value.usageUnit) ? { usageUnit: measuresLike(m)[0]! } : {}) });
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
        {!ownMeasure && (
          <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>Weighs</b><small>{size ? `So you can say how much you use by ${size.unit === 'g' || size.unit === 'kg' ? 'weight' : 'volume'} (${measureName(measuresLike(size.unit)[0]!)} a day)` : `What 1 ${one} weighs or holds, e.g. 400 g. Leave it unless you'd rather say how much you use by weight`}</small></span>
            {value.sizeAmount === null ? <button type="button" className="btn small" aria-label="Set what one weighs" onClick={() => set('sizeAmount', 0)}>Set</button> : (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, flex: '1 1 100%' }}>
                <span className="small">1 {one} =</span>
                <input className="input" type="number" inputMode="decimal" min={0} step="any" style={{ width: 100 }} value={value.sizeAmount || ''} onChange={(e) => set('sizeAmount', Math.max(0, Number(e.target.value) || 0))} aria-label="What one weighs or holds" placeholder="400" />
                <select className="input" style={{ width: 'auto' }} value={value.sizeUnit} onChange={(e) => setSizeUnit(e.target.value as Measure)} aria-label="Grams, kilograms, millilitres or litres">
                  {(['g', 'kg', 'ml', 'l'] as const).map((m) => <option key={m} value={m}>{measureName(m)}</option>)}
                </select>
                <button type="button" className="link small" onClick={clearSize}>Clear</button>
              </div>
            )}
          </div>
        )}
        {usageAllowed && (
          <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>We use</b><small>{usage ? usageSentence({ unit, pack, size, usage }) : 'How fast it goes, so Larder knows when it runs out'}</small>
              {containerSlip && <small style={{ color: 'var(--low)' }}>Counting {unit === 'each' ? 'whole packs' : plural(unit, 2)}? If you use what's inside one at a time, count those (Counted in: tea bag) and say what it comes in.</small>}</span>
            {usage === null ? <button type="button" className="btn small" aria-label="Set how fast it's used" onClick={() => onChange({ ...value, usageAmount: 1 })}>Set</button> : (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, flex: '1 1 100%' }}>
                {/* Two halves that each stay on one line: "1 tea bags" and "every 1 day". */}
                <span className="row" style={{ gap: 6 }}>
                  <Stepper small value={value.usageAmount!} onChange={(n) => set('usageAmount', n > 0 ? n : value.usageAmount)} min={0.1} step={1} label={usage?.unit ? `how much in ${measureName(usage.unit)}` : `how many ${many || 'of them'}`} />
                  {measureChoices.length ? (
                    <select className="input" style={{ width: 'auto' }} value={usage?.unit ?? ''} onChange={(e) => setUsageUnit(e.target.value as Measure | '')} aria-label="Used in">
                      <option value="">{many || 'of them'}</option>
                      {measureChoices.map((m) => <option key={m} value={m}>{measureName(m)}</option>)}
                    </select>
                  ) : many && <span className="small">{many}</span>}
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
          <div className="numfield"><span><b>Take them out of stock for me</b><small>{usage.unit ? (value.takeOut ? `Larder takes ${num(usage.amount)} ${measureName(usage.unit)} out ${usage.everyDays === 1 ? 'each day' : `every ${usage.everyDays} days`}, so you don't press Use` : `Or press Use when a ${one} is finished`) : value.takeOut ? 'Larder takes them out as they\'re used, so you don\'t press Use. Press Use only for an extra one' : 'Or press Use as each one is used'}</small></span>
            <Switch checked={value.takeOut} onChange={takeOut} label="Take them out of stock for me" />
          </div>
        )}
        {usageAllowed && usage && (
          <div className="numfield"><span><b>{usage.everyDays >= 2 && usage.amount <= 1 && !usage.unit ? 'The one in use started' : 'Counting from'}</b><small>{usage.unit ? 'The day Larder counts from' : value.takeOut ? 'Larder takes the next out once this period is up. Blank: none started yet, so the next Use starts one' : 'Leave blank if none has been started'}</small></span>
            <input className="input" type="date" style={{ width: 170 }} value={value.inUseSince} onChange={(e) => set('inUseSince', e.target.value)} aria-label="Started on" />
          </div>
        )}
        <div className="numfield"><span><b>Running low below</b><small>Puts it on the shopping list{own && value.minQuantity ? ` · ${worthText((value.minQuantity * own.everyDays) / own.amount)}` : ''}</small></span>
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
