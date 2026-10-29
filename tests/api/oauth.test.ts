import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function connected() {
  const made = await makeApp({ env: { LARDER_BASE_URL: 'https://larder.example.com' } });
  await made.call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
  return made;
}

async function register(app: Any, redirect = CALLBACK) {
  const r = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: [redirect] } });
  return r.json().client_id as string;
}

/** Starts a connection and returns the request id the web app gets. */
async function authorize(app: Any, clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const qs = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...extra });
  const r = await app.inject({ method: 'GET', url: `/oauth/authorize?${qs}` });
  return r;
}

describe('OAuth for MCP connectors', () => {
  it('tells connectors where to sign in when /mcp is called without a token', async () => {
    const { app } = await connected();
    const r = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe('Bearer resource_metadata="https://larder.example.com/.well-known/oauth-protected-resource"');
    const resource = (await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })).json();
    expect(resource).toMatchObject({ resource: 'https://larder.example.com/mcp', authorization_servers: ['https://larder.example.com'] });
    const server = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(server).toMatchObject({ issuer: 'https://larder.example.com', code_challenge_methods_supported: ['S256'], registration_endpoint: 'https://larder.example.com/oauth/register' });
  });

  it('connects after the person approves, giving an ordinary Larder token that works on /mcp', async () => {
    const { app, call } = await connected();
    const clientId = await register(app);
    const { verifier, challenge } = pkce();
    const start = await authorize(app, clientId, challenge);
    expect(start.statusCode).toBe(302);
    const location = start.headers.location as string;
    expect(location).toMatch(/^https:\/\/larder\.example\.com\/#\/connect\?request=/);
    const request = decodeURIComponent(location.split('request=')[1]!);

    // The approval page (signed in with the cookie session).
    expect((await call<Any>('GET', `/api/v1/oauth/requests/${request}`)).body).toEqual({ client: 'Claude', redirectHost: 'claude.ai' });
    const approved = (await call<Any>('POST', `/api/v1/oauth/requests/${request}`, { approve: true })).body.redirect as string;
    const back = new URL(approved);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;

    const token = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: clientId }).toString() });
    expect(token.statusCode).toBe(200);
    const accessToken = token.json().access_token as string;
    expect(accessToken).toMatch(/^lrd_/);

    const tools = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().result.tools.length).toBeGreaterThan(5);
    // It shows up under Settings → Access tokens, so it can be revoked.
    expect((await call<Any>('GET', '/api/v1/auth/tokens')).body.map((t: Any) => t.name)).toContain('Claude (connected)');

    // A code works once.
    const again = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: clientId } });
    expect(again.json().error).toBe('invalid_grant');
  });

  it('refuses a wrong PKCE verifier, unregistered redirects, and plain PKCE', async () => {
    const { app, call } = await connected();
    const clientId = await register(app);
    const { challenge } = pkce();
    const start = await authorize(app, clientId, challenge);
    const request = decodeURIComponent((start.headers.location as string).split('request=')[1]!);
    const code = new URL((await call<Any>('POST', `/api/v1/oauth/requests/${request}`, { approve: true })).body.redirect).searchParams.get('code')!;
    const wrong = await app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', code, code_verifier: 'not-the-verifier', redirect_uri: CALLBACK, client_id: clientId } });
    expect(wrong.json()).toMatchObject({ error: 'invalid_grant' });

    const elsewhere = await app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: challenge, code_challenge_method: 'S256' })}` });
    expect(elsewhere.statusCode).toBe(400);
    const plain = await authorize(app, clientId, challenge, { code_challenge_method: 'plain' });
    expect(new URL(plain.headers.location as string).searchParams.get('error')).toBe('invalid_request');
    expect((await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://evil.example/cb'] } })).statusCode).toBe(400);
  });

  it('says no on the person\'s behalf when they deny, and needs a signed-in browser to approve', async () => {
    const { app, call, useToken } = await connected();
    const clientId = await register(app);
    const { challenge } = pkce();
    const request = decodeURIComponent(((await authorize(app, clientId, challenge)).headers.location as string).split('request=')[1]!);
    const token = (await call<Any>('POST', '/api/v1/auth/tokens', { name: 'script' })).body.token;
    useToken(token);
    expect((await call('POST', `/api/v1/oauth/requests/${request}`, { approve: true })).status).toBe(403);
    const denied = await connectedDeny(app, clientId, challenge);
    expect(new URL(denied).searchParams.get('error')).toBe('access_denied');
  });
});

async function connectedDeny(app: Any, clientId: string, challenge: string) {
  // A fresh browser session for the person who says no.
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'shaun', password: 'correct horse' } });
  const cookie = (login.headers['set-cookie'] as string).split(';')[0]!;
  const request = decodeURIComponent(((await authorize(app, clientId, challenge)).headers.location as string).split('request=')[1]!);
  const r = await app.inject({ method: 'POST', url: `/api/v1/oauth/requests/${request}`, headers: { cookie, 'x-larder-client': 'web' }, payload: { approve: false } });
  return r.json().redirect as string;
}
