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
  for (const v of options.env_vars ?? []) {
    if (/^LARDER_[A-Z0-9_]+$/.test(v.name) && v.name !== 'LARDER_AUTH') out[v.name] = v.value;
  }
  return out;
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
