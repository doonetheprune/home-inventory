/**
 * Recipes UI: saved recipes, what's missing, and "Cooked it" (propose, adjust, confirm);
 * the recipes that use an item, on its page; and a scenario's recipes, on the scenario's page.
 */
import { useState } from 'react';
import {
  api, defineWebModule, Empty, Header, Icon, Link, Loading, Pill, qty, Sheet, Stepper, Switch, useAction, useModuleEnabled, useModuleParams, useNavigate, useQuery,
  type ProductDetail,
} from '@larder/web-sdk';

interface Have { name: string; productId: string | null; item: string | null; amount: string; quantity: number | null; unit: string | null; inStock: number | null; status: 'have' | 'short' | 'none' | 'unknown'; optional: boolean }
interface Recipe {
  id: string; title: string; serves: number | null; ingredients: Have[]; method: string; notes: string; source: string; lastCookedAt: string | null; timesCooked: number; missing: string[];
  scenarioIds: string[]; scenarioOnly: boolean; scenarios: Array<{ id: string; name: string }>; hidden: boolean;
}
interface Proposal { id: string; recipe: string; items: Array<{ productId: string; name: string; quantity: number; unit: string; inStock: number }>; skipped: string[] }

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

function Cooked({ recipe, onClose }: { recipe: Recipe; onClose: () => void }) {
  const [servings, setServings] = useState(recipe.serves ?? 1);
  const proposal = useQuery({ queryKey: ['recipes', recipe.id, 'cook', servings], queryFn: () => call<Proposal>('POST', `/${recipe.id}/cook`, recipe.serves ? { servings } : {}), staleTime: Infinity });
  const [changes, setChanges] = useState<Record<string, number>>({});
  const { run, busy } = useAction();
  const p = proposal.data;
  const confirm = async () => {
    if (!p) return;
    const items = p.items.map((i) => ({ productId: i.productId, quantity: changes[i.productId] ?? i.quantity }));
    const r = await run(() => call<{ used: number }>('POST', `/proposals/${p.id}/confirm`, { items }), (x) => (x.used ? `Took ${x.used} ingredient${x.used === 1 ? '' : 's'} out of stock` : 'Nothing taken out'));
    if (r) onClose();
  };
  return (
    <Sheet title={`Cooked ${recipe.title}`} onClose={onClose}>
      <div className="stack">
        {recipe.serves && <div className="numfield"><span><b>Made for</b><small>The recipe serves {recipe.serves}</small></span><Stepper value={servings} onChange={setServings} min={1} max={40} label="people" /></div>}
        {!p ? <Loading /> : (
          <>
            <p className="small muted">This is what Larder will take out of stock. Change anything you used more or less of.</p>
            <div className="list">
              {p.items.map((i) => (
                <div className="numfield" key={i.productId}>
                  <span><b>{i.name}</b><small>{qty(i.inStock, i.unit)} in</small></span>
                  <Stepper value={changes[i.productId] ?? i.quantity} onChange={(n) => setChanges({ ...changes, [i.productId]: n })} min={0} max={i.inStock} step={i.unit === 'g' || i.unit === 'ml' ? 10 : 1} label={i.unit} />
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

function RecipePage() {
  const { id } = useModuleParams();
  const r = useQuery({ queryKey: ['recipes', id], queryFn: () => call<Recipe>('GET', `/${encodeURIComponent(id ?? '')}`) });
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const [cooking, setCooking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (r.isLoading) return <Loading />;
  if (!r.data) return <><Header title="Recipe" back="/m/recipes" /><div className="content"><Empty title="That recipe no longer exists" /></div></>;
  const recipe = r.data;
  const missingLinked = recipe.ingredients.filter((i) => !i.optional && i.productId && (i.status === 'none' || i.status === 'short'));
  return (
    <>
      <Header title={recipe.title} back="/m/recipes">
        <Link className="iconbtn" to={`/m/recipes/${recipe.id}/edit`} aria-label="Edit"><Icon name="edit" /></Link>
      </Header>
      <div className="content">
        <div className="cols-2">
          <div className="stack" style={{ alignContent: 'start' }}>
            <div className="label">Ingredients{recipe.serves ? ` · serves ${recipe.serves}` : ''}</div>
            <div className="list">
              {recipe.ingredients.map((i, n) => {
                const [kind, text] = STATUS[i.status];
                const row = (
                  <>
                    <span className="item-main">
                      <span className="item-name">{i.amount ? `${i.amount} ` : ''}{i.name}{i.optional ? ' (optional)' : ''}</span>
                      {i.item && <span className="item-meta">{i.item}: {qty(i.inStock ?? 0, i.unit ?? 'each')} in</span>}
                    </span>
                    <Pill kind={kind}>{text}</Pill>
                  </>
                );
                // A linked ingredient opens its item: where it is, and every recipe that uses it.
                return i.productId ? <Link className="item" key={n} to={`/products/${i.productId}`}>{row}</Link> : <div className="item" key={n}>{row}</div>;
              })}
            </div>
            <div className="btnrow">
              <button type="button" className="btn primary" onClick={() => setCooking(true)}><Icon name="check" size="sm" />Cooked it</button>
              {missingLinked.length > 0 && <button type="button" className="btn" disabled={busy} onClick={() => void run(() => call<{ added: string[] }>('POST', `/${recipe.id}/missing-to-list`), (x) => `On the list: ${x.added.join(', ')}`)}><Icon name="cart" size="sm" />Add missing to list</button>}
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
      {cooking && <Cooked recipe={recipe} onClose={() => setCooking(false)} />}
    </>
  );
}

/** An ingredient being edited. It keeps its link to a Larder item unless its name changes. */
interface Row { name: string; amount: string; quantity: string; optional: boolean; productId?: string | null; linkedAs?: string }

interface Form { title: string; serves: string; method: string; notes: string; rows: Row[]; scenarioIds: string[]; scenarioOnly: boolean }

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
  const f: Form = form ?? (existing.data
    ? {
      title: existing.data.title, serves: existing.data.serves ? String(existing.data.serves) : '', method: existing.data.method, notes: existing.data.notes,
      rows: existing.data.ingredients.map((i) => ({ name: i.name, amount: i.amount, quantity: i.quantity ? String(i.quantity) : '', optional: i.optional, productId: i.productId, linkedAs: i.name })),
      // Only scenarios that still exist; a removed one would be refused.
      scenarioIds: existing.data.scenarios.map((x) => x.id), scenarioOnly: existing.data.hidden,
    }
    // Made from a scenario's page: in that scenario, and (as it's usually seasonal) only there.
    : { title: '', serves: '', method: '', notes: '', rows: [{ name: '', amount: '', quantity: '', optional: false }], scenarioIds: scenario ? [scenario] : [], scenarioOnly: !!scenario });
  const set = (patch: Partial<typeof f>) => setForm({ ...f, ...patch });
  const setRow = (n: number, patch: Partial<Row>) => set({ rows: f.rows.map((r, i) => (i === n ? { ...r, ...patch } : r)) });
  const save = async () => {
    const body = {
      title: f.title.trim(), serves: f.serves ? Number(f.serves) : null, method: f.method, notes: f.notes, scenarioIds: f.scenarioIds, scenarioOnly: f.scenarioOnly && f.scenarioIds.length > 0,
      ingredients: f.rows.filter((r) => r.name.trim()).map((r) => ({
        name: r.name.trim(), amount: r.amount.trim() || undefined, quantity: Number(r.quantity) > 0 ? Number(r.quantity) : undefined, optional: r.optional,
        // Renamed rows are matched again by their new name.
        ...(r.productId && r.name.trim() === r.linkedAs ? { productId: r.productId } : {}),
      })),
    };
    const saved = await run(() => (editing ? call<Recipe>('PUT', `/${encodeURIComponent(editing!)}`, body) : call<Recipe>('POST', '/', body)), 'Saved');
    if (saved) navigate(`/m/recipes/${saved.id}`, { replace: true });
  };
  return (
    <>
      <Header title={editing ? 'Edit recipe' : 'New recipe'} back={editing ? `/m/recipes/${editing}` : scenario ? `/m/scenarios/${scenario}` : '/m/recipes'} />
      <div className="content" style={{ maxWidth: 760 }}>
        <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="field"><span>Serves</span><input className="input" inputMode="numeric" value={f.serves} onChange={(e) => set({ serves: e.target.value.replace(/\D/g, '') })} style={{ maxWidth: 120 }} /></label>
        <div className="label">Ingredients</div>
        <p className="small muted">Names that match an item in Larder are linked to it. "Uses" is how much comes out of stock when you cook it, in that item's own unit.</p>
        {f.rows.map((r, n) => (
          <div className="inputrow" key={n} style={{ flexWrap: 'wrap' }}>
            <input className="input" style={{ flex: '2 1 160px' }} placeholder="Ingredient" value={r.name} onChange={(e) => setRow(n, { name: e.target.value })} aria-label="Ingredient" />
            <input className="input" style={{ flex: '1 1 90px' }} placeholder="Amount, e.g. 400 g" value={r.amount} onChange={(e) => setRow(n, { amount: e.target.value })} aria-label="Amount as written" />
            <input className="input" style={{ flex: '0 1 80px' }} inputMode="decimal" placeholder="Uses" value={r.quantity} onChange={(e) => setRow(n, { quantity: e.target.value })} aria-label="Quantity taken from stock" />
            <button type="button" className="iconbtn ghost" aria-label="Remove ingredient" onClick={() => set({ rows: f.rows.filter((_, i) => i !== n) })}><Icon name="x" /></button>
          </div>
        ))}
        <button type="button" className="btn small" style={{ justifySelf: 'start' }} onClick={() => set({ rows: [...f.rows, { name: '', amount: '', quantity: '', optional: false }] })}><Icon name="plus" size="sm" />Ingredient</button>
        <label className="field"><span>Method</span><textarea className="input" rows={8} value={f.method} onChange={(e) => set({ method: e.target.value })} /></label>
        <label className="field"><span>Notes</span><textarea className="input" rows={3} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
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
