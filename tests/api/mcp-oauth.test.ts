/**
 * The official MCP SDK's OAuth client connecting to Larder on its own:
 * discovery, client registration, PKCE, approval and token, the way
 * connectors like Claude.ai's do it.
 */
import type { AddressInfo } from 'node:net';
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
