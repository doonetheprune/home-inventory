/**
 * Offline copies: everything the web app reads, in one answer, for a phone to
 * keep and open with no connection (docs/DECISIONS.md, "Offline copies").
 *
 * Each part is the API's own answer to a GET, asked as the caller (same
 * cookie, token or Home Assistant sign-in), so a copy holds exactly what they
 * could see in the app, and nothing here repeats what the routes work out.
 * Modules add their pages with ctx.addOfflinePaths.
 */
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { z } from 'zod';
import type { CoreApi } from '@larder/core';
import type { InjectOptions } from 'fastify';
import type { ZodApp } from '../app';
import type { Config } from '../config';

const gzipped = promisify(gzip);

/** What the web app reads, apart from one page per item, place, shop and module page. */
const CORE_PATHS = [
  '/auth/status', '/home', '/search', '/settings', '/modules', '/units', '/categories', '/shops', '/shops/presets',
  '/places', '/places/tree', '/places/to-sort',
  // The app works out the other stock filters (low, expiring…) from these.
  '/products?status=all', '/products?status=wish', '/products?status=to_tidy',
  '/shopping', '/shopping/unassigned', '/stock/deliveries', '/stock/orders',
];

/** Headers that describe the request's own body or connection, not who is asking. */
const DROP = new Set(['content-length', 'content-type', 'transfer-encoding', 'accept-encoding', 'connection', 'expect', 'upgrade']);

export const OfflineCopy = z.object({
  format: z.literal('larder-offline-copy'),
  version: z.literal(1),
  savedAt: z.string(),
  larderVersion: z.string(),
  responses: z.record(z.string(), z.unknown()).describe('The API\'s answer to each GET, by path under /api/v1, e.g. "/products/abc" or "/products?status=all". Paths that answered with an error are left out.'),
}).meta({ id: 'OfflineCopy' });

export type Inject = (options: InjectOptions) => Promise<{ statusCode: number; body: string }>;

export function registerOfflineRoutes(app: ZodApp, { core, config, inject }: { core: CoreApi; config: Config; inject: Inject }) {
  app.get('/offline/copy', {
    schema: {
      tags: ['Settings'],
      summary: 'Everything the web app shows, for a copy kept on a phone',
      description: 'The answers to the GET requests the web app makes (every item, place, shop list and module page), as the caller sees them. The app saves this on the device and answers from it when Larder can\'t be reached. Sent gzipped when the client accepts it.',
      response: { 200: OfflineCopy },
    },
  }, async (request, reply) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) if (typeof v === 'string' && !DROP.has(k)) headers[k] = v;
    // The same address too: Home Assistant sign-ins are only believed from the Supervisor's.
    const remoteAddress = request.socket.remoteAddress;
    const responses: Record<string, unknown> = {};

    async function grab(paths: string[]) {
      const queue = [...new Set(paths)].filter((p) => !(p in responses));
      const worker = async () => {
        for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
          const res = await inject({ method: 'GET', url: `/api/v1${p}`, headers, remoteAddress });
          if (res.statusCode !== 200) continue;
          try {
            responses[p] = JSON.parse(res.body) as unknown;
          } catch {
            // Not JSON (shouldn't happen for these routes): leave it out.
          }
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    }

    await grab(CORE_PATHS);
    const ids = (path: string, pick: (x: Record<string, unknown>) => unknown) =>
      Array.isArray(responses[path]) ? (responses[path] as Array<Record<string, unknown>>).map(pick).filter((id): id is string => typeof id === 'string') : [];
    const productId = (s: Record<string, unknown>) => (s.product as { id?: unknown } | undefined)?.id;
    await grab([
      ...ids('/products?status=all', productId).map((id) => `/products/${id}`),
      ...ids('/products?status=wish', productId).map((id) => `/products/${id}`),
      ...ids('/places', (p) => p.id).map((id) => `/places/${id}`),
      ...ids('/shops', (s) => s.id).map((id) => `/shopping/${id}`),
      ...(await core.modules.offlinePaths()),
    ]);

    const copy = { format: 'larder-offline-copy' as const, version: 1 as const, savedAt: new Date().toISOString(), larderVersion: config.version, responses };
    reply.header('Cache-Control', 'no-store');
    // Usually a few hundred KB to a few MB of JSON, and phones may fetch it over mobile data.
    if (/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) {
      // Bytes go out as they are (Fastify doesn't serialise a Buffer); the schema still documents what they hold.
      const body = (await gzipped(JSON.stringify(copy))) as unknown as typeof copy;
      return reply.header('Content-Encoding', 'gzip').header('Vary', 'Accept-Encoding').type('application/json').send(body);
    }
    return copy;
  });
}
