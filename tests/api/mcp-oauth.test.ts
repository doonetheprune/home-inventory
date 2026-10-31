/**
 * The official MCP SDK's OAuth client connecting to Larder on its own:
 * discovery, client registration, PKCE, approval and token, the way
 * connectors like Claude.ai's do it.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { makeApp } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('MCP with OAuth (SDK client)', () => {
  it('signs in through the approval page and then uses the tools', async () => {
    const made = await makeApp();
    await made.call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    await made.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(made.app.server.address() as AddressInfo).port}`;

    let authorizationUrl: URL | null = null;
    const store: Record<string, unknown> = {};
    const provider: OAuthClientProvider = {
      redirectUrl: 'http://localhost:33418/callback',
      clientMetadata: { client_name: 'SDK test client', redirect_uris: ['http://localhost:33418/callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
      clientInformation: () => store.client as Any,
      saveClientInformation: (c) => void (store.client = c),
      tokens: () => store.tokens as Any,
      saveTokens: (t) => void (store.tokens = t),
      redirectToAuthorization: (url) => void (authorizationUrl = url),
      saveCodeVerifier: (v) => void (store.verifier = v),
      codeVerifier: () => store.verifier as string,
    };

    const first = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
    await expect(new Client({ name: 't', version: '1' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authorizationUrl).not.toBeNull();

    // The "browser": follow the authorization link, approve in Larder, land on the callback.
    const start = await fetch(authorizationUrl!, { redirect: 'manual' });
    const request = decodeURIComponent(start.headers.get('location')!.split('request=')[1]!);
    const approved = await made.call<Any>('POST', `/api/v1/oauth/requests/${request}`, { approve: true });
    const code = new URL(approved.body.redirect).searchParams.get('code')!;
    await first.finishAuth(code);

    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('search');
    await client.close();
    await made.app.close();
  });
});

describe('Connections approved through Home Assistant', () => {
  const verifier = 'v'.repeat(50);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirect = 'https://claude.ai/api/mcp/auth_callback';

  /** Registers a connector and starts its sign-in; answers the request id the integration would get. */
  async function startSignIn(app: Awaited<ReturnType<typeof makeApp>>['app']) {
    const reg = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [redirect], client_name: 'Claude' } });
    const clientId = (reg.json() as Any).client_id as string;
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' });
    const start = await app.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
    return { clientId, request: decodeURIComponent(start.headers.location!.toString().split('request=')[1]!) };
  }

  it('as the add-on, only the integration may approve, and the connection acts as the Home Assistant user', async () => {
    const { app, auth } = await makeApp({ auth: 'homeassistant' });
    const integration = await auth.integrationToken(join(mkdtempSync(join(tmpdir(), 'larder-ha-')), 'integration-token'));
    const { clientId, request } = await startSignIn(app);
    const body = { approve: true, issuer: 'https://abc.ui.nabu.casa/api/larder/oauth', user: { id: 'u42', username: 'sam', displayName: 'Sam' } };

    // Someone in Home Assistant's sidebar can't vouch for another user this way.
    const ingress = { 'x-remote-user-id': 'abc123', 'x-remote-user-name': 'shaun', 'x-remote-user-display-name': 'Shaun', 'x-larder-client': 'web' };
    const denied = await app.inject({ method: 'POST', url: `/api/v1/oauth/requests/${request}/home-assistant`, remoteAddress: '172.30.32.2', headers: ingress, payload: body });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({ method: 'POST', url: `/api/v1/oauth/requests/${request}/home-assistant`, headers: { authorization: `Bearer ${integration}` }, payload: body });
    expect(ok.statusCode).toBe(200);
    const back = new URL((ok.json() as Any).redirect);
    expect(back.searchParams.get('state')).toBe('s1');
    expect(back.searchParams.get('iss')).toBe('https://abc.ui.nabu.casa/api/larder/oauth');
    const token = await app.inject({
      method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirect, client_id: clientId }).toString(),
    });
    const access = (token.json() as Any).access_token as string;
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/status', headers: { authorization: `Bearer ${access}` } });
    expect((me.json() as Any).user).toMatchObject({ id: 'ha-u42', displayName: 'Sam' });
  });

  it('elsewhere, the integration\'s admin token approves as that account; a member\'s can\'t', async () => {
    const { app, call, clearAuth } = await makeApp();
    await call('POST', '/api/v1/auth/setup', { username: 'shaun', password: 'correct horse' });
    const admin = (await call<Any>('POST', '/api/v1/auth/tokens', { name: 'Home Assistant' })).body.token as string;
    await call('POST', '/api/v1/auth/users', { username: 'kid', password: 'abcdefgh' });
    clearAuth();
    await call('POST', '/api/v1/auth/login', { username: 'kid', password: 'abcdefgh' });
    const member = (await call<Any>('POST', '/api/v1/auth/tokens', { name: 'mine' })).body.token as string;
    const { request } = await startSignIn(app);
    const body = { approve: true, issuer: 'http://homeassistant.local:8123/api/larder/oauth', user: { id: 'u1', username: 'kid', displayName: 'Kid' } };
    expect((await app.inject({ method: 'POST', url: `/api/v1/oauth/requests/${request}/home-assistant`, headers: { authorization: `Bearer ${member}` }, payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/oauth/requests/${request}/home-assistant`, headers: { authorization: `Bearer ${admin}` }, payload: { ...body, issuer: 'javascript:alert(1)' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/v1/oauth/requests/${request}/home-assistant`, headers: { authorization: `Bearer ${admin}` }, payload: body })).statusCode).toBe(200);
  });
});
