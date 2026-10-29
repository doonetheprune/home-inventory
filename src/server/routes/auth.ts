import { z } from 'zod';
import { ApiToken, Role, type CoreApi } from '@larder/core';
import type { ZodApp } from '../app';
import type { Auth } from '../auth';
import type { Config } from '../config';
import { IdParams, Ok, admin, user } from './common';

const PublicUser = z.object({ id: z.string(), username: z.string(), displayName: z.string(), role: Role, via: z.enum(['session', 'token', 'none', 'ingress']) });
const Credentials = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) });
const TokenInfo = ApiToken.omit({ tokenHash: true });

export function registerAuthRoutes(app: ZodApp, { auth, config, core }: { auth: Auth; config: Config; core: CoreApi }) {
  const tags = ['Auth'];

  app.get('/auth/status', {
    schema: { tags, summary: 'Login mode, whether first-time setup is needed, and who you are', response: { 200: z.object({ mode: z.enum(['local', 'none', 'homeassistant']), setupNeeded: z.boolean(), user: PublicUser.nullable(), version: z.string(), instanceId: z.string() }) } },
  }, async (request) => ({ mode: auth.mode, setupNeeded: await auth.needsSetup(), user: request.user, version: config.version, instanceId: await core.instanceId() }));

  app.post('/auth/setup', {
    schema: { tags, summary: 'Create the first (admin) account', body: Credentials.extend({ displayName: z.string().max(80).optional(), password: z.string().min(8).max(200) }), response: { 200: PublicUser } },
  }, async (request, reply) => auth.setup(request, reply, request.body));

  app.post('/auth/login', { schema: { tags, summary: 'Sign in; sets the session cookie', body: Credentials, response: { 200: PublicUser } } },
    async (request, reply) => auth.login(request, reply, request.body));

  app.post('/auth/logout', { schema: { tags, summary: 'Sign out', response: { 200: Ok } } }, async (request, reply) => {
    await auth.logout(request, reply);
    return { ok: true as const };
  });

  app.post('/auth/password', {
    schema: { tags, summary: 'Change your password', body: z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(200) }), response: { 200: Ok } },
  }, async (request) => {
    await auth.changePassword(user(request).id, request.body.currentPassword, request.body.newPassword);
    return { ok: true as const };
  });

  app.get('/auth/users', { schema: { tags, summary: 'Household accounts (admin)', response: { 200: z.array(PublicUser) } } }, async (request) => {
    admin(request);
    return auth.listUsers();
  });

  app.post('/auth/users', {
    schema: { tags, summary: 'Add a household account (admin)', body: Credentials.extend({ displayName: z.string().max(80).optional(), role: Role.default('member'), password: z.string().min(8).max(200) }), response: { 200: PublicUser } },
  }, async (request) => {
    admin(request);
    const u = await auth.createUser(request.body);
    return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, via: 'session' as const };
  });

  app.delete('/auth/users/:id', { schema: { tags, summary: 'Remove a household account (admin)', params: IdParams, response: { 200: Ok } } }, async (request) => {
    await auth.removeUser(request.params.id, admin(request));
    return { ok: true as const };
  });

  app.get('/auth/tokens', { schema: { tags, summary: 'Access tokens', response: { 200: z.array(TokenInfo) } } }, async (request) => auth.listTokens(user(request)));

  app.post('/auth/tokens', {
    schema: {
      tags, summary: 'Create an access token. The token is only shown once.',
      body: z.object({ name: z.string().min(1).max(80) }), response: { 200: z.object({ token: z.string(), info: TokenInfo }) },
    },
  }, async (request) => auth.createToken(user(request), request.body.name));

  app.delete('/auth/tokens/:id', { schema: { tags, summary: 'Revoke an access token', params: IdParams, response: { 200: Ok } } }, async (request) => {
    await auth.removeToken(user(request), request.params.id);
    return { ok: true as const };
  });
}
