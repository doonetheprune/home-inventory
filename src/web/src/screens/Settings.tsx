import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Icon } from '../icons';
import { ago } from '../format';
import { Header, Stepper, Switch, useAction, useCategories, useModules, useToast } from '../ui';

export function Settings() {
  const status = useQuery({ queryKey: ['auth', 'status'], queryFn: api.auth.status });
  const admin = status.data?.user?.role === 'admin';
  const local = status.data?.mode === 'local';
  return (
    <>
      <Header title="Settings" back="/more" />
      <div className="content" style={{ maxWidth: 860 }}>
        <Household admin={admin} />
        <Categories admin={admin} />
        <Modules admin={admin} />
        {local && <Tokens />}
        {local && <Accounts admin={admin} />}
        <Data admin={admin} />
      </div>
    </>
  );
}

function Household({ admin }: { admin: boolean }) {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const [warn, setWarn] = useState(7);
  useEffect(() => {
    if (data) {
      setName(data.householdName);
      setWarn(data.expiryWarningDays);
    }
  }, [data]);
  return (
    <div className="section">
      <div className="label">Household</div>
      <div className="list">
        <label className="numfield"><span><b>Name</b></span><input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!admin} style={{ maxWidth: '60%', textAlign: 'right', padding: '8px 10px' }} /></label>
        <div className="numfield"><span><b>Warn before expiry</b><small>Days ahead, unless a category says otherwise</small></span><Stepper value={warn} onChange={setWarn} min={0} max={365} label="days" /></div>
      </div>
      {admin && <button type="button" className="btn" style={{ justifySelf: 'start' }} disabled={busy} onClick={() => run(() => api.settings.update({ householdName: name.trim() || 'Our house', expiryWarningDays: warn }), 'Saved')}>Save</button>}
    </div>
  );
}

function Categories({ admin }: { admin: boolean }) {
  const categories = useCategories();
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  return (
    <div className="section">
      <div className="label">Categories</div>
      <div className="list">
        {categories.map((c) => (
          <div className="numfield" key={c.id}>
            <span><b>{c.name}</b><small>{c.warnDays === null ? 'Household warning' : `Warns ${c.warnDays} days before expiry`}</small></span>
            <div className="row">
              {c.warnDays === null ? (
                <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.categories.update(c.id, { warnDays: 14 }), 'Saved')}>Own warning</button>
              ) : (
                <>
                  <Stepper small value={c.warnDays} onChange={(n) => void run(() => api.categories.update(c.id, { warnDays: Math.round(n) }))} min={0} max={365} label={`${c.name} warning days`} />
                  <button type="button" className="link small" onClick={() => run(() => api.categories.update(c.id, { warnDays: null }), 'Saved')}>Reset</button>
                </>
              )}
              {admin && <button type="button" className="iconbtn ghost" aria-label={`Remove ${c.name}`} disabled={busy} onClick={() => run(() => api.categories.remove(c.id), `${c.name} removed`)}><Icon name="trash" size="sm" /></button>}
            </div>
          </div>
        ))}
      </div>
      <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => api.categories.create({ name: name.trim(), sortOrder: 95 }), `${name.trim()} added`).then(() => setName('')); }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New category" aria-label="New category" />
        <button className="btn" disabled={!name.trim() || busy}>Add</button>
      </form>
    </div>
  );
}

function Modules({ admin }: { admin: boolean }) {
  const modules = useModules();
  const { run } = useAction();
  return (
    <div className="section">
      <div className="label">Modules</div>
      <div className="list">
        {modules.map((m) => (
          <div className="toggle" key={m.id}>
            <span className="grow"><b>{m.name}</b><br /><span className="small muted">{m.description}{m.locked ? ' Switched off on the server (LARDER_MODULES_DISABLED).' : ''}</span></span>
            <Switch checked={m.enabled} label={m.name} onChange={(v) => { if (admin && !m.locked) void run(() => api.modules.setEnabled(m.id, v), `${m.name} ${v ? 'on' : 'off'}`); }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Tokens() {
  const { data } = useQuery({ queryKey: ['tokens'], queryFn: api.auth.tokens });
  const { run, busy } = useAction();
  const toast = useToast();
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  return (
    <div className="section">
      <div className="label">Access tokens</div>
      <p className="small muted">For Claude (MCP), Home Assistant, Node-RED and scripts. Send it as <code>Authorization: Bearer …</code>.</p>
      {secret && (
        <div className="card pad">
          <b>Copy this token now. It won't be shown again.</b>
          <div className="secret">{secret}</div>
          <div className="btnrow"><button type="button" className="btn small" onClick={() => navigator.clipboard?.writeText(secret).then(() => toast('Copied'), () => toast('Select the token and copy it'))}>Copy</button><button type="button" className="btn small" onClick={() => setSecret(null)}>Done</button></div>
        </div>
      )}
      {(data ?? []).length > 0 && (
        <div className="list">
          {data!.map((t) => (
            <div className="item" key={t.id}>
              <span className="tile"><Icon name="key" /></span>
              <span className="item-main"><span className="item-name">{t.name}</span><span className="item-meta"><code>{t.prefix}…</code> · {t.lastUsedAt ? `used ${ago(t.lastUsedAt)}` : 'never used'}</span></span>
              <button type="button" className="btn small danger" disabled={busy} onClick={() => run(() => api.auth.removeToken(t.id), `${t.name} revoked`)}>Revoke</button>
            </div>
          ))}
        </div>
      )}
      <form className="inputrow" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => api.auth.createToken(name.trim())).then((r) => { if (r) { setSecret(r.token); setName(''); } }); }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="What it's for, e.g. Claude" aria-label="Token name" />
        <button className="btn" disabled={!name.trim() || busy}>Create</button>
      </form>
    </div>
  );
}

function Accounts({ admin }: { admin: boolean }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: api.auth.users, enabled: admin });
  const { run, busy } = useAction();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  return (
    <div className="section">
      <div className="label">Accounts</div>
      {admin && (
        <>
          <div className="list">
            {(users.data ?? []).map((x) => (
              <div className="item" key={x.id}>
                <span className="tile"><Icon name="user" /></span>
                <span className="item-main"><span className="item-name">{x.displayName || x.username}</span><span className="item-meta">{x.username} · {x.role}</span></span>
                <button type="button" className="iconbtn ghost" aria-label={`Remove ${x.username}`} disabled={busy} onClick={() => run(() => api.auth.removeUser(x.id), `${x.username} removed`)}><Icon name="trash" size="sm" /></button>
              </div>
            ))}
          </div>
          <form className="card pad" onSubmit={(e) => { e.preventDefault(); void run(() => api.auth.addUser({ username: u.trim(), password: p, role }), `${u.trim()} can now sign in`).then((r) => { if (r) { setU(''); setP(''); } }); }}>
            <b>Add someone</b>
            <div className="inputrow"><input className="input" value={u} onChange={(e) => setU(e.target.value)} placeholder="Username" aria-label="Username" /><input className="input" type="password" value={p} onChange={(e) => setP(e.target.value)} placeholder="Password (8+)" aria-label="Password" /></div>
            <div className="row" style={{ justifyContent: 'space-between' }}><label className="row small"><Switch checked={role === 'admin'} onChange={(v) => setRole(v ? 'admin' : 'member')} label="Admin" />Can change household settings</label><button className="btn small" disabled={busy || !u.trim() || p.length < 8}>Add</button></div>
          </form>
        </>
      )}
      <form className="card pad" onSubmit={(e) => { e.preventDefault(); void run(() => api.auth.password({ currentPassword: cur, newPassword: next }), 'Password changed').then((r) => { if (r) { setCur(''); setNext(''); } }); }}>
        <b>Change your password</b>
        <div className="inputrow"><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="Current" aria-label="Current password" /><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New (8+)" aria-label="New password" /></div>
        <div className="btnrow"><button className="btn small" disabled={busy || !cur || next.length < 8}>Change password</button><button type="button" className="btn small" onClick={() => api.auth.logout().then(() => qc.invalidateQueries())}><Icon name="logout" size="sm" />Sign out</button></div>
      </form>
    </div>
  );
}

function Data({ admin }: { admin: boolean }) {
  const server = useQuery({ queryKey: ['server'], queryFn: api.settings.server });
  const home = useQuery({ queryKey: ['home'], queryFn: api.home });
  const { run, busy } = useAction();
  const empty = home.data && home.data.counts.products === 0 && home.data.counts.wish === 0;
  const s = server.data;
  return (
    <div className="section">
      <div className="label">Data</div>
      <div className="list">
        {admin && empty && (
          <div className="toggle"><span><b>Load the example household</b><br /><span className="small muted">About 30 items, places and shops to try Larder with.</span></span><button type="button" className="btn small primary" disabled={busy} onClick={() => run(() => api.settings.demo(), (r) => `Loaded ${r.products} example items`)}>Load</button></div>
        )}
        {admin && <div className="toggle"><span><b>Export everything</b><br /><span className="small muted">One JSON file. Works with any storage back end.</span></span><a className="btn small" href="api/v1/export" download><Icon name="download" size="sm" />Export</a></div>}
        {admin && s?.backups && <div className="toggle"><span><b>Back up now</b><br /><span className="small muted">Saved in the backups folder inside the data folder.</span></span><button type="button" className="btn small" disabled={busy} onClick={() => run(() => api.settings.backup(), (r) => `Backed up to ${r.file.split('/').pop()}`)}>Back up</button></div>}
        <div className="toggle"><span><b>API</b><br /><span className="small muted">Every action in the app is in the REST API.</span></span><a className="btn small" href="api/docs" target="_blank" rel="noreferrer">API docs</a></div>
      </div>
      {s && (
        <div className="card pad">
          <dl className="kv">
            <dt>Version</dt><dd>{s.version}</dd>
            <dt>Storage</dt><dd>{s.storage === 'sqlite' ? 'SQLite' : 'In memory (lost on restart)'}</dd>
            <dt>Login</dt><dd>{s.auth === 'local' ? 'Household accounts' : 'None (trusted network)'}</dd>
            <dt>Data folder</dt><dd className="mono">{s.dataDir}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
