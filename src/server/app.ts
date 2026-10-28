/**
 * Builds the HTTP server: REST API under /api/v1, OpenAPI docs at /api/docs,
 * live updates at /api/v1/events, and the web app at /.
 */
import { existsSync } from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { LarderError, type CoreApi } from '@larder/core';
import { createAuth, type Auth } from './auth';
import type { Config } from './config';
import { registerAuthRoutes } from './routes/auth';
import { registerCatalogueRoutes } from './routes/catalogue';
import { registerProductRoutes } from './routes/products';
import { registerStockRoutes } from './routes/stock';
import { registerMiscRoutes } from './routes/misc';
import { registerModuleRoutes } from './routes/modules';

export type ZodApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger, ZodTypeProvider>;

export interface AppDeps {
  core: CoreApi;
  config: Config;
  /** Runs a backup now; returns the file name. Undefined when the storage can't back up. */
  backup?: () => Promise<string>;
  logger?: boolean | object;
}

/** Routes anyone can call without signing in. */
const PUBLIC = new Set(['/api/health', '/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup', '/api/openapi.json']);

export async function buildApp(deps: AppDeps): Promise<{ app: ZodApp; auth: Auth }> {
  const { core, config } = deps;
  const app = Fastify({
    logger: deps.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Larder API',
        version: config.version,
        description:
          'Home inventory: stock, places, shops, shopping lists and scanning.\n\n' +
          'Authenticate with `Authorization: Bearer <token>` (create tokens in Settings → Access tokens) or the web app session cookie. ' +
          'Errors are `{ error, message }` where `message` is written for people.',
      },
      servers: [{ url: config.baseUrl ?? '/' }],
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', description: 'An access token from Settings → Access tokens.' },
          session: { type: 'apiKey', in: 'cookie', name: 'larder_session' },
        },
      },
      security: [{ bearer: [] }, { session: [] }],
      tags: [
        { name: 'Home' }, { name: 'Search' }, { name: 'Products' }, { name: 'Stock' }, { name: 'Shopping' }, { name: 'Places' },
        { name: 'Shops' }, { name: 'Categories' }, { name: 'Scanning' }, { name: 'Settings' }, { name: 'Modules' }, { name: 'Auth' }, { name: 'System' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  const auth = createAuth(core, config);
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    request.user = await auth.identify(request);
    if (PUBLIC.has(path) || path.startsWith('/api/docs')) return;
    if (!request.user) throw new LarderError('Sign in to Larder first, or send an access token.', 401, 'unauthorised');
    // Cookie sessions must come from the web app (blocks cross-site form posts).
    if (request.user.via === 'session' && request.method !== 'GET' && request.method !== 'HEAD' && !request.headers['x-larder-client']) {
      throw new LarderError('Requests signed in with a cookie need the X-Larder-Client header.', 403, 'forbidden');
    }
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({ path: (v.instancePath || '').replace(/^\//, '').replace(/\//g, '.'), message: v.message ?? 'is not valid' }));
      return reply.code(400).send({ error: 'invalid', message: issues.map((i) => `${i.path || 'request'}: ${i.message}`).join('; '), issues });
    }
    if (err instanceof LarderError) return reply.code(err.status).send({ error: err.code, message: err.message });
    const e = err as { name?: string; message?: string; statusCode?: number; code?: string };
    if (e.name === 'ZodError') return reply.code(400).send({ error: 'invalid', message: e.message ?? 'Invalid input' });
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
    if (status === 500) request.log.error(err);
    return reply.code(status).send({ error: status === 500 ? 'server_error' : (e.code ?? 'bad_request'), message: status === 500 ? 'Something went wrong on the server. Check the Larder logs.' : (e.message ?? 'Bad request') });
  });

  app.get('/api/health', { schema: { tags: ['System'], summary: 'Is Larder running?' } }, async () => ({ ok: true, version: config.version }));

  await app.register(
    async (api) => {
      const z = api.withTypeProvider<ZodTypeProvider>() as unknown as ZodApp;
      registerAuthRoutes(z, { auth, config });
      registerCatalogueRoutes(z, { core });
      registerProductRoutes(z, { core });
      registerStockRoutes(z, { core });
      registerMiscRoutes(z, { core, config, backup: deps.backup });
      registerModuleRoutes(z, { core });
    },
    { prefix: '/api/v1' },
  );

  if (existsSync(config.webDir)) {
    await app.register(staticFiles, {
      root: config.webDir,
      prefix: '/',
      setHeaders(res, path) {
        res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send(`<p>Larder's API is running. The web app hasn't been built: run <code>npm run build:web</code>. API docs: <a href="api/docs">api/docs</a></p>`));
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: `There's no ${request.method} ${request.url.split('?')[0]} in the Larder API. See /api/docs.` });
    return reply.code(404).type('text/plain').send('Not found');
  });

  return { app: app as unknown as ZodApp, auth };
}
