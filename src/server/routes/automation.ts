import { z } from 'zod';
import { NfcScan, type CoreApi } from '@larder/core';
import type { ZodApp } from '../app';
import { user } from './common';

const SensorInfo = z.object({ id: z.string(), name: z.string(), description: z.string(), icon: z.string().nullable(), unit: z.string().nullable(), module: z.string().nullable() }).meta({ id: 'SensorInfo' });
const ActionInfo = z.object({
  id: z.string(), name: z.string(), description: z.string(), module: z.string().nullable(),
  schema: z.record(z.string(), z.unknown()).describe('The action\'s input as JSON Schema'),
}).meta({ id: 'ActionInfo' });
const SensorReading = z.object({ state: z.union([z.number(), z.string(), z.boolean(), z.null()]), attributes: z.record(z.string(), z.unknown()).optional() }).meta({ id: 'SensorReading' });
const ActionResult = z.object({ message: z.string() }).catchall(z.unknown()).meta({ id: 'ActionResult' });
const NfcScanView = NfcScan.extend({ path: z.string().nullable() });

export function registerAutomationRoutes(app: ZodApp, { core }: { core: CoreApi }) {
  const tags = ['Automation'];

  app.get('/automation', {
    schema: {
      tags, summary: 'Sensors and actions for Home Assistant, Node-RED and MQTT',
      description: 'The Home Assistant integration builds its entities and actions from this list. Modules add their own, so this changes when modules are switched on or off.',
      response: { 200: z.object({ sensors: z.array(SensorInfo), actions: z.array(ActionInfo) }) },
    },
  }, async () => ({ sensors: core.automation.sensors(), actions: core.automation.actions() }));

  app.get('/automation/state', {
    schema: { tags, summary: 'Every sensor\'s current reading', response: { 200: z.object({ sensors: z.record(z.string(), SensorReading) }) } },
  }, async () => ({ sensors: await core.automation.read() }));

  app.post('/automation/actions/:id', {
    schema: {
      tags, summary: 'Run an action',
      description: 'Items, places and shops are given by name, code or id ("loo roll", "G2-4", "Aldi"). A name that matches more than one thing returns 409 with `candidates`. See GET /automation for each action\'s fields.',
      params: z.object({ id: z.string().min(1).max(80) }), body: z.record(z.string(), z.unknown()).optional(), response: { 200: ActionResult },
    },
  }, async (request) => core.automation.run(request.params.id, request.body ?? {}, { userId: user(request).id }));

  app.post('/automation/check-expiry', {
    schema: { tags, summary: 'Publish stock.expiring / stock.expired events for anything newly due (the server also does this hourly)', response: { 200: z.object({ expiring: z.number(), expired: z.number() }) } },
  }, async () => core.automation.checkExpiry());

  const nfcTags = ['NFC'];
  app.post('/nfc/scanned', {
    schema: {
      tags: nfcTags, summary: 'A tag was scanned (Home Assistant app, Android Chrome, a reader)',
      description: 'Returns what the tag belongs to and publishes `nfc.scanned`. Unknown tags are offered for linking for 15 minutes.',
      body: z.object({ tagId: z.string().min(1).max(200), device: z.string().max(120).nullable().optional() }), response: { 200: NfcScanView },
    },
  }, async (request) => core.nfc.scanned(request.body));

  app.get('/nfc/recent', {
    schema: { tags: nfcTags, summary: 'Tags scanned in the last 15 minutes, newest first', response: { 200: z.array(NfcScan) } },
  }, async () => core.nfc.recent());

  app.post('/nfc/link', {
    schema: {
      tags: nfcTags, summary: 'Link a tag to a product or a place',
      body: z.object({ tagId: z.string().min(1).max(200), productId: z.string().optional(), placeId: z.string().optional() }),
      response: { 200: z.object({ kind: z.enum(['product', 'place']) }) },
    },
  }, async (request) => ({ kind: (await core.nfc.link(request.body)).kind }));

  app.delete('/nfc/tags/:tagId', {
    schema: { tags: nfcTags, summary: 'Unlink a tag from whatever it belongs to', params: z.object({ tagId: z.string().min(1).max(200) }), response: { 200: z.object({ unlinked: z.boolean() }) } },
  }, async (request) => core.nfc.unlink(request.params.tagId));
}
