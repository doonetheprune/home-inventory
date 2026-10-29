import { z } from 'zod';
import { LarderError, type CoreApi } from '@larder/core';
import type { ZodApp } from '../app';
import { admin } from './common';

const ModuleInfo = z.object({ id: z.string(), name: z.string(), description: z.string(), version: z.string(), enabled: z.boolean(), locked: z.boolean() });

export function registerModuleRoutes(app: ZodApp, { core }: { core: CoreApi }) {
  const tags = ['Modules'];
  app.get('/modules', { schema: { tags, summary: 'Feature modules and whether they are on', response: { 200: z.array(ModuleInfo) } } }, () => core.modules.list());
  app.patch('/modules/:id', {
    schema: { tags, summary: 'Switch a module on or off (admin)', params: z.object({ id: z.string() }), body: z.object({ enabled: z.boolean() }), response: { 200: ModuleInfo } },
  }, (r) => {
    admin(r);
    return core.modules.setEnabled(r.params.id, r.body.enabled);
  });

  // Each module's own routes, under /api/v1/modules/<id>/…
  for (const { moduleId, route } of core.modules.routes()) {
    const schema: Record<string, unknown> = { tags: [`Module: ${moduleId}`], summary: route.admin ? `${route.summary} (admin)` : route.summary };
    if (route.description) schema.description = route.description;
    if (route.body) schema.body = route.body;
    if (route.query) schema.querystring = route.query;
    if (route.params) schema.params = route.params;
    if (route.response) schema.response = { 200: route.response };
    app.route({
      method: route.method,
      // A module's "/" is /api/v1/modules/<id> itself, without a trailing slash.
      url: `/modules/${moduleId}${route.path === '/' ? '' : route.path}`,
      schema,
      handler: async (request) => {
        if (!core.modules.isEnabled(moduleId)) throw new LarderError(`The ${moduleId} module is switched off. Turn it on in Settings → Modules.`, 404, 'module_off');
        if (route.admin) admin(request);
        return route.handler({ body: request.body, query: request.query, params: request.params, userId: request.user?.id ?? null });
      },
    });
  }
}
