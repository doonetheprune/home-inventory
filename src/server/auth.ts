/**
 * Household login (cookie sessions) and access tokens (for MCP, Home
 * Assistant and scripts). With LARDER_AUTH=none everyone is treated as the
 * household admin.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
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
  via: 'session' | 'token' | 'none' | 'ingress';
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

/**
 * Owns the token the add-on hands to the Home Assistant integration. Its
 * username has a space, which neither local accounts nor Home Assistant ids
 * can, so it never collides with a real person.
 */
const INTEGRATION_USER = { id: 'ha-integration', username: 'home assistant integration', displayName: 'Home Assistant' } as const;

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

  /**
   * Sign-in throttling, in memory. Each username gets its own limit whatever
   * address the attempts come from, so changing X-Forwarded-For doesn't
   * reset it; each address plus username gets a tighter one.
   */
  const LIMITS = { address: { max: 10, ms: 5 * 60_000 }, account: { max: 30, ms: 15 * 60_000 } };
  const keys = (request: FastifyRequest, username: string) => {
    const name = username.trim().toLowerCase();
    return [{ key: `address:${request.ip}:${name}`, ...LIMITS.address }, { key: `account:${name}`, ...LIMITS.account }];
  };
  function throttle(request: FastifyRequest, username: string) {
    const now = Date.now();
    for (const k of keys(request, username)) {
      const a = attempts.get(k.key);
      if (a && a.until > now && a.count >= k.max) {
        const minutes = Math.ceil((a.until - now) / 60_000);
        throw new LarderError(`Too many sign-in attempts. Wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`, 429, 'too_many');
      }
    }
  }
  function failed(request: FastifyRequest, username: string) {
    const now = Date.now();
    if (attempts.size > 1000) for (const [k, a] of attempts) if (a.until <= now) attempts.delete(k);
    for (const k of keys(request, username)) {
      const a = attempts.get(k.key);
      attempts.set(k.key, a && a.until > now ? { count: a.count + 1, until: now + k.ms } : { count: 1, until: now + k.ms });
    }
  }

  /**
   * Home Assistant ingress: the Supervisor has already signed the person in
   * and passes who they are in X-Remote-User-* headers. Only believed when the
   * connection itself comes from the Supervisor, so nobody can send these
   * headers to the add-on's own port and be let in. The Home Assistant user id
   * is required: without it there's no telling people apart.
   */
  async function ingressUser(request: FastifyRequest): Promise<AuthUser | null> {
    const from = request.socket.remoteAddress?.replace(/^::ffff:/, '');
    if (!from || !config.ingressAddresses.includes(from)) return null;
    const header = (name: string) => {
      const v = request.headers[name];
      return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
    };
    const haId = header('x-remote-user-id');
    if (!haId.replace(/[^A-Za-z0-9_-]/g, '')) return null;
    return haAccount(haId, header('x-remote-user-name'), header('x-remote-user-display-name'), 'ingress');
  }

  /** The Larder account for a Home Assistant user, made or brought up to date. */
  async function haAccount(haUserId: string, username: string, displayName: string, via: AuthUser['via']): Promise<AuthUser> {
    const haId = haUserId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const name = username.slice(0, 50) || 'homeassistant';
    const shown = displayName.slice(0, 80) || name;
    const role = config.haAdmins.length && !config.haAdmins.includes(name.toLowerCase()) ? 'member' : 'admin';
    const id = `ha-${haId}`;
    // Keep a record (keyed by the Home Assistant id, never the name) so tokens they make and history point at a real account.
    const existing = await storage.users.get(id);
    if (!existing || existing.displayName !== shown || existing.role !== role) {
      await storage.users.put({ id, username: `ha:${haId}`, displayName: shown, passwordHash: '', role, createdAt: existing?.createdAt ?? new Date().toISOString() });
    }
    return { id, username: name, displayName: shown, role, via };
  }

  return {
    mode: config.auth,
    haAccount,
    /** The add-on's own Home Assistant integration (its token is made by Larder, not a person). */
    isIntegration: (u: AuthUser) => u.id === INTEGRATION_USER.id,

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
      if (config.auth === 'homeassistant') {
        const ingress = await ingressUser(request);
        if (ingress) return ingress;
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
      throttle(request, input.username);
      const user = await storage.users.findByUsername(input.username);
      if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
        failed(request, input.username);
        throw new LarderError("That username and password don't match. Check them and try again.", 401, 'bad_login');
      }
      for (const k of keys(request, input.username)) attempts.delete(k.key);
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

    /**
     * The token the add-on gives the Home Assistant integration. Kept in a file
     * in the data folder so the same token survives restarts; made again if it
     * was revoked.
     */
    async integrationToken(file: string): Promise<string> {
      const saved = (await readFile(file, 'utf8').catch(() => '')).trim();
      if (saved && (await storage.tokens.findByHash(sha256(saved)))) return saved;
      if (!(await storage.users.get(INTEGRATION_USER.id))) {
        await storage.users.put({ ...INTEGRATION_USER, passwordHash: '', role: 'admin', createdAt: new Date().toISOString() });
      }
      const { token } = await this.createToken({ ...INTEGRATION_USER, role: 'admin', via: 'token' }, 'Home Assistant integration');
      await writeFile(file, `${token}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
      return token;
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
