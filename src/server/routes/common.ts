import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { Id, LarderError } from '@larder/core';
import type { AuthUser } from '../auth';

export const IdParams = z.object({ id: Id });
export const Ok = z.object({ ok: z.literal(true) });
export const ErrorBody = z.object({ error: z.string(), message: z.string() });

export function user(request: FastifyRequest): AuthUser {
  if (!request.user) throw new LarderError('Sign in to Larder first, or send an access token.', 401, 'unauthorised');
  return request.user;
}

export function admin(request: FastifyRequest): AuthUser {
  const u = user(request);
  if (u.role !== 'admin') throw new LarderError('Only a household admin can do that.', 403, 'forbidden');
  return u;
}
