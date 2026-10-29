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
/** Sign-ins waiting for the person, in all and per client (each is a few KB of memory). */
const MAX_PENDING = 200;
const MAX_PENDING_PER_CLIENT = 20;
/** Registrations per address per hour. A household connects a handful of assistants. */
const REGISTRATIONS_PER_HOUR = 30;

interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
  /** When it last finished a sign-in. Clients that never did are the first to go when the list is full. */
  usedAt?: string;
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

/** An S256 challenge is a SHA-256 hash in base64url: always 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

const Registration = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(200).optional(),
});

const TokenRequest = z.object({
  grant_type: z.string().max(100),
  code: z.string().max(200).optional(),
  code_verifier: z.string().max(200).optional(),
  redirect_uri: z.string().max(2000).optional(),
  client_id: z.string().max(100).optional(),
});

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
  // Approved requests by the hash of their code, for the token endpoint.
  const byCode = new Map<string, string>();
  const registrations = new Map<string, number[]>();

  const base = (request: FastifyRequest) => config.baseUrl ?? `${request.protocol}://${request.host}`;
  const forget = (p: PendingRequest) => {
    pending.delete(p.id);
    if (p.codeHash) byCode.delete(p.codeHash);
  };
  const tidy = () => {
    const now = Date.now();
    for (const p of pending.values()) if (p.expiresAt < now && (!p.codeExpiresAt || p.codeExpiresAt < now)) forget(p);
  };
  /** Room for one more sign-in: drop the oldest unanswered ones (Maps keep insertion order). */
  const makeRoom = (clientId: string) => {
    const waiting = [...pending.values()].filter((p) => !p.codeHash);
    const mine = waiting.filter((p) => p.clientId === clientId);
    for (const p of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_CLIENT + 1))) forget(p);
    const left = waiting.filter((p) => pending.has(p.id));
    for (const p of left.slice(0, Math.max(0, pending.size - MAX_PENDING + 1))) forget(p);
  };
  const tooManyRegistrations = (address: string) => {
    const hourAgo = Date.now() - 3_600_000;
    const recent = (registrations.get(address) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= REGISTRATIONS_PER_HOUR) return true;
    registrations.set(address, [...recent, Date.now()]);
    if (registrations.size > 1000) registrations.delete(registrations.keys().next().value!);
    return false;
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

  app.post('/oauth/register', { schema: { hide: true }, bodyLimit: 16 * 1024 }, async (request, reply) => {
    const parsed = Registration.safeParse(request.body);
    const uris = parsed.success ? parsed.data.redirect_uris : [];
    if (!parsed.success || !uris.every(acceptableRedirect)) return fail(reply, 400, 'invalid_redirect_uri', 'Give one to ten redirect_uris, each https (or http on localhost).');
    if (tooManyRegistrations(request.ip)) return fail(reply, 429, 'invalid_client_metadata', 'Too many registrations from this address. Try again in an hour.');
    const existing = await clients.list();
    if (existing.length >= MAX_CLIENTS) {
      // Make room by forgetting clients that never finished signing in, oldest first. Ones in use stay.
      const unused = existing.filter((c) => !c.data.usedAt).sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt));
      if (unused.length < existing.length - MAX_CLIENTS + 1) return fail(reply, 400, 'invalid_client_metadata', 'Larder has as many connected assistants as it can hold.');
      for (const old of unused.slice(0, existing.length - MAX_CLIENTS + 1)) await clients.remove(old.id);
    }
    const client: OAuthClient = { clientId: newId(), name: (parsed.data.client_name || 'An AI assistant').slice(0, 60), redirectUris: uris, createdAt: new Date().toISOString() };
    await clients.put(client.clientId, client);
    return reply.code(201).send({
      client_id: client.clientId, client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000), client_name: client.name,
      redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
    });
  });

  app.get('/oauth/authorize', { schema: { hide: true } }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const text = (k: string) => (typeof q[k] === 'string' ? q[k] : undefined);
    // Errors are shown here rather than sent back to the client: anyone can register a
    // client, so redirecting before the person has seen the approval page would let
    // Larder's address be used to bounce people anywhere.
    const page = (status: number, message: string) => reply.code(status).type('text/html').send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Larder</title><p style="font:16px system-ui;margin:2em">Larder couldn't start this connection: ${escapeHtml(message)}</p>`,
    );
    const clientId = text('client_id');
    const redirectUri = text('redirect_uri');
    const client = clientId ? await clients.get(clientId) : null;
    if (!client) return page(400, 'the assistant isn\'t registered with Larder. Start connecting again from the assistant.');
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) return page(400, 'the redirect_uri doesn\'t match the registered ones.');
    if (text('response_type') !== 'code') return page(400, 'only response_type=code is supported.');
    const challenge = text('code_challenge');
    if (!challenge || !CHALLENGE.test(challenge) || text('code_challenge_method') !== 'S256') return page(400, 'PKCE with code_challenge_method=S256 is required.');
    const state = text('state');
    const scope = text('scope');
    if ((state?.length ?? 0) > 2000 || (scope?.length ?? 0) > 200) return page(400, 'the state or scope is too long.');
    tidy();
    makeRoom(client.clientId);
    const req: PendingRequest = { id: randomBytes(16).toString('base64url'), clientId: client.clientId, redirectUri, state: state ?? null, codeChallenge: challenge, scope: scope ?? 'larder', expiresAt: Date.now() + REQUEST_MINUTES * 60_000 };
    pending.set(req.id, req);
    // The web app asks the person (signing in first if needed).
    return reply.redirect(`${base(request)}/#/connect?request=${encodeURIComponent(req.id)}`);
  });

  // OAuth's token endpoint takes form posts. The parser lives only here: anywhere
  // else it would let a cross-site HTML form post to the API.
  app.register(async (scope) => {
  scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16 * 1024 }, (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
  scope.post('/oauth/token', { schema: { hide: true } }, async (request, reply) => {
    const parsed = TokenRequest.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Send code, code_verifier, redirect_uri and client_id as strings.');
    const b = parsed.data;
    if (b.grant_type !== 'authorization_code') return fail(reply, 400, 'unsupported_grant_type', 'Only authorization_code is supported.');
    if (!b.code || !b.code_verifier || !b.redirect_uri || !b.client_id) return fail(reply, 400, 'invalid_request', 'Send code, code_verifier, redirect_uri and client_id.');
    const id = byCode.get(sha256url(b.code));
    const entry = id ? pending.get(id) : undefined;
    if (!entry || !entry.userId || (entry.codeExpiresAt ?? 0) < Date.now()) return fail(reply, 400, 'invalid_grant', 'That code is unknown, used or expired. Start the connection again.');
    // Codes work once, whatever happens next.
    forget(entry);
    if (entry.clientId !== b.client_id || entry.redirectUri !== b.redirect_uri) return fail(reply, 400, 'invalid_grant', 'The code was issued to a different client or redirect_uri.');
    if (sha256url(b.code_verifier) !== entry.codeChallenge) return fail(reply, 400, 'invalid_grant', 'code_verifier doesn\'t match the code_challenge.');
    const owner = await core.adapters.storage.users.get(entry.userId);
    if (!owner) return fail(reply, 400, 'invalid_grant', 'The account that approved this no longer exists.');
    const client = await clients.get(entry.clientId);
    if (client) await clients.put(client.clientId, { ...client, usedAt: new Date().toISOString() });
    // Named with where it signed in from, since anyone can register a client called "Claude".
    const name = `${client?.name ?? 'AI assistant'} (via ${new URL(entry.redirectUri).host})`;
    const { token } = await auth.createToken({ id: owner.id, username: owner.username, displayName: owner.displayName, role: owner.role, via: 'token' }, name);
    return reply.header('Cache-Control', 'no-store').send({ access_token: token, token_type: 'Bearer', scope: entry.scope });
  });
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
        forget(p);
        u.searchParams.set('error', 'access_denied');
        return { redirect: u.toString() };
      }
      const code = randomBytes(32).toString('base64url');
      Object.assign(p, { codeHash: sha256url(code), userId: who.id, codeExpiresAt: Date.now() + CODE_MINUTES * 60_000 });
      byCode.set(p.codeHash!, p.id);
      u.searchParams.set('code', code);
      return { redirect: u.toString() };
    });
  }

  return { registerPublic, registerApi };
}
