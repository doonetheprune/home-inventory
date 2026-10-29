/**
 * Server settings, all from environment variables so Larder runs the same way
 * in Docker, as a Home Assistant add-on, or on a laptop. See docs/running.md.
 */
import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  /** Holds the database, photos and backups. Back this folder up. */
  dataDir: string;
  /** "local": household login and access tokens. "none": no login (trusted networks only). */
  /**
   * "local": household accounts and tokens. "none": no login (trusted networks).
   * "homeassistant": the add-on. People arriving through Home Assistant ingress are
   * signed in as their Home Assistant user; everything else needs a token or account.
   */
  auth: 'local' | 'none' | 'homeassistant';
  /** Addresses Home Assistant ingress requests come from (the Supervisor). */
  ingressAddresses: string[];
  /** Home Assistant usernames (lower case) who are Larder admins. Empty: everyone arriving through Home Assistant is. */
  haAdmins: string[];
  /**
   * Home Assistant's address and an admin's long-lived access token, for Larder
   * running outside Home Assistant to make zones and automations there. The
   * add-on doesn't need these: it goes through the Supervisor.
   */
  haUrl: string | null;
  haToken: string | null;
  storage: 'sqlite' | 'memory';
  /** Public address, used in QR labels and links, e.g. https://larder.example.com */
  baseUrl: string | null;
  /** Module ids that are always off. */
  disabledModules: string[];
  logLevel: string;
  /**
   * Which reverse proxies to believe about the caller's address and https:
   * false (none), true (any), a number of hops, or addresses and ranges.
   */
  trustProxy: boolean | number | string;
  /** Load example data into an empty database on start. */
  demo: boolean;
  /** Hours between automatic backups (0 turns them off). */
  backupEveryHours: number;
  backupsToKeep: number;
  /** Folder with the built web app. */
  webDir: string;
  version: string;
}

const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const proxies = (v: string | undefined): boolean | number | string => {
  const t = (v ?? '').trim().toLowerCase();
  if (['', '0', 'false', 'no', 'off'].includes(t)) return false;
  if (['true', 'yes', 'on'].includes(t)) return true;
  if (/^\d+$/.test(t)) return Number(t);
  return t;
};
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? fallback : n;
};

export function loadConfig(env: Record<string, string | undefined> = process.env, defaults: { webDir?: string; version?: string } = {}): Config {
  const auth = (env.LARDER_AUTH ?? 'local').toLowerCase();
  if (auth !== 'local' && auth !== 'none' && auth !== 'homeassistant') throw new Error(`LARDER_AUTH must be "local", "none" or "homeassistant", not "${auth}".`);
  const storage = (env.LARDER_STORAGE ?? 'sqlite').toLowerCase();
  if (storage !== 'sqlite' && storage !== 'memory') throw new Error(`LARDER_STORAGE must be "sqlite" or "memory", not "${storage}".`);
  return {
    port: num(env.LARDER_PORT ?? env.PORT, 8080),
    host: env.LARDER_HOST ?? '0.0.0.0',
    dataDir: resolve(env.LARDER_DATA_DIR ?? './data'),
    auth,
    storage,
    baseUrl: env.LARDER_BASE_URL?.replace(/\/+$/, '') || null,
    disabledModules: (env.LARDER_MODULES_DISABLED ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: env.LARDER_LOG_LEVEL ?? 'info',
    trustProxy: proxies(env.LARDER_TRUST_PROXY),
    ingressAddresses: (env.LARDER_HA_INGRESS_ADDRESSES ?? '172.30.32.2').split(',').map((s) => s.trim()).filter(Boolean),
    haAdmins: (env.LARDER_HA_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    haUrl: env.LARDER_HA_URL?.replace(/\/+$/, '') || null,
    haToken: env.LARDER_HA_TOKEN || null,
    demo: bool(env.LARDER_DEMO, false),
    backupEveryHours: num(env.LARDER_BACKUP_EVERY_HOURS, 24),
    backupsToKeep: num(env.LARDER_BACKUPS_TO_KEEP, 7),
    webDir: resolve(env.LARDER_WEB_DIR ?? defaults.webDir ?? './dist/web'),
    version: defaults.version ?? env.npm_package_version ?? '0.0.0',
  };
}
