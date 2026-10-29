/**
 * Starts Larder: picks adapters from the config, builds the core with all
 * modules, and serves the API and web app.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCore, type Storage } from '@larder/core';
import { createSqliteStorage } from '../adapters/storage-sqlite';
import { createMemoryStorage } from '../adapters/storage-memory';
import { createLocalFileStore } from '../adapters/files-local';
import { createMemorySearchIndex } from '../adapters/search-memory';
import { createMemoryEventBus } from '../adapters/events-memory';
import { createHomeAssistant } from '../adapters/homeassistant';
import { modules } from '../../modules';
import { addonSettings, announceToHomeAssistant, isAddon, notifyIntegrationInstalled } from './addon';
import { buildApp } from './app';
import { loadConfig } from './config';
import { seedDemo } from './demo';
import { VERSION } from './version';

async function main() {
  // As a Home Assistant add-on, the options set in Home Assistant become settings,
  // and the Mosquitto add-on (if there is one) becomes the MQTT module's broker.
  const env = { ...process.env, ...(await addonSettings(process.env)) };
  const config = loadConfig(env, { version: VERSION });
  const storage: Storage = config.storage === 'memory' ? createMemoryStorage() : createSqliteStorage({ path: join(config.dataDir, 'larder.db') });
  const events = createMemoryEventBus((err, event) => console.error(`Event listener failed for ${event.type}:`, err));

  let log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void } = console as never;
  // Home Assistant, for modules that make zones or automations there: through the
  // Supervisor as an add-on, or by address and token when Larder runs elsewhere.
  const homeAssistant = isAddon(env)
    ? createHomeAssistant({ url: 'http://supervisor/core', token: env.SUPERVISOR_TOKEN!, supervisor: { url: 'http://supervisor', token: env.SUPERVISOR_TOKEN! } })
    : config.haUrl && config.haToken ? createHomeAssistant({ url: config.haUrl, token: config.haToken }) : null;
  const core = await createCore(
    { storage, files: createLocalFileStore(join(config.dataDir, 'files')), search: createMemorySearchIndex(), events, homeAssistant },
    { modules, disabled: config.disabledModules, env, logger: (level, message, extra) => log[level](extra ?? {}, message) },
  );

  const backupDir = join(config.dataDir, 'backups');
  const backup = storage.backup
    ? async () => {
        const file = await storage.backup!(backupDir);
        const files = (await readdir(backupDir)).filter((f) => f.endsWith('.db')).sort();
        for (const old of files.slice(0, Math.max(0, files.length - config.backupsToKeep))) await rm(join(backupDir, old), { force: true });
        return file;
      }
    : undefined;

  const { app, auth } = await buildApp({ core, config, backup });
  log = app.log as never;

  if (config.demo && (await core.products.list()).length === 0 && (await core.products.list({ status: 'wish' })).length === 0) {
    const n = await seedDemo(core);
    app.log.info(`Loaded ${n} example items (LARDER_DEMO is on).`);
  }

  const timers: NodeJS.Timeout[] = [];
  if (backup && config.backupEveryHours > 0) {
    timers.push(setInterval(() => backup().then((f) => app.log.info(`Backed up to ${f}`), (err: unknown) => app.log.error({ err }, 'Backup failed')), config.backupEveryHours * 3_600_000));
  }
  // Publishes stock.expiring / stock.expired for Home Assistant and modules.
  const checkExpiry = () => core.automation.checkExpiry().catch((err: unknown) => app.log.error({ err }, 'Expiry check failed'));
  timers.push(setTimeout(checkExpiry, 15_000), setInterval(checkExpiry, 3_600_000));
  for (const t of timers) t.unref();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, stopping`);
    for (const t of timers) clearTimeout(t);
    await app.close();
    await storage.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Larder ${config.version} is running on port ${config.port} (storage: ${config.storage}, login: ${config.auth}, data: ${config.dataDir})`);

  if (isAddon(process.env)) {
    const token = await auth.integrationToken(join(config.dataDir, 'integration-token'));
    void announceToHomeAssistant({ supervisorToken: process.env.SUPERVISOR_TOKEN!, port: config.port, token, log: app.log });
    void notifyIntegrationInstalled({ supervisorToken: process.env.SUPERVISOR_TOKEN!, dataDir: config.dataDir, log: app.log });
  }
}

main().catch((err: unknown) => {
  console.error('Larder failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
