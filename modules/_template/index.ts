/**
 * Template module. Copy this folder to start a new feature:
 *
 *   1. cp -r modules/_template modules/my-feature
 *   2. Change the id, name and description below (id = folder name).
 *   3. Add it to the list in modules/index.ts.
 *   4. Write SPEC.md and tests (see template.test.ts), then `npm test`.
 *   5. Optional UI: edit web.tsx (registered automatically).
 *
 * Use only `ctx` and "@larder/core". Never import from src/.
 */
import { z } from 'zod';
import { defineModule } from '@larder/core';

export default defineModule({
  id: 'template',
  name: 'Template',
  description: 'An example module that counts stock changes. Copy it to build your own.',
  version: '1.0.0',
  // Off by default so the example doesn't do anything until someone wants it.
  defaultEnabled: false,
  setup(ctx) {
    const counts = ctx.collection<{ count: number }>('counts');

    // React to core events (only while the module is switched on).
    ctx.on('stock.changed', async () => {
      const cur = (await counts.get('stock')) ?? { count: 0 };
      await counts.put('stock', { count: cur.count + 1 });
    });

    // Add an API route: GET /api/v1/modules/template/count
    ctx.addRoute({
      method: 'GET',
      path: '/count',
      summary: 'How many stock changes have happened since the module was switched on',
      response: z.object({ count: z.number() }),
      async handler() {
        return (await counts.get('stock')) ?? { count: 0 };
      },
    });
  },
});
