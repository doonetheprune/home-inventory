/**
 * Household login (cookie sessions) and access tokens (for MCP, Home
 * Assistant and scripts). With LARDER_AUTH=none everyone is treated as the
 * household admin.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LarderError, newId, type CoreApi, type User } from '@larder/core';
import type { Config } from './config';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;

export const SESSION_COOKIE = 'larder_session';
const SESSION_DAYS = 90;
const TOKEN_PREFIX = 'lrd_';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  via: 'session' | 'token' | 'none';
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const key = await scrypt(password, salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, N, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(password, Buffer.from(salt, 'base64'), 32, { N: Number(N), r: Number(r), p: Number(p) });
  const expected = Buffer.from(hash, 'base64');
  return expected.length === key.length && timingSafeEqual(expected, key);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const publicUser = (u: User, via: AuthUser['via']): AuthUser => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, via });

const NO_AUTH_USER: AuthUser = { id: 'household', username: 'household', displayName: 'Household', role: 'admin', via: 'none' };

export function createAuth(core: CoreApi, config: Config) {
  const storage = core.adapters.storage;
  const attempts = new Map<string, { count: number; until: number }>();

  async function startSession(reply: FastifyReply, request: FastifyRequest, user: User) {
    const secret = randomBytes(32).toString('base64url');
    const now = new Date();
    await storage.sessions.put({ id: sha256(secret), userId: user.id, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString() });
    reply.setCookie(SESSION_COOKIE, secret, {
      path: '/', httpOnly: true, sameSite: 'lax', secure: request.protocol === 'https', maxAge: SESSION_DAYS * 86_400,
    });
  }

  function throttle(key: string) {
    const a = attempts.get(key);
    if (a && a.until > Date.now() && a.count >= 10) throw new LarderError('Too many sign-in attempts. Wait five minutes and try again.', 429, 'too_many');
  }
  function failed(key: string) {
    const a = attempts.get(key);
    const until = Date.now() + 5 * 60_000;
    attempts.set(key, a && a.until > Date.now() ? { count: a.count + 1, until } : { count: 1, until });
  }

  return {
    mode: config.auth,

    /** Works out who is calling. Never throws for missing credentials. */
    async identify(request: FastifyRequest): Promise<AuthUser | null> {
      if (config.auth === 'none') return NO_AUTH_USER;
      const header = request.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        const raw = header.slice(7).trim();
        const token = await storage.tokens.findByHash(sha256(raw));
        if (!token) return null;
        const user = await storage.users.get(token.userId);
        if (!user) return null;
        const now = new Date().toISOString();
        if (!token.lastUsedAt || Date.parse(now) - Date.parse(token.lastUsedAt) > 60_000) await storage.tokens.put({ ...token, lastUsedAt: now });
        return publicUser(user, 'token');
      }
      const secret = request.cookies[SESSION_COOKIE];
      if (!secret) return null;
      const session = await storage.sessions.get(sha256(secret));
      if (!session || session.expiresAt <= new Date().toISOString()) return null;
      const user = await storage.users.get(session.userId);
      return user ? publicUser(user, 'session') : null;
    },

    async needsSetup(): Promise<boolean> {
      return config.auth === 'local' && (await storage.users.list()).length === 0;
    },

    async setup(request: FastifyRequest, reply: FastifyReply, input: { username: string; password: string; displayName?: string }) {
      if (!(await this.needsSetup())) throw new LarderError('Larder is already set up. Sign in instead.', 409, 'already_set_up');
      const user = await this.createUser({ ...input, role: 'admin' });
      await startSession(reply, request, user);
      return publicUser(user, 'session');
    },

    async login(request: FastifyRequest, reply: FastifyReply, input: { username: string; password: string }) {
      const key = `${request.ip}:${input.username.toLowerCase()}`;
      throttle(key);
      const user = await storage.users.findByUsername(input.username);
      if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
        failed(key);
        throw new LarderError("That username and password don't match. Check them and try again.", 401, 'bad_login');
      }
      attempts.delete(key);
      await startSession(reply, request, user);
      await storage.sessions.removeExpired(new Date().toISOString());
      return publicUser(user, 'session');
    },

    async logout(request: FastifyRequest, reply: FastifyReply) {
      const secret = request.cookies[SESSION_COOKIE];
      if (secret) await storage.sessions.remove(sha256(secret));
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    },

    async createUser(input: { username: string; password: string; displayName?: string; role?: 'admin' | 'member' }): Promise<User> {
      const username = input.username.trim();
      if (!/^[A-Za-z0-9._-]{2,60}$/.test(username)) throw new LarderError('Usernames need 2 to 60 letters, numbers, dots, dashes or underscores.', 400, 'invalid');
      if (input.password.length < 8) throw new LarderError('Passwords need at least 8 characters.', 400, 'invalid');
      if (await storage.users.findByUsername(username)) throw new LarderError(`There's already someone called ${username}.`, 409, 'conflict');
      const user: User = { id: newId(), username, displayName: input.displayName?.trim() || username, passwordHash: await hashPassword(input.password), role: input.role ?? 'member', createdAt: new Date().toISOString() };
      await storage.users.put(user);
      return user;
    },

    async changePassword(userId: string, current: string, next: string) {
      const user = await storage.users.get(userId);
      if (!user) throw new LarderError('Only household accounts have passwords.', 400, 'invalid');
      if (!(await verifyPassword(current, user.passwordHash))) throw new LarderError("Your current password isn't right.", 401, 'bad_login');
      if (next.length < 8) throw new LarderError('Passwords need at least 8 characters.', 400, 'invalid');
      await storage.users.put({ ...user, passwordHash: await hashPassword(next) });
    },

    async listUsers() {
      return (await storage.users.list()).map((u) => publicUser(u, 'session'));
    },

    async removeUser(id: string, by: AuthUser) {
      if (id === by.id) throw new LarderError("You can't remove your own account.", 400, 'invalid');
      const users = await storage.users.list();
      const target = users.find((u) => u.id === id);
      if (!target) throw new LarderError('That account no longer exists.', 404, 'not_found');
      if (target.role === 'admin' && users.filter((u) => u.role === 'admin').length === 1) throw new LarderError('Keep at least one admin account.', 400, 'invalid');
      await storage.users.remove(id);
      for (const t of await storage.tokens.list()) if (t.userId === id) await storage.tokens.remove(t.id);
    },

    async createToken(user: AuthUser, name: string) {
      if (config.auth === 'none') throw new LarderError('Access tokens need LARDER_AUTH=local. With no login, nothing needs a token.', 400, 'invalid');
      const raw = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
      const token = { id: newId(), name: name.trim(), tokenHash: sha256(raw), prefix: raw.slice(0, 8), userId: user.id, createdAt: new Date().toISOString(), lastUsedAt: null };
      await storage.tokens.put(token);
      const { tokenHash: _hash, ...info } = token;
      return { token: raw, info };
    },

    async listTokens(user: AuthUser) {
      return (await storage.tokens.list()).filter((t) => user.role === 'admin' || t.userId === user.id).map(({ tokenHash: _hash, ...t }) => t);
    },

    async removeToken(user: AuthUser, id: string) {
      const t = await storage.tokens.get(id);
      if (!t || (user.role !== 'admin' && t.userId !== user.id)) throw new LarderError('That token no longer exists.', 404, 'not_found');
      await storage.tokens.remove(id);
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
