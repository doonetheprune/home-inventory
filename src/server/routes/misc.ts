import { z } from 'zod';
import {
  Dashboard, HouseholdSettings, IdentifyResult, Movement, ProductSummary, Remember, SearchSectionResult, ValidationError, Variant, type CoreApi,
} from '@larder/core';
import type { ZodApp } from '../app';
import type { Config } from '../config';
import { seedDemo } from '../demo';
import { IdParams, admin } from './common';

export function registerMiscRoutes(app: ZodApp, { core, config, backup }: { core: CoreApi; config: Config; backup?: () => Promise<string> }) {
  app.get('/home', { schema: { tags: ['Home'], summary: 'What needs attention: use soon, running low, out of place, deliveries, which shop', response: { 200: Dashboard } } }, () => core.home.dashboard());

  app.get('/search', {
    schema: {
      tags: ['Search'], summary: 'Search everything, results in sections',
      description: 'Typo-tolerant search across names, aliases, notes, categories, places, codes and barcodes. Sections: stock, shopping, places, wish, shops, plus any added by modules. An empty query returns recently changed items.',
      querystring: z.object({ q: z.string().max(200).default('') }), response: { 200: z.object({ sections: z.array(SearchSectionResult) }) },
    },
  }, async (r) => ({ sections: await core.search.query(r.query.q) }));

  app.get('/identify', {
    schema: {
      tags: ['Scanning'], summary: 'What is this code? (barcode, QR label, place code, NFC tag, shop code)',
      description: 'Checks local products, places and tags first, then asks the enabled lookup providers (Open Food Facts…) for unknown barcodes.',
      querystring: z.object({ code: z.string().min(1).max(500) }), response: { 200: IdentifyResult },
    },
  }, (r) => core.lookup.identify(r.query.code));

  app.post('/identify/remember', {
    schema: { tags: ['Scanning'], summary: 'Remember an unknown barcode as a new or existing product', body: Remember, response: { 200: z.object({ product: ProductSummary, variant: Variant }) } },
  }, (r) => core.lookup.remember(r.body));

  app.get('/identify/providers', {
    schema: { tags: ['Scanning'], summary: 'Barcode lookup providers', response: { 200: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })) } },
  }, () => core.lookup.providers());

  app.get('/history', {
    schema: { tags: ['Stock'], summary: 'Recent stock changes, newest first', querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }), response: { 200: z.array(Movement) } },
  }, (r) => core.history.recent(r.query.limit));

  /* Settings */
  app.get('/settings', { schema: { tags: ['Settings'], summary: 'Household settings', response: { 200: HouseholdSettings } } }, () => core.settings.get());
  app.patch('/settings', {
    schema: { tags: ['Settings'], summary: 'Change household settings (admin)', body: HouseholdSettings.partial(), response: { 200: HouseholdSettings } },
  }, (r) => {
    admin(r);
    return core.settings.update(r.body);
  });

  app.get('/settings/server', {
    schema: {
      tags: ['Settings'], summary: 'How this server is set up',
      response: { 200: z.object({ version: z.string(), auth: z.string(), storage: z.string(), baseUrl: z.string().nullable(), dataDir: z.string(), backups: z.boolean(), demo: z.boolean() }) },
    },
  }, () => ({ version: config.version, auth: config.auth, storage: config.storage, baseUrl: config.baseUrl, dataDir: config.dataDir, backups: !!backup, demo: config.demo }));

  app.post('/settings/backup', { schema: { tags: ['Settings'], summary: 'Back up the database now (admin)', response: { 200: z.object({ file: z.string() }) } } }, async (r) => {
    admin(r);
    if (!backup) throw new ValidationError("This storage can't make backups. Back up the data folder instead.");
    return { file: await backup() };
  });

  app.post('/settings/demo', {
    schema: { tags: ['Settings'], summary: 'Load example data into an empty Larder (admin)', response: { 200: z.object({ products: z.number() }) } },
  }, async (r) => {
    admin(r);
    if ((await core.products.list({ status: 'all' })).length || (await core.products.list({ status: 'wish' })).length) {
      throw new ValidationError('Example data can only be loaded into an empty Larder.');
    }
    return { products: await seedDemo(core) };
  });

  app.get('/export', {
    schema: { tags: ['Settings'], summary: 'Everything as JSON (portable between storage adapters)', description: 'Accounts and access tokens are not included.' },
  }, async (r, reply) => {
    admin(r);
    const s = core.adapters.storage;
    const products = await s.products.list();
    const data = {
      format: 'larder-export', version: 1, exportedAt: new Date().toISOString(),
      settings: { household: await s.settings.get('household'), modules: await s.settings.get('modules') },
      categories: await s.categories.list(), shops: await s.shops.list(), places: await s.places.list(), products,
      variants: (await Promise.all(products.map((p) => s.variants.listByProduct(p.id)))).flat(),
      stock: await s.stock.list(), movements: await s.movements.listRecent(100_000),
    };
    return reply.header('Content-Disposition', `attachment; filename="larder-export-${data.exportedAt.slice(0, 10)}.json"`).send(data);
  });

  /* Files */
  app.post('/files', {
    schema: { tags: ['Products'], summary: 'Upload a photo (multipart, field "file", images up to 10 MB)', consumes: ['multipart/form-data'], response: { 200: z.object({ id: z.string() }) } },
  }, async (request) => {
    const file = await request.file();
    if (!file) throw new ValidationError('Attach an image in a field called "file".');
    if (!file.mimetype.startsWith('image/')) throw new ValidationError('Only images can be uploaded.');
    const data = await file.toBuffer();
    return core.adapters.files.put({ data: new Uint8Array(data), contentType: file.mimetype, name: file.filename });
  });

  app.get('/files/:id', { schema: { tags: ['Products'], summary: 'Download a photo', params: IdParams } }, async (request, reply) => {
    const file = await core.adapters.files.get(request.params.id);
    if (!file) return reply.code(404).send({ error: 'not_found', message: 'That photo no longer exists.' });
    return reply.type(file.contentType).header('Cache-Control', 'private, max-age=31536000, immutable').send(Buffer.from(file.data));
  });

  /* Live updates */
  app.get('/events', {
    schema: { tags: ['System'], summary: 'Live change events (Server-Sent Events)', description: 'Each event has `event: <type>` and `data: { type, at, data }`. Types include stock.changed, stock.low, stock.restocked, product.*, place.changed, shop.changed and shopping.purchased.' },
  }, (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const unsubscribe = core.events.subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
