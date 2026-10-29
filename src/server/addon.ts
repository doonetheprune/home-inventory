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
import { hostname } from 'node:os';

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
}

export const isAddon = (env: Record<string, string | undefined>) => !!env.SUPERVISOR_TOKEN;

/** Settings implied by running as an add-on, plus the person's add-on options. Empty outside an add-on. */
export function addonEnv(env: Record<string, string | undefined>, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): Record<string, string> {
  if (!isAddon(env)) return {};
  let options: AddonOptions = {};
  try {
    options = JSON.parse(read(env.LARDER_ADDON_OPTIONS ?? ADDON_OPTIONS_FILE)) as AddonOptions;
  } catch {
    // No options yet: the defaults below are fine.
  }
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
