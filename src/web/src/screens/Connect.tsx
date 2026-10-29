/** Approving an AI assistant (Claude.ai, ChatGPT…) that asked to connect to Larder through OAuth. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Icon } from '../icons';

export function Connect() {
  const [params] = useSearchParams();
  const id = params.get('request') ?? '';
  const info = useQuery({ queryKey: ['oauth', id], queryFn: () => api.oauth.request(id), enabled: !!id, retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function answer(approve: boolean) {
    setBusy(true);
    setError('');
    try {
      const { redirect } = await api.oauth.answer(id, approve);
      window.location.assign(redirect);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="card">
        <div className="row"><span className="mark"><Icon name="jar" /></span><h1 style={{ fontSize: 28 }}>Larder</h1></div>
        {info.isLoading && <p className="muted">Checking…</p>}
        {(info.error || !id) && <p>{info.error instanceof ApiError ? info.error.message : 'This link is missing its request. Start connecting again from the assistant.'}</p>}
        {info.data && (
          <>
            <h2 style={{ fontSize: 20 }}>Connect {info.data.client}?</h2>
            <p className="muted small">It will be able to see what's in the house and change stock, the same as you can. It goes back to <b>{info.data.redirectHost}</b>.</p>
            <p className="muted small">You can disconnect it any time under Settings → Access tokens.</p>
            {error && <div className="error">{error}</div>}
            <div className="btnrow">
              <button type="button" className="btn" disabled={busy} onClick={() => void answer(false)}>Don't allow</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void answer(true)}>Allow</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
