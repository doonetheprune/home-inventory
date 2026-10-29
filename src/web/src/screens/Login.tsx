import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type AuthStatus } from '../api';
import { Icon } from '../icons';

export function Login({ status }: { status: AuthStatus }) {
  const qc = useQueryClient();
  const setup = status.setupNeeded;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (setup) await api.auth.setup({ username, password });
      else await api.auth.login({ username, password });
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="row"><span className="mark"><Icon name="jar" /></span><h1 style={{ fontSize: 28 }}>Larder</h1></div>
        {setup ? (
          <div className="stack">
            <h2 style={{ fontSize: 20 }}>Set up your household</h2>
            <p className="muted small">Create the first account. You can add others in Settings later. This account can change household settings.</p>
          </div>
        ) : status.mode === 'homeassistant' ? (
          <p className="muted">Open Larder from the Home Assistant sidebar, or sign in with a Larder account an admin made for you.</p>
        ) : (
          <p className="muted">Sign in to see what you've got, and where.</p>
        )}
        <label className="field" htmlFor="username"><span>Username</span>
          <input id="username" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label className="field" htmlFor="password"><span>Password</span>
          <input id="password" className="input" type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setup ? 8 : 1} />
          {setup && <small>At least 8 characters.</small>}
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary block" disabled={busy}>{setup ? 'Create account' : 'Sign in'}</button>
        <p className="small muted">Larder {status.version}</p>
      </form>
    </div>
  );
}
