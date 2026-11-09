/** The product fields form, shared by Add by name and Edit. Units come from the household's list (docs/plans/units.md). */
import { asWeight, canConvert, isCount, isLoose, isMeasure, measuredIn, type Category, type Link as LinkT, type PlaceRef, type Shop, type Units } from '@larder/core';
import { Stepper, Switch, PlaceSelect } from '../ui';
import { daysFor, lastsText, num, plural, usageText, worthText } from '../format';
import { useUnits } from '../units';
import { UnitPicker } from './UnitPicker';

export interface ProductFormValue {
  name: string;
  aliases: string;
  categoryId: string | null;
  /** Bought in: a key from the unit list. */
  unit: string;
  shelfLifeDays: number | null;
  /** Each one contains: how much (null for nothing, 0 while it's being typed) of what, a key from the list. */
  contentsAmount: number | null;
  contentsUnit: string;
  /** Weight, given by hand (null for none). Not used when Contains is an amount: that gives the Weight. */
  weightAmount: number | null;
  weightUnit: string;
  /** We use: how much (null for no usage) every `usageEvery` days or weeks, in `usageUnit` ('' for what it's bought in). */
  usageAmount: number | null;
  usageUnit: string;
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

/** What a Weight can be given in: the list's weights and volumes. */
const weightUnits = (units: Units) => units.all.filter((u) => u.kind !== 'count').map((u) => u.key);
/** Things bought loose are bought in g or ml: kg, L and the rest are for typing a Weight or Contains. */
export const notBoughtIn = (units: Units) => units.all.filter((u) => u.kind !== 'count' && u.factor !== 1).map((u) => u.key);

export function emptyForm(name = ''): ProductFormValue {
  return { name, aliases: '', categoryId: null, unit: 'each', shelfLifeDays: null, contentsAmount: null, contentsUnit: '', weightAmount: null, weightUnit: 'g', usageAmount: null, usageUnit: '', usageEvery: 1, usagePer: 'day', takeOut: false, inUseSince: '', minQuantity: null, stockUpTo: null, preferredShopIds: [], defaultPlaceId: null, notes: '', links: '', wish: false, rechargeable: false };
}

/** What one contains, or null (nothing typed yet, or nothing for things bought loose). */
export const contentsOf = (units: Units, v: ProductFormValue) => (v.contentsAmount && v.contentsAmount > 0 && v.contentsUnit && !isLoose(units, v) ? { amount: v.contentsAmount, unit: v.contentsUnit } : null);
/** Contains as an amount (400 g) gives the Weight, so the form doesn't ask for one. */
const contentsGiveWeight = (units: Units, v: ProductFormValue) => { const c = contentsOf(units, v); return !!c && !isCount(units, c.unit); };
/** The Weight given by hand, or null. */
const weightOf = (units: Units, v: ProductFormValue) => (v.weightAmount && v.weightAmount > 0 && !isLoose(units, v) && !contentsGiveWeight(units, v) ? { amount: v.weightAmount, unit: v.weightUnit } : null);

/** The item as the form describes it, for the core's helpers (usage text, how long one lasts). */
function itemOf(units: Units, v: ProductFormValue) {
  const contents = contentsOf(units, v);
  const given = weightOf(units, v);
  // Contains 400 g is a Weight of 400 g; a Weight given in kg is kept in g (as the product service keeps it).
  const measured = contentsGiveWeight(units, v) ? contents : given;
  const weight = measured ? asWeight(units, measured) : null;
  const usage = v.usageAmount ? { amount: v.usageAmount, everyDays: everyDays(v), auto: v.takeOut, unit: v.usageUnit || null } : null;
  return { name: v.name || 'It', unit: v.unit, contents, weight, usage };
}

export function toPayload(v: ProductFormValue, units: Units) {
  const links: LinkT[] = v.links
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .map((url) => ({ url, title: '' }));
  return {
    name: v.name.trim(),
    aliases: v.aliases.split(',').map((a) => a.trim()).filter(Boolean),
    categoryId: v.categoryId,
    unit: v.unit || 'each',
    shelfLifeDays: v.shelfLifeDays,
    contents: contentsOf(units, v),
    weight: weightOf(units, v),
    usage: v.usageAmount ? { amount: v.usageAmount, everyDays: everyDays(v), auto: v.takeOut, unit: v.usageUnit || null } : null,
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
    // Saved from here, it's been looked at: off the To tidy list.
    needsCheck: null,
  };
}

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

/** The form's fields for what an item contains, weighs and how fast it's used. */
export function usageForm(units: Units, p: { contents?: { amount: number; unit: string } | null; weight?: { amount: number; unit: string } | null; usage?: { amount: number; everyDays: number; auto: boolean; unit?: string | null } | null; inUseSince: string | null }): Pick<ProductFormValue, 'contentsAmount' | 'contentsUnit' | 'weightAmount' | 'weightUnit' | 'usageAmount' | 'usageUnit' | 'usageEvery' | 'usagePer' | 'takeOut' | 'inUseSince'> {
  const u = p.usage ?? null;
  const weeks = !!u && u.everyDays % 7 === 0;
  // A Weight worked out from Contains (400 g) isn't one given by hand.
  const fromContents = !!p.contents && !isCount(units, p.contents.unit);
  return {
    contentsAmount: p.contents?.amount ?? null, contentsUnit: p.contents?.unit ?? '',
    weightAmount: fromContents ? null : (p.weight?.amount ?? null), weightUnit: p.weight?.unit ?? 'g',
    usageAmount: u?.amount ?? null, usageUnit: u?.unit ?? '', usageEvery: u ? (weeks ? u.everyDays / 7 : u.everyDays) : 1, usagePer: weeks ? 'week' : 'day',
    takeOut: u?.auto ?? false, inUseSince: u ? (p.inUseSince ?? '') : '',
  };
}

export function ProductForm({ value, onChange, categories, shops, places, showName = true }: {
  value: ProductFormValue; onChange: (v: ProductFormValue) => void; categories: Category[]; shops: Shop[]; places: PlaceRef[]; showName?: boolean;
}) {
  const units = useUnits();
  const set = <K extends keyof ProductFormValue>(k: K, v: ProductFormValue[K]) => onChange({ ...value, [k]: v });
  const cat = categories.find((c) => c.id === value.categoryId);
  const renewal = cat?.name === 'Renewals';
  const unit = value.unit || 'each';
  const bought = units.find(unit);
  const loose = isLoose(units, value);
  const one = bought?.key === 'each' ? 'one' : (bought?.one ?? unit);
  const item = itemOf(units, value);
  const usage = item.usage;
  const usageAllowed = !renewal && !value.rechargeable;
  // What We use can be said in: what it's bought in, what one contains when that's a count, and g or ml once there's a Weight.
  const inside = item.contents && isCount(units, item.contents.unit) ? item.contents.unit : null;
  const by = loose ? null : measuredIn(units, item);
  const usageChoices = [{ key: '', label: bought?.key === 'each' ? 'of them' : plural(unit, 2) || unit }, ...(inside ? [{ key: inside, label: plural(inside, 2) }] : []), ...(by ? [{ key: by, label: by }] : [])];
  if (value.usageUnit && !usageChoices.some((c) => c.key === value.usageUnit)) usageChoices.push({ key: value.usageUnit, label: units.find(value.usageUnit)?.many ?? value.usageUnit });
  const usageWorks = !usage?.unit || canConvert(units, item, usage.unit);
  const lasts = usage && usageWorks ? lastsText(item) : null;
  const worth = usage && usageWorks && value.minQuantity ? daysFor(item, value.minQuantity) : null;
  // Switched on, Larder counts from today, unless the one in use still has days left (it was taken out
  // when it was started, so counting from an older day would take those days out again).
  const takeOut = (on: boolean) => {
    const today = localToday();
    const running = !!usage && !!value.inUseSince && addDaysIso(value.inUseSince, usage.everyDays) > today;
    onChange({ ...value, takeOut: on, ...(on && !value.takeOut && !running ? { inUseSince: today } : {}) });
  };
  /** Bought in something new: if that's what one contained, Contains goes, and a usage in it is in what it's bought in. */
  const setUnit = (key: string) => onChange({
    ...value, unit: key,
    ...(key === value.contentsUnit ? { contentsAmount: null, contentsUnit: '', usageUnit: value.usageUnit === key ? '' : value.usageUnit } : {}),
  });
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
        <div className="numfield"><span><b>Bought in</b><small>What you buy and count it in{loose ? ': bought loose, by weight or volume' : ''}</small>
            {!bought && <small style={{ color: 'var(--low)' }}>“{unit}” isn't on the unit list: pick what it's bought in.</small>}</span>
          <UnitPicker value={unit} onChange={setUnit} kinds={['count', 'weight', 'volume']} exclude={notBoughtIn(units)} label="Bought in" />
        </div>
        {!loose && (
          <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>Each {one} contains</b><small>What's in one, as on the pack</small></span>
            {value.contentsAmount === null ? <button type="button" className="btn small" aria-label={`Set what each ${one} contains`} onClick={() => set('contentsAmount', 0)}>Set</button> : (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, flex: '1 1 100%' }}>
                <input className="input" type="number" inputMode="decimal" min={0} step="any" style={{ width: 100 }} value={value.contentsAmount || ''} onChange={(e) => set('contentsAmount', Math.max(0, Number(e.target.value) || 0))} aria-label="How much one contains" placeholder="20" />
                <UnitPicker value={value.contentsUnit || null} onChange={(k) => set('contentsUnit', k)} kinds={['count', 'weight', 'volume']} exclude={['each', unit]} label="What it contains" empty="Pick a unit" />
                <button type="button" className="link small" onClick={() => onChange({ ...value, contentsAmount: null, contentsUnit: '', usageUnit: value.usageUnit === value.contentsUnit ? '' : value.usageUnit })}>Clear</button>
              </div>
            )}
          </div>
        )}
        {!loose && !contentsGiveWeight(units, value) && (
          <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>Weight</b><small>Only needed to work out recipes and prices by weight</small></span>
            {value.weightAmount === null ? <button type="button" className="btn small" aria-label="Set its weight" onClick={() => set('weightAmount', 0)}>Set</button> : (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, flex: '1 1 100%' }}>
                <input className="input" type="number" inputMode="decimal" min={0} step="any" style={{ width: 100 }} value={value.weightAmount || ''} onChange={(e) => set('weightAmount', Math.max(0, Number(e.target.value) || 0))} aria-label="What one weighs" placeholder="30" />
                <select className="input" style={{ width: 'auto' }} value={value.weightUnit} onChange={(e) => set('weightUnit', e.target.value)} aria-label="Weight in">
                  {weightUnits(units).map((k) => <option key={k} value={k}>{units.find(k)?.many ?? k}</option>)}
                </select>
                <button type="button" className="link small" onClick={() => onChange({ ...value, weightAmount: null, usageUnit: isMeasure(units, value.usageUnit) ? '' : value.usageUnit })}>Clear</button>
              </div>
            )}
          </div>
        )}
        {usageAllowed && (
          <div className="numfield" style={{ flexWrap: 'wrap' }}><span><b>We use</b><small>{usage ? (usageWorks ? (lasts ? `${lasts[0]!.toUpperCase()}${lasts.slice(1)}.` : `That's ${usageText(item)}.`) : 'Give it a Weight first, or pick another unit.') : 'How fast it goes, so Larder knows when it runs out'}</small></span>
            {usage === null ? <button type="button" className="btn small" aria-label="Set how fast it's used" onClick={() => onChange({ ...value, usageAmount: 1 })}>Set</button> : (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6, flex: '1 1 100%' }}>
                {/* Two halves that each stay on one line: "1 tea bags" and "every 1 day". */}
                <span className="row" style={{ gap: 6 }}>
                  <Stepper small value={value.usageAmount!} onChange={(n) => set('usageAmount', n > 0 ? n : value.usageAmount)} min={0.1} step={1} label={`how many ${usageChoices.find((c) => c.key === value.usageUnit)?.label ?? 'of them'}`} />
                  {usageChoices.length > 1 ? (
                    <select className="input" style={{ width: 'auto' }} value={value.usageUnit} onChange={(e) => set('usageUnit', e.target.value)} aria-label="Used in">
                      {usageChoices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  ) : <span className="small">{usageChoices[0]!.label}</span>}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <span className="small">every</span>
                  <Stepper small value={value.usageEvery} onChange={(n) => set('usageEvery', Math.max(1, Math.round(n)))} min={1} label="every how many" />
                  <select className="input" style={{ width: 'auto' }} value={value.usagePer} onChange={(e) => set('usagePer', e.target.value as 'day' | 'week')} aria-label="Days or weeks">
                    <option value="day">{value.usageEvery === 1 ? 'day' : 'days'}</option>
                    <option value="week">{value.usageEvery === 1 ? 'week' : 'weeks'}</option>
                  </select>
                </span>
                <button type="button" className="link small" onClick={() => onChange({ ...value, usageAmount: null, usageUnit: '', takeOut: false, inUseSince: '' })}>Clear</button>
              </div>
            )}
          </div>
        )}
        {usageAllowed && usage && (
          <div className="numfield"><span><b>Take them out of stock for me</b><small>{usage.unit ? (value.takeOut ? `Larder takes ${usageText(item)} out a little at a time, so you don't press Use` : `Or press Use when a ${one} is finished`) : value.takeOut ? 'Larder takes them out as they\'re used, so you don\'t press Use. Press Use only for an extra one' : 'Or press Use as each one is used'}</small></span>
            <Switch checked={value.takeOut} onChange={takeOut} label="Take them out of stock for me" />
          </div>
        )}
        {usageAllowed && usage && (
          <div className="numfield"><span><b>{usage.everyDays >= 2 && usage.amount <= 1 && !usage.unit ? 'The one in use started' : 'Counting from'}</b><small>{usage.unit ? 'The day Larder counts from' : value.takeOut ? 'Larder takes the next out once this period is up. Blank: none started yet, so the next Use starts one' : 'Leave blank if none has been started'}</small></span>
            <input className="input" type="date" style={{ width: 170 }} value={value.inUseSince} onChange={(e) => set('inUseSince', e.target.value)} aria-label="Started on" />
          </div>
        )}
        <div className="numfield"><span><b>Running low below</b><small>Puts it on the shopping list{worth !== null ? ` · ${worthText(worth)}` : ''}</small></span>
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
