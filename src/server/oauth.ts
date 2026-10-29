/**
 * OAuth sign-in for MCP connectors (Claude.ai, ChatGPT and other clients
 * that don't take a pasted token), following the MCP authorization spec:
 * protected resource metadata, authorization server metadata, dynamic client
 * registration, and the authorization code flow with PKCE (S256).
 *
 * The person approves the connection in Larder's web app while signed in.
 * The client then gets an ordinary Larder access token, named after the
 * client, which shows up (and can be revoked) under Settings → Access tokens.
 *
 * Only useful when the connector can reach Larder itself over https, such as
 * through Cloudflare Tunnel or Tailscale Funnel; set LARDER_BASE_URL to that
 * address.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LarderError, newId, type CoreApi } from '@larder/core';
import type { ZodApp } from './app';
import type { Auth } from './auth';
import type { Config } from './config';
import { MCP_PATH } from './mcp';
import { user } from './routes/common';

const REQUEST_MINUTES = 10;
const CODE_MINUTES = 5;
const MAX_CLIENTS = 200;

interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

interface PendingRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
  /** Set once approved. */
  codeHash?: string;
  userId?: string;
  codeExpiresAt?: number;
}

const sha256url = (s: string) => createHash('sha256').update(s).digest('base64url');

/** https anywhere, or http only for this machine (desktop apps listen on localhost). */
function acceptableRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

/** Where connectors find Larder's OAuth details (sent with 401s from /mcp). */
export const resourceMetadataUrl = (config: Config, request: FastifyRequest) => `${config.baseUrl ?? `${request.protocol}://${request.host}`}/.well-known/oauth-protected-resource`;

export function createOAuth(deps: { core: CoreApi; config: Config; auth: Auth }) {
  const { core, config, auth } = deps;
  const clients = core.adapters.storage.documents<OAuthClient>('oauth:clients');
  // Requests and codes live a few minutes, so memory is enough (a restart just means trying again).
  const pending = new Map<string, PendingRequest>();

  const base = (request: FastifyRequest) => config.baseUrl ?? `${request.protocol}://${request.host}`;
  const tidy = () => {
    const now = Date.now();
    for (const [id, p] of pending) if (p.expiresAt < now && (!p.codeExpiresAt || p.codeExpiresAt < now)) pending.delete(id);
  };
  const oauthError = (status: number, error: string, description: string) => Object.assign(new LarderError(description, status, error), { oauth: true });

  // OAuth errors use OAuth's own shape: { error, error_description }.
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, status: number, error: string, description: string) => reply.code(status).send({ error, error_description: description });

  /** The public OAuth endpoints, outside /api. */
  function registerPublic(app: FastifyInstance) {
  app.get('/.well-known/oauth-protected-resource', { schema: { hide: true } }, async (request) => ({
    resource: `${base(request)}${MCP_PATH}`,
    authorization_servers: [base(request)],
    bearer_methods_supported: ['header'],
    scopes_supported: ['larder'],
    resource_name: 'Larder',
  }));
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, { schema: { hide: true } }, async (request, reply) => reply.redirect('/.well-known/oauth-protected-resource'));

  app.get('/.well-known/oauth-authorization-server', { schema: { hide: true } }, async (request) => {
    const b = base(request);
    return {
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['larder'],
    };
  });

  app.post('/oauth/register', { schema: { hide: true } }, async (request, reply) => {
    const body = (request.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || uris.length > 10 || !uris.every(acceptableRedirect)) return fail(reply, 400, 'invalid_redirect_uri', 'Give one to ten redirect_uris, each https (or http on localhost).');
    const existing = await clients.list();
    if (existing.length >= MAX_CLIENTS) {
      // Forget the oldest registrations; tokens already issued keep working.
      for (const old of existing.sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt)).slice(0, existing.length - MAX_CLIENTS + 1)) await clients.remove(old.id);
    }
    const client: OAuthClient = { clientId: newId(), name: (typeof body.client_name === 'string' ? body.client_name : 'An AI assistant').slice(0, 60), redirectUris: uris, createdAt: new Date().toISOString() };
    await clients.put(client.clientId, client);
    return reply.code(201).send({
      client_id: client.clientId, client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000), client_name: client.name,
      redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
    });
  });

  app.get('/oauth/authorize', { schema: { hide: true } }, async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const client = q.client_id ? await clients.get(q.client_id) : null;
    // Without a known client and an exact registered redirect, there's nowhere safe to send errors.
    if (!client) return fail(reply, 400, 'invalid_client', 'Unknown client_id. Register the client first.');
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) return fail(reply, 400, 'invalid_request', 'redirect_uri doesn\'t match the registered ones.');
    const back = (params: Record<string, string>) => {
      const u = new URL(q.redirect_uri!);
      for (const [k, v] of Object.entries({ ...params, ...(q.state ? { state: q.state } : {}), iss: base(request) })) u.searchParams.set(k, v);
      return reply.redirect(u.toString());
    };
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported.' });
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required.' });
    tidy();
    const req: PendingRequest = { id: randomBytes(16).toString('base64url'), clientId: client.clientId, redirectUri: q.redirect_uri, state: q.state ?? null, codeChallenge: q.code_challenge, scope: q.scope ?? 'larder', expiresAt: Date.now() + REQUEST_MINUTES * 60_000 };
    pending.set(req.id, req);
    // The web app asks the person (signing in first if needed).
    return reply.redirect(`${base(request)}/#/connect?request=${encodeURIComponent(req.id)}`);
  });

  app.post('/oauth/token', { schema: { hide: true } }, async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, string | undefined>;
    if (b.grant_type !== 'authorization_code') return fail(reply, 400, 'unsupported_grant_type', 'Only authorization_code is supported.');
    if (!b.code || !b.code_verifier || !b.redirect_uri || !b.client_id) return fail(reply, 400, 'invalid_request', 'Send code, code_verifier, redirect_uri and client_id.');
    const hash = sha256url(b.code);
    const entry = [...pending.values()].find((p) => p.codeHash === hash);
    if (!entry || !entry.userId || (entry.codeExpiresAt ?? 0) < Date.now()) return fail(reply, 400, 'invalid_grant', 'That code is unknown, used or expired. Start the connection again.');
    // Codes work once, whatever happens next.
    pending.delete(entry.id);
    if (entry.clientId !== b.client_id || entry.redirectUri !== b.redirect_uri) return fail(reply, 400, 'invalid_grant', 'The code was issued to a different client or redirect_uri.');
    if (sha256url(b.code_verifier) !== entry.codeChallenge) return fail(reply, 400, 'invalid_grant', 'code_verifier doesn\'t match the code_challenge.');
    const owner = await core.adapters.storage.users.get(entry.userId);
    if (!owner) return fail(reply, 400, 'invalid_grant', 'The account that approved this no longer exists.');
    const client = await clients.get(entry.clientId);
    const { token } = await auth.createToken({ id: owner.id, username: owner.username, displayName: owner.displayName, role: owner.role, via: 'token' }, `${client?.name ?? 'AI assistant'} (connected)`);
    return reply.header('Cache-Control', 'no-store').send({ access_token: token, token_type: 'Bearer', scope: entry.scope });
  });

  }

  /** The web app's side, under /api/v1: what's asking, and the person's answer. */
  function registerApi(api: ZodApp) {
    const tags = ['Auth'];
    const Request = z.object({ request: z.string() });
    const live = (id: string) => {
      const p = pending.get(id);
      if (!p || p.expiresAt < Date.now() || p.codeHash) throw oauthError(404, 'not_found', 'This request has expired. Start connecting again from the assistant.');
      return p;
    };
    api.get('/oauth/requests/:request', {
      schema: { tags, summary: 'What is asking to connect (for the approval page)', params: Request, response: { 200: z.object({ client: z.string(), redirectHost: z.string() }) } },
    }, async (request) => {
      user(request);
      const p = live(request.params.request);
      const client = await clients.get(p.clientId);
      return { client: client?.name ?? 'An AI assistant', redirectHost: new URL(p.redirectUri).host };
    });
    api.post('/oauth/requests/:request', {
      schema: { tags, summary: 'Approve or deny a connection', params: Request, body: z.object({ approve: z.boolean() }), response: { 200: z.object({ redirect: z.string() }) } },
    }, async (request) => {
      const who = user(request);
      const p = live(request.params.request);
      if (who.via !== 'session' && who.via !== 'ingress') throw new LarderError('Approve connections while signed in to Larder in the browser.', 403, 'forbidden');
      const u = new URL(p.redirectUri);
      if (p.state) u.searchParams.set('state', p.state);
      u.searchParams.set('iss', config.baseUrl ?? `${request.protocol}://${request.host}`);
      if (!request.body.approve) {
        pending.delete(p.id);
        u.searchParams.set('error', 'access_denied');
        return { redirect: u.toString() };
      }
      const code = randomBytes(32).toString('base64url');
      Object.assign(p, { codeHash: sha256url(code), userId: who.id, codeExpiresAt: Date.now() + CODE_MINUTES * 60_000 });
      u.searchParams.set('code', code);
      return { redirect: u.toString() };
    });
  }

  return { registerPublic, registerApi };
}
