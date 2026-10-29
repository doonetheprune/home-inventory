/**
 * Running as a Home Assistant add-on.
 *
 * The Supervisor starts the add-on with SUPERVISOR_TOKEN set and writes the
 * options chosen in Home Assistant to /data/options.json. This turns those
 * options into Larder's normal settings, and tells Home Assistant where to
 * find Larder (Supervisor discovery) so the integration can set itself up
 * without anyone copying addresses or tokens.
 */
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const ADDON_OPTIONS_FILE = '/data/options.json';

export interface AddonOptions {
  log_level?: string;
  disabled_modules?: string[];
  /** Keep Larder's own daily backups too (Home Assistant backups already include its data). */
  backups?: boolean;
  base_url?: string;
  demo?: boolean;
  /** Home Assistant usernames who are Larder admins; everyone else is a member. Empty: everyone is an admin. */
  admins?: string[];
  /** Advanced: any other LARDER_* setting, e.g. a module's settings. */
  env_vars?: Array<{ name: string; value: string }>;
  /** Keep Home Assistant's Larder integration installed and up to date (default on). Off for HACS. */
  install_integration?: boolean;
}

function readOptions(env: Record<string, string | undefined>, read: (file: string) => string): AddonOptions {
  try {
    return JSON.parse(read(env.LARDER_ADDON_OPTIONS ?? ADDON_OPTIONS_FILE)) as AddonOptions;
  } catch {
    // No options yet: the defaults are fine.
    return {};
  }
}

export const isAddon = (env: Record<string, string | undefined>) => !!env.SUPERVISOR_TOKEN;

/** Settings implied by running as an add-on, plus the person's add-on options. Empty outside an add-on. */
export function addonEnv(env: Record<string, string | undefined>, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): Record<string, string> {
  if (!isAddon(env)) return {};
  const options = readOptions(env, read);
  const out: Record<string, string> = {
    LARDER_AUTH: 'homeassistant',
    LARDER_DATA_DIR: env.LARDER_DATA_DIR ?? '/data',
    LARDER_PORT: '8080',
    LARDER_HOST: '0.0.0.0',
    LARDER_BACKUP_EVERY_HOURS: options.backups ? '24' : '0',
  };
  if (options.log_level) out.LARDER_LOG_LEVEL = options.log_level;
  if (options.disabled_modules?.length) out.LARDER_MODULES_DISABLED = options.disabled_modules.join(',');
  if (options.base_url) out.LARDER_BASE_URL = options.base_url;
  if (options.demo) out.LARDER_DEMO = 'true';
  if (options.admins?.length) out.LARDER_HA_ADMINS = options.admins.join(',');
  for (const v of options.env_vars ?? []) {
    if (/^LARDER_[A-Z0-9_]+$/.test(v.name) && v.name !== 'LARDER_AUTH') out[v.name] = v.value;
  }
  return out;
}

/**
 * The Mosquitto broker add-on's details from the Supervisor, as the MQTT
 * module's settings, so switching MQTT on in Larder just works. Empty when
 * there's no broker, outside an add-on, or when a broker is already set.
 */
export async function supervisorMqtt(env: Record<string, string | undefined>, doFetch: typeof fetch = fetch): Promise<Record<string, string>> {
  if (!isAddon(env) || env.LARDER_MODULE_MQTT_URL) return {};
  try {
    const res = await doFetch('http://supervisor/services/mqtt', { headers: { authorization: `Bearer ${env.SUPERVISOR_TOKEN}` } });
    if (!res.ok) return {};
    const { data } = (await res.json()) as { data?: { host?: string; port?: number; ssl?: boolean; username?: string; password?: string } };
    if (!data?.host) return {};
    return {
      LARDER_MODULE_MQTT_URL: `${data.ssl ? 'mqtts' : 'mqtt'}://${data.host}:${data.port ?? (data.ssl ? 8883 : 1883)}`,
      ...(data.username ? { LARDER_MODULE_MQTT_USERNAME: data.username } : {}),
      ...(data.password ? { LARDER_MODULE_MQTT_PASSWORD: data.password } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * All the settings the add-on makes, on top of the environment: its options
 * first, then the Mosquitto add-on's broker only if no broker is set anywhere
 * (the Supervisor's MQTT login must never go to a broker the person named).
 */
export async function addonSettings(
  env: Record<string, string | undefined>,
  io: { read?: (file: string) => string; fetch?: typeof fetch } = {},
): Promise<Record<string, string>> {
  const options = addonEnv(env, io.read);
  return { ...(await supervisorMqtt({ ...env, ...options }, io.fetch)), ...options };
}

/**
 * Tells Home Assistant "Larder is here", with the address and a token for
 * the integration. Home Assistant then offers to set up the integration.
 * Retries for a while, because the Supervisor may still be starting.
 */
export async function announceToHomeAssistant(options: {
  supervisorToken: string;
  port: number;
  token: string;
  log: { info(msg: string): void; warn(msg: string): void };
  fetch?: typeof fetch;
  attempts?: number;
  delayMs?: number;
}): Promise<boolean> {
  const doFetch = options.fetch ?? fetch;
  const attempts = options.attempts ?? 6;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch('http://supervisor/discovery', {
        method: 'POST',
        headers: { authorization: `Bearer ${options.supervisorToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ service: 'larder', config: { host: hostname(), port: options.port, token: options.token } }),
      });
      if (res.ok) {
        options.log.info('Told Home Assistant where Larder is. It will offer to set up the Larder integration.');
        return true;
      }
      options.log.warn(`Home Assistant discovery answered ${res.status}. Trying again.`);
    } catch (err) {
      options.log.warn(`Couldn't reach the Supervisor for discovery (${err instanceof Error ? err.message : String(err)}). Trying again.`);
    }
    await new Promise((r) => setTimeout(r, (options.delayMs ?? 5000) * (i + 1)));
  }
  options.log.warn('Gave up telling Home Assistant about Larder. Add the integration by hand with the address and a token from Settings.');
  return false;
}

/* ------------------------------------------------------------------ */
/* The Home Assistant integration, installed by the add-on              */
/* ------------------------------------------------------------------ */

/** "0.10.0" is newer than "0.9.2". Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

async function manifestVersion(dir: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export type IntegrationInstall = { result: 'installed' | 'updated' | 'current' | 'newer' | 'missing'; version: string | null; previous: string | null };

/**
 * Puts the integration that matches this Larder into Home Assistant's
 * custom_components folder: installs it when it's missing, updates it when
 * it's older, and leaves alone one that's the same or newer (from HACS, say).
 * The new folder is copied next to the old one and swapped in, so Home
 * Assistant never sees half of it. Home Assistant loads it after a restart.
 */
export async function installIntegration(options: { source: string; configDir: string }): Promise<IntegrationInstall> {
  const version = await manifestVersion(options.source);
  if (!version) return { result: 'missing', version: null, previous: null };
  const parent = join(options.configDir, 'custom_components');
  const target = join(parent, 'larder');
  const previous = await manifestVersion(target);
  if (previous && compareVersions(previous, version) >= 0) return { result: compareVersions(previous, version) ? 'newer' : 'current', version, previous };
  await mkdir(parent, { recursive: true });
  // A dot name isn't a Python package, so Home Assistant ignores it while it's being copied.
  const staged = join(parent, '.larder-new');
  await rm(staged, { recursive: true, force: true });
  await cp(options.source, staged, { recursive: true, filter: (src) => !src.includes('__pycache__') });
  await rm(target, { recursive: true, force: true });
  await rename(staged, target);
  return { result: previous ? 'updated' : 'installed', version, previous };
}

/** Where the install step (run as root by the entrypoint) leaves its result for Larder to report. */
export const integrationStatusFile = (dataDir: string) => join(dataDir, 'integration-install.json');

/**
 * The entrypoint's install step: does nothing outside an add-on or when the
 * "install the integration" option is off. Never fails the add-on's start.
 */
export async function runIntegrationInstall(
  env: Record<string, string | undefined>,
  io: { read?: (file: string) => string; log?: (msg: string) => void } = {},
): Promise<IntegrationInstall | null> {
  const log = io.log ?? ((m: string) => console.log(`[larder] ${m}`));
  if (!isAddon(env)) return null;
  if (readOptions(env, io.read ?? ((f) => readFileSync(f, 'utf8'))).install_integration === false) {
    log('Not installing the Home Assistant integration (turned off in the add-on options).');
    return null;
  }
  try {
    const status = await installIntegration({ source: env.LARDER_INTEGRATION_SOURCE ?? '/app/integration/larder', configDir: env.LARDER_HA_CONFIG_DIR ?? '/homeassistant' });
    const say = {
      installed: `Installed the Larder integration ${status.version} in Home Assistant. Restart Home Assistant to load it.`,
      updated: `Updated the Larder integration from ${status.previous} to ${status.version}. Restart Home Assistant to load it.`,
      current: `The Larder integration ${status.version} is already installed.`,
      newer: `Home Assistant has a newer Larder integration (${status.previous}) than this add-on (${status.version}); leaving it.`,
      missing: 'This image has no Larder integration to install.',
    }[status.result];
    log(say);
    if (status.result === 'installed' || status.result === 'updated') await writeFile(integrationStatusFile(env.LARDER_DATA_DIR ?? '/data'), JSON.stringify(status));
    return status;
  } catch (err) {
    log(`Couldn't install the Larder integration in Home Assistant (${err instanceof Error ? err.message : String(err)}). Install it by hand: see the add-on's documentation.`);
    return null;
  }
}

/**
 * After the integration was installed or updated, asks the person to restart
 * Home Assistant with a notification in Home Assistant. Retries while Home
 * Assistant starts; forgets the status once the notification is shown.
 */
export async function notifyIntegrationInstalled(options: {
  supervisorToken: string;
  dataDir: string;
  log: { info(msg: string): void; warn(msg: string): void };
  fetch?: typeof fetch;
  attempts?: number;
  delayMs?: number;
}): Promise<boolean> {
  const file = integrationStatusFile(options.dataDir);
  let status: IntegrationInstall;
  try {
    status = JSON.parse(await readFile(file, 'utf8')) as IntegrationInstall;
  } catch {
    return false;
  }
  const message = status.result === 'updated'
    ? `Larder updated its Home Assistant integration from ${status.previous} to ${status.version}. Restart Home Assistant to load it (Settings → System → Restart).`
    : `Larder installed its Home Assistant integration (${status.version}). Restart Home Assistant (Settings → System → Restart), then set it up from Settings → Devices & services, where Larder will be waiting under Discovered.`;
  const doFetch = options.fetch ?? fetch;
  const attempts = options.attempts ?? 10;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await doFetch('http://supervisor/core/api/services/persistent_notification/create', {
        method: 'POST',
        headers: { authorization: `Bearer ${options.supervisorToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ notification_id: 'larder_integration', title: 'Larder: restart Home Assistant', message }),
      });
      if (res.ok) {
        await rm(file, { force: true });
        options.log.info('Asked Home Assistant to show a restart notification for the Larder integration.');
        return true;
      }
    } catch {
      // Home Assistant may still be starting.
    }
    await new Promise((r) => setTimeout(r, (options.delayMs ?? 5000) * (i + 1)));
  }
  options.log.warn('Couldn\'t show the restart notification. Restart Home Assistant to load the Larder integration.');
  return false;
}
