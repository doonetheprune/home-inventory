/**
 * Recipes UI: saved recipes, what's missing, amounts by preset or by what you've got, and "Cooked it" (propose, adjust, confirm);
 * the recipes that use an item, on its page; and a scenario's recipes, on the scenario's page.
 */
import { useState } from 'react';
import { isLoose } from '@larder/core';
import {
  api, defineWebModule, Empty, Header, Icon, Link, Loading, Pill, qty, Sheet, Stepper, Switch, useAction, useModuleEnabled, useModuleParams, useNavigate, useQuery, useUnits,
  type ProductDetail,
} from '@larder/web-sdk';

interface Have { name: string; productId: string | null; item: string | null; amount: string; quantity: number | null; unit: string | null; inStock: number | null; status: 'have' | 'short' | 'none' | 'unknown'; optional: boolean; ratio: number | null; ratioUnit: string; shown: string; label: string; scales: boolean; need: number | null }
interface Preset { name: string; times: number }
interface Scale { kind: 'saved' | 'preset' | 'servings' | 'times' | 'have'; times: number; preset: string | null; servings: number | null; by: string; limitedBy: string | null }
interface Recipe {
  id: string; title: string; serves: number | null; ingredients: Have[]; method: string; notes: string; source: string; lastCookedAt: string | null; timesCooked: number; missing: string[];
  presets: Preset[]; defaultPreset: string | null; scale: Scale;
  scenarioIds: string[]; scenarioOnly: boolean; scenarios: Array<{ id: string; name: string }>; hidden: boolean;
}
interface Proposal { id: string; recipe: string; items: Array<{ productId: string; name: string; quantity: number; unit: string; inStock: number }>; skipped: string[] }
/** How much to make, as the API takes it. */
interface Ask { preset?: string; times?: number; servings?: number; have?: Array<{ ingredient: string; amount: number }> }

const call = <T,>(method: string, path: string, body?: unknown) => api.modules.call<T>('recipes', method, path, body);
const STATUS: Record<Have['status'], [string, string]> = { have: ['ok', 'In'], short: ['soon', 'Not enough'], none: ['low', 'None in'], unknown: ['plain', 'Not tracked'] };
const useRecipes = (query = '') => useQuery({ queryKey: ['recipes', 'list', query], queryFn: () => call<Recipe[]>('GET', `/${query ? `?${query}` : ''}`) });
const metaOf = (r: Recipe) => `${r.missing.length ? `Missing ${r.missing.join(', ')}` : 'You have everything'}${r.timesCooked ? ` · cooked ${r.timesCooked}×` : ''}`;

function RecipeRows({ list, showScenarios }: { list: Recipe[]; showScenarios?: boolean }) {
  return (
    <div className="list">
      {list.map((r) => (
        <Link key={r.id} className="item" to={`/m/recipes/${r.id}`}>
          <span className="tile"><Icon name="book" /></span>
          <span className="item-main"><span className="item-name">{r.title}</span><span className="item-meta">{showScenarios && r.scenarios.length ? `${r.scenarios.map((x) => x.name).join(', ')} · ` : ''}{metaOf(r)}</span></span>
          <Icon name="chev" size="sm" />
        </Link>
      ))}
    </div>
  );
}

const times = (t: number) => `×${Math.round(t * 100) / 100}`;

/** "The Family preset (×2)", "From 2 eggs (×0.67)", "As saved". */
function scaleText(s: Scale): string {
  if (s.kind === 'preset') return `The ${s.preset} preset (${times(s.times)})`;
  if (s.kind === 'have') return `From ${s.by} (${times(s.times)})${s.limitedBy ? `, limited by the ${s.limitedBy}` : ''}`;
  if (s.kind === 'servings') return `For ${s.servings} (${times(s.times)})`;
  if (s.kind === 'times') return `${times(s.times)} the recipe`;
  return 'As saved';
}

function RecipeList() {
  const list = useRecipes();
  const kept = useRecipes('show=scenario-only');
  return (
    <>
      <Header title="Recipes" back="/more">
        <Link className="iconbtn" to="/m/recipes/new" aria-label="Add a recipe"><Icon name="plus" /></Link>
      </Header>
      <div className="content" style={{ maxWidth: 760 }}>
        <p className="muted small">Recipes you liked, saved by you or an AI assistant. Ask it "what can I cook with what needs using up?", and to save the ones that work.</p>
        {list.isLoading ? <Loading /> : list.data?.length ? <RecipeRows list={list.data} />
          : !kept.data?.length && <Empty title="No saved recipes yet"><span className="small muted">Ask your AI assistant for ideas and to save the ones you like, or add one yourself.</span></Empty>}
        {kept.data && kept.data.length > 0 && (
          <details className="section">
            <summary className="label" style={{ cursor: 'pointer' }}><span>Kept for scenarios ({kept.data.length})</span><Icon name="chev" size="sm" /></summary>
            <p className="small muted">These only show on their scenario's page, so seasonal recipes stay out of the way.</p>
            <RecipeRows list={kept.data} showScenarios />
          </details>
        )}
      </div>
    </>
  );
}

function Cooked({ recipe, ask, onClose }: { recipe: Recipe; ask: Ask | null; onClose: () => void }) {
  // Untouched, it cooks the amounts on the page; changing "Made for" cooks for that many.
  const [servings, setServings] = useState<number | null>(null);
  const body: Ask = servings !== null ? { servings } : (ask ?? {});
  const proposal = useQuery({ queryKey: ['recipes', recipe.id, 'cook', body], queryFn: () => call<Proposal>('POST', `/${recipe.id}/cook`, body), staleTime: Infinity });
  const [changes, setChanges] = useState<Record<string, number>>({});
  const { run, busy } = useAction();
  const units = useUnits();
  const p = proposal.data;
  const confirm = async () => {
    if (!p) return;
    const items = p.items.map((i) => ({ productId: i.productId, quantity: changes[i.productId] ?? i.quantity }));
    const r = await run(() => call<{ used: number }>('POST', `/proposals/${p.id}/confirm`, { items }), (x) => (x.used ? `Took ${x.used} ingredient${x.used === 1 ? '' : 's'} out of stock` : 'Nothing taken out'));
    if (r) onClose();
  };
  const madeFor = servings ?? Math.max(1, Math.round((recipe.serves ?? 1) * recipe.scale.times));
  return (
    <Sheet title={`Cooked ${recipe.title}`} onClose={onClose}>
      <div className="stack">
        {recipe.serves && (
          <div className="numfield">
            <span><b>Made for</b><small>{servings === null && recipe.scale.kind !== 'saved' ? scaleText(recipe.scale) : `The recipe serves ${recipe.serves}`}</small></span>
            <Stepper value={madeFor} onChange={(n) => { setServings(n); setChanges({}); }} min={1} max={40} label="people" />
          </div>
        )}
        {!p ? <Loading /> : (
          <>
            <p className="small muted">This is what Larder will take out of stock. Change anything you used more or less of.</p>
            <div className="list">
              {p.items.map((i) => (
                <div className="numfield" key={i.productId}>
                  <span><b>{i.name}</b><small>{qty(i.inStock, i.unit)} in</small></span>
                  <Stepper value={changes[i.productId] ?? i.quantity} onChange={(n) => setChanges({ ...changes, [i.productId]: n })} min={0} max={i.inStock} step={isLoose(units, { unit: i.unit }) ? 10 : 1} label={i.unit} />
                </div>
              ))}
              {!p.items.length && <div className="item"><span className="muted small">Nothing to take: none of the ingredients has an amount in Larder's units.</span></div>}
            </div>
            {p.skipped.length > 0 && <p className="small muted">Not taken: {p.skipped.join(', ')}.</p>}
            <div className="btnrow">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void confirm()}>Take them out</button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** "I've got…": how much of one ingredient there is; Larder works out the rest from the ratios. */
function GotSheet({ recipe, onDone, onClose }: { recipe: Recipe; onDone: (ask: Ask) => void; onClose: () => void }) {
  const scalable = recipe.ingredients.filter((i) => i.scales);
  const [name, setName] = useState(scalable[0]?.name ?? '');
  const [amount, setAmount] = useState('');
  const { run, busy } = useAction();
  const chosen = scalable.find((i) => i.name === name);
  const unit = chosen ? (chosen.ratio ? chosen.ratioUnit : (chosen.unit ?? '')) : '';
  const n = Number(amount.replace(',', '.'));
  const work = async () => {
    const ask = { have: [{ ingredient: name, amount: n }] };
    // Checked first, so a mistake shows as a message and the page keeps its amounts.
    if (await run(() => call<Recipe>('POST', `/${recipe.id}/scale`, ask))) onDone(ask);
  };
  return (
    <Sheet title="Work it out from what you've got" onClose={onClose}>
      <div className="stack">
        <p className="small muted">Say how much you've got of one ingredient, and Larder works out the rest from the recipe's ratios.</p>
        <label className="field"><span>Ingredient</span>
          <select className="input" value={name} onChange={(e) => setName(e.target.value)}>{scalable.map((i, k) => <option key={k} value={i.name}>{i.name}</option>)}</select>
        </label>
        <label className="field"><span>{unit && unit !== 'each' ? `How much (${unit})` : 'How many'}</span>
          <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ maxWidth: 160 }} />
        </label>
        <div className="btnrow">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !(n > 0) || !name} onClick={() => void work()}>Work it out</button>
        </div>
      </div>
    </Sheet>
  );
}

function SavePresetSheet({ recipe, onSaved, onClose }: { recipe: Recipe; onSaved: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [isDefault, setDefault] = useState(false);
  const { run, busy } = useAction();
  const save = async () => {
    const n = name.trim();
    const r = await run(() => call<Recipe>('POST', `/${recipe.id}/presets`, { name: n, times: recipe.scale.times, default: isDefault }), `Saved the ${n} preset`);
    if (r) onSaved(r.presets.find((p) => p.name.toLowerCase() === n.toLowerCase())?.name ?? n);
  };
  return (
    <Sheet title="Save these amounts" onClose={onClose}>
      <div className="stack">
        <p className="small muted">{scaleText(recipe.scale)}. Keep it as a preset to pick it again here, or ask your assistant for it by name.</p>
        <label className="field"><span>Name</span><input className="input" placeholder="e.g. Family, Just me" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="numfield">
          <span><b>Use it by default</b><small>Shown, cooked and used by assistants unless you pick another</small></span>
          <Switch checked={isDefault} onChange={setDefault} label="Use it by default" />
        </div>
        <div className="btnrow">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>Save preset</button>
        </div>
      </div>
    </Sheet>
  );
}

function RecipePage() {
  const { id } = useModuleParams();
  // The amounts picked for this recipe; none means its default preset (or the amounts as saved).
  const [asked, setAsked] = useState<{ id: string | undefined; ask: Ask } | null>(null);
  const ask = asked && asked.id === id ? asked.ask : null;
  const setAsk = (a: Ask) => setAsked({ id, ask: a });
  const r = useQuery({
    queryKey: ['recipes', id, 'scale', ask],
    queryFn: () => (ask ? call<Recipe>('POST', `/${encodeURIComponent(id ?? '')}/scale`, ask) : call<Recipe>('GET', `/${encodeURIComponent(id ?? '')}`)),
    // Keep the amounts on screen while others load, but never another recipe's.
    placeholderData: (previous) => (previous?.id === id ? previous : undefined),
  });
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<'cooked' | 'got' | 'save' | null>(null);
  const [confirm, setConfirm] = useState(false);
  if (r.isLoading) return <Loading />;
  if (!r.data) return <><Header title="Recipe" back="/m/recipes" /><div className="content"><Empty title="That recipe no longer exists" /></div></>;
  const recipe = r.data;
  const s = recipe.scale;
  const missingLinked = recipe.ingredients.filter((i) => !i.optional && i.productId && (i.status === 'none' || i.status === 'short'));
  const canScale = recipe.ingredients.some((i) => i.scales);
  const custom = s.kind !== 'saved' && s.kind !== 'preset';
  return (
    <>
      <Header title={recipe.title} back="/m/recipes">
        <Link className="iconbtn" to={`/m/recipes/${recipe.id}/edit`} aria-label="Edit"><Icon name="edit" /></Link>
      </Header>
      <div className="content">
        <div className="cols-2">
          <div className="stack" style={{ alignContent: 'start' }}>
            <div className="label">Ingredients{recipe.serves ? ` · serves ${recipe.serves}` : ''}</div>
            {(canScale || recipe.presets.length > 0) && (
              <div className="chips wrap" role="group" aria-label="Amounts">
                <button type="button" className={`chip ${s.kind === 'saved' ? 'on' : ''}`} aria-pressed={s.kind === 'saved'} onClick={() => setAsk({ times: 1 })}>As saved</button>
                {recipe.presets.map((p) => {
                  const on = s.kind === 'preset' && s.preset === p.name;
                  return <button key={p.name} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setAsk({ preset: p.name })}>{p.name} <span className="n">{times(p.times)}</span></button>;
                })}
                {canScale && <button type="button" className={`chip ${s.kind === 'have' ? 'on' : ''}`} aria-pressed={s.kind === 'have'} onClick={() => setSheet('got')}><Icon name="sliders" size="sm" />I've got…</button>}
              </div>
            )}
            {s.kind !== 'saved' && (
              <p className="small muted" style={{ margin: 0 }}>
                {scaleText(s)}{s.preset && s.preset === recipe.defaultPreset ? ', the default' : ''}.{' '}
                {custom && <button type="button" className="btn small" onClick={() => setSheet('save')}><Icon name="plus" size="sm" />Save as preset</button>}
              </p>
            )}
            <div className="list">
              {recipe.ingredients.map((i, n) => {
                const [kind, text] = STATUS[i.status];
                const row = (
                  <>
                    <span className="item-main">
                      <span className="item-name">{i.label}{i.optional ? ' (optional)' : ''}</span>
                      {(i.item || (!i.scales && s.times !== 1)) && (
                        <span className="item-meta">{i.item ? `${i.item}: ${qty(i.inStock ?? 0, i.unit ?? 'each')} in` : ''}{i.item && !i.scales && s.times !== 1 ? ' · ' : ''}{!i.scales && s.times !== 1 ? 'Not scaled' : ''}</span>
                      )}
                    </span>
                    <Pill kind={kind}>{text}</Pill>
                  </>
                );
                // A linked ingredient opens its item: where it is, and every recipe that uses it.
                return i.productId ? <Link className="item" key={n} to={`/products/${i.productId}`}>{row}</Link> : <div className="item" key={n}>{row}</div>;
              })}
            </div>
            <div className="btnrow">
              <button type="button" className="btn primary" onClick={() => setSheet('cooked')}><Icon name="check" size="sm" />Cooked it</button>
              {missingLinked.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => void run(() => call<{ added: string[] }>('POST', `/${recipe.id}/missing-to-list`, ask ?? undefined), (x) => `On the list: ${x.added.join(', ')}`)}><Icon name="cart" size="sm" />Add missing to list</button>}
            </div>
            {recipe.lastCookedAt && <p className="small muted">Cooked {recipe.timesCooked} time{recipe.timesCooked === 1 ? '' : 's'}, last on {new Date(recipe.lastCookedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.</p>}
          </div>
          <div className="stack" style={{ alignContent: 'start' }}>
            <div className="label">Method</div>
            <div className="card pad" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{recipe.method || <span className="muted">No method saved.</span>}</div>
            {recipe.notes && <div className="card pad small" style={{ whiteSpace: 'pre-wrap' }}><b>Notes</b><br />{recipe.notes}</div>}
            {recipe.source && <p className="small muted">From {recipe.source}.</p>}
            {recipe.scenarios.length > 0 && (
              <p className="small muted">
                {recipe.hidden ? 'Only shows in ' : 'Also in '}
                {recipe.scenarios.map((x, n) => <span key={x.id}>{n ? ', ' : ''}<Link to={`/m/scenarios/${x.id}`}>{x.name}</Link></span>)}.
              </p>
            )}
          </div>
        </div>
        <div className="card pad">
          <b>Forget this recipe</b>
          {confirm ? (
            <div className="btnrow"><button type="button" className="btn" onClick={() => setConfirm(false)}>Keep it</button><button type="button" className="btn danger" disabled={busy} onClick={() => void run(() => call('DELETE', `/${recipe.id}`), 'Forgotten').then((x) => x !== undefined && navigate('/m/recipes', { replace: true }))}>Yes, forget it</button></div>
          ) : <button type="button" className="btn danger" onClick={() => setConfirm(true)}><Icon name="trash" size="sm" />Forget</button>}
        </div>
      </div>
      {sheet === 'cooked' && <Cooked recipe={recipe} ask={ask} onClose={() => setSheet(null)} />}
      {sheet === 'got' && <GotSheet recipe={recipe} onDone={(a) => { setAsk(a); setSheet(null); }} onClose={() => setSheet(null)} />}
      {sheet === 'save' && <SavePresetSheet recipe={recipe} onSaved={(name) => { setAsk({ preset: name }); setSheet(null); }} onClose={() => setSheet(null)} />}
    </>
  );
}

/** An ingredient being edited. It keeps its link to a Larder item unless its name changes. */
interface Row { name: string; amount: string; quantity: string; ratio: string; ratioUnit: string; optional: boolean; productId?: string | null; linkedAs?: string }
interface PresetRow { name: string; times: string }
const emptyRow = (): Row => ({ name: '', amount: '', quantity: '', ratio: '', ratioUnit: '', optional: false });
const decimal = (s: string) => Number(s.replace(',', '.'));

interface Form { title: string; serves: string; method: string; notes: string; rows: Row[]; presets: PresetRow[]; defaultIndex: number | null; scenarioIds: string[]; scenarioOnly: boolean }

/** Which scenarios the recipe is in, and whether it only shows there. Only while the scenarios module is on. */
function ScenarioPicker({ f, set }: { f: Form; set: (patch: Partial<Form>) => void }) {
  const on = useModuleEnabled('scenarios');
  const list = useQuery({ queryKey: ['scenarios'], queryFn: () => api.modules.call<Array<{ id: string; name: string }>>('scenarios', 'GET', '/'), enabled: on });
  if (!on || !list.data?.length) return null;
  return (
    <>
      <div className="label">Scenarios</div>
      <div className="chips wrap">
        {list.data.map((s) => {
          const picked = f.scenarioIds.includes(s.id);
          const scenarioIds = picked ? f.scenarioIds.filter((x) => x !== s.id) : [...f.scenarioIds, s.id];
          return <button type="button" key={s.id} className={`chip ${picked ? 'on' : ''}`} aria-pressed={picked} onClick={() => set({ scenarioIds, scenarioOnly: f.scenarioOnly && scenarioIds.length > 0 })}>{s.name}</button>;
        })}
      </div>
      {f.scenarioIds.length > 0 && (
        <div className="numfield">
          <span><b>Only show in these scenarios</b><small>Keeps it off the main Recipes list, e.g. a Halloween recipe at Christmas</small></span>
          <Switch checked={f.scenarioOnly} onChange={(v) => set({ scenarioOnly: v })} label="Only show in these scenarios" />
        </div>
      )}
    </>
  );
}

function RecipeEditor() {
  const { id, scenario } = useModuleParams();
  const editing = id && id !== 'new' ? id : null;
  const existing = useQuery({ queryKey: ['recipes', editing], queryFn: () => call<Recipe>('GET', `/${encodeURIComponent(editing!)}`), enabled: !!editing });
  const [form, setForm] = useState<Form | null>(null);
  const { run, busy } = useAction();
  const navigate = useNavigate();
  if (editing && existing.isLoading) return <Loading />;
  const e = existing.data;
  const defaultAt = e?.defaultPreset ? e.presets.findIndex((p) => p.name === e.defaultPreset) : -1;
  const f: Form = form ?? (e
    ? {
        title: e.title, serves: e.serves ? String(e.serves) : '', method: e.method, notes: e.notes,
        rows: e.ingredients.map((i) => ({ name: i.name, amount: i.amount, quantity: i.quantity ? String(i.quantity) : '', ratio: i.ratio ? String(i.ratio) : '', ratioUnit: i.ratioUnit, optional: i.optional, productId: i.productId, linkedAs: i.name })),
        presets: e.presets.map((p) => ({ name: p.name, times: String(p.times) })),
        defaultIndex: defaultAt >= 0 ? defaultAt : null,
        // Only scenarios that still exist; a removed one would be refused.
        scenarioIds: e.scenarios.map((x) => x.id), scenarioOnly: e.hidden,
      }
    // Made from a scenario's page: in that scenario, and (as it's usually seasonal) only there.
    : { title: '', serves: '', method: '', notes: '', rows: [emptyRow()], presets: [], defaultIndex: null, scenarioIds: scenario ? [scenario] : [], scenarioOnly: !!scenario });
  const set = (patch: Partial<typeof f>) => setForm({ ...f, ...patch });
  const setRow = (n: number, patch: Partial<Row>) => set({ rows: f.rows.map((r, i) => (i === n ? { ...r, ...patch } : r)) });
  const setPreset = (n: number, patch: Partial<PresetRow>) => set({ presets: f.presets.map((p, i) => (i === n ? { ...p, ...patch } : p)) });
  const save = async () => {
    const kept = f.presets.map((p, n) => ({ ...p, n })).filter((p) => p.name.trim() && decimal(p.times) > 0);
    const body = {
      title: f.title.trim(), serves: f.serves ? Number(f.serves) : null, method: f.method, notes: f.notes, scenarioIds: f.scenarioIds, scenarioOnly: f.scenarioOnly && f.scenarioIds.length > 0,
      ingredients: f.rows.filter((r) => r.name.trim()).map((r) => ({
        name: r.name.trim(), amount: r.amount.trim() || undefined, quantity: decimal(r.quantity) > 0 ? decimal(r.quantity) : undefined, optional: r.optional,
        ratio: decimal(r.ratio) > 0 ? decimal(r.ratio) : null, ratioUnit: r.ratioUnit.trim(),
        // Renamed rows are matched again by their new name.
        ...(r.productId && r.name.trim() === r.linkedAs ? { productId: r.productId } : {}),
      })),
      presets: kept.map((p) => ({ name: p.name.trim(), times: decimal(p.times) })),
      defaultPreset: kept.find((p) => p.n === f.defaultIndex)?.name.trim() ?? null,
    };
    const saved = await run(() => (editing ? call<Recipe>('PUT', `/${encodeURIComponent(editing!)}`, body) : call<Recipe>('POST', '/', body)), 'Saved');
    if (saved) navigate(`/m/recipes/${saved.id}`, { replace: true });
  };
  return (
    <>
      <Header title={editing ? 'Edit recipe' : 'New recipe'} back={editing ? `/m/recipes/${editing}` : scenario ? `/m/scenarios/${scenario}` : '/m/recipes'} />
      <div className="content" style={{ maxWidth: 760 }}>
        <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(ev) => set({ title: ev.target.value })} /></label>
        <label className="field"><span>Serves</span><input className="input" inputMode="numeric" value={f.serves} onChange={(ev) => set({ serves: ev.target.value.replace(/\D/g, '') })} style={{ maxWidth: 120 }} /></label>
        <div className="label">Ingredients</div>
        <p className="small muted">Names that match an item in Larder are linked to it. "Ratio" is how much goes in, in its own measure (2 eggs, 100 g flour): it's how the recipe is scaled to what you've got. "Uses" is how much comes out of stock when you cook it, in that item's own unit; leave it empty to use the ratio when it's in the same unit.</p>
        {f.rows.map((r, n) => (
          <div className="inputrow" key={n} style={{ flexWrap: 'wrap' }}>
            <input className="input" style={{ flex: '2 1 160px' }} placeholder="Ingredient" value={r.name} onChange={(ev) => setRow(n, { name: ev.target.value })} aria-label="Ingredient" />
            <input className="input" style={{ flex: '1 1 120px' }} placeholder="Amount" value={r.amount} onChange={(ev) => setRow(n, { amount: ev.target.value })} aria-label="Amount as written" />
            {/* The ratio and its unit stay together when the row wraps. */}
            <div className="inputrow" style={{ flex: '1 1 150px' }}>
              <input className="input" style={{ flex: '1 1 70px' }} inputMode="decimal" placeholder="Ratio" value={r.ratio} onChange={(ev) => setRow(n, { ratio: ev.target.value })} aria-label="Ratio" />
              <input className="input" style={{ flex: '1 1 60px' }} placeholder="g, ml…" value={r.ratioUnit} onChange={(ev) => setRow(n, { ratioUnit: ev.target.value })} aria-label="Ratio unit" />
            </div>
            <input className="input" style={{ flex: '0 1 80px' }} inputMode="decimal" placeholder="Uses" value={r.quantity} onChange={(ev) => setRow(n, { quantity: ev.target.value })} aria-label="Quantity taken from stock" />
            <button type="button" className="iconbtn ghost" aria-label="Remove ingredient" onClick={() => set({ rows: f.rows.filter((_, i) => i !== n) })}><Icon name="x" /></button>
          </div>
        ))}
        <button type="button" className="btn small" style={{ justifySelf: 'start' }} onClick={() => set({ rows: [...f.rows, emptyRow()] })}><Icon name="plus" size="sm" />Ingredient</button>
        <div className="label">Presets</div>
        <p className="small muted">Amounts you make often, as times the recipe above: "Just me" at 0.5, "Family" at 2. The default is shown and cooked unless you pick another.</p>
        {f.presets.map((p, n) => (
          <div className="inputrow" key={n}>
            <input className="input" style={{ flex: '2 1 140px' }} placeholder="Name" value={p.name} onChange={(ev) => setPreset(n, { name: ev.target.value })} aria-label="Preset name" />
            <input className="input" style={{ flex: '0 1 80px' }} inputMode="decimal" placeholder="Times" value={p.times} onChange={(ev) => setPreset(n, { times: ev.target.value })} aria-label="Times the recipe" />
            <button type="button" className={`chip sm ${f.defaultIndex === n ? 'on' : ''}`} aria-pressed={f.defaultIndex === n} onClick={() => set({ defaultIndex: f.defaultIndex === n ? null : n })}>Default</button>
            <button type="button" className="iconbtn ghost" aria-label="Remove preset" onClick={() => set({ presets: f.presets.filter((_, i) => i !== n), defaultIndex: f.defaultIndex === n ? null : f.defaultIndex !== null && f.defaultIndex > n ? f.defaultIndex - 1 : f.defaultIndex })}><Icon name="x" /></button>
          </div>
        ))}
        <button type="button" className="btn small" style={{ justifySelf: 'start' }} onClick={() => set({ presets: [...f.presets, { name: '', times: '1' }] })}><Icon name="plus" size="sm" />Preset</button>
        <label className="field"><span>Method</span><textarea className="input" rows={8} value={f.method} onChange={(ev) => set({ method: ev.target.value })} /></label>
        <label className="field"><span>Notes</span><textarea className="input" rows={3} value={f.notes} onChange={(ev) => set({ notes: ev.target.value })} /></label>
        <ScenarioPicker f={f} set={set} />
        <button type="button" className="btn primary" disabled={busy || !f.title.trim()} onClick={() => void save()}>Save</button>
      </div>
    </>
  );
}

/** On an item's page: the saved recipes that use it. */
function ItemRecipes({ product }: { product: ProductDetail }) {
  const list = useRecipes(`productId=${encodeURIComponent(product.product.id)}`);
  if (!list.data?.length) return null;
  return (
    <div className="section">
      <div className="label">Recipes <Link to="/m/recipes">All recipes</Link></div>
      <RecipeRows list={list.data} showScenarios />
    </div>
  );
}

/** On a scenario's page: its recipes, and adding one for it. */
function ScenarioRecipes({ id }: { id: string }) {
  const list = useRecipes(`scenarioId=${encodeURIComponent(id)}`);
  return (
    <div className="section">
      <div className="label">Recipes <Link to={`/m/recipes/new/${encodeURIComponent(id)}`}>Add one</Link></div>
      {list.data?.length ? <RecipeRows list={list.data} /> : <p className="small muted">None yet. Recipes added here only show in this scenario, unless you say otherwise.</p>}
    </div>
  );
}

export default defineWebModule({
  id: 'recipes',
  // Recipes, and the lists on item and scenario pages, are in offline copies.
  offline: true,
  productPanels: [ItemRecipes],
  panels: [{ slot: 'scenarios.scenario', component: ScenarioRecipes }],
  pages: [
    { path: '/', title: 'Recipes', icon: 'book', subtitle: 'Saved, with what\'s missing', component: RecipeList },
    { path: '/new', title: 'New recipe', hidden: true, component: RecipeEditor },
    { path: '/new/:scenario', title: 'New recipe', hidden: true, component: RecipeEditor },
    { path: '/:id', title: 'Recipe', component: RecipePage },
    { path: '/:id/edit', title: 'Edit recipe', component: RecipeEditor },
  ],
});
