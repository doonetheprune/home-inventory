/**
 * Feature modules: everything that isn't the stable core (lookup providers,
 * pricing, and later scenarios, printing, recipes, MQTT…).
 *
 * A module only uses the public core API passed to `setup` plus the hooks on
 * its context. It can be switched on and off at runtime. See docs/modules.md
 * and modules/_template for a step-by-step guide.
 */
import { z } from 'zod';
import type { CoreApi } from './core';
import { LarderError, ValidationError } from './errors';
import type { DocumentCollection, LarderEvent } from './ports';
import type { CoreContext } from './services/context';
import type { LookupProvider } from './services/lookup';
import type { SearchSection } from './services/search';
import type { ActionDefinition, SensorDefinition } from './services/automation';
import type { AssistantTool } from './services/assistant';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ModuleRequest<B = unknown, Q = unknown, P = unknown> {
  body: B;
  query: Q;
  params: P;
  userId: string | null;
}

/** An HTTP route served at /api/v1/modules/<module id><path>. Appears in the OpenAPI spec. */
export interface ModuleRoute {
  method: HttpMethod;
  /** Relative path, e.g. "/check" or "/items/:id". */
  path: string;
  summary: string;
  description?: string;
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
  response?: z.ZodType;
  /** Only household admins may call it, e.g. because it changes Home Assistant's set-up. */
  admin?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler(req: ModuleRequest<any, any, any>): Promise<unknown>;
}

export interface ModuleLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export interface ModuleContext {
  id: string;
  core: CoreApi;
  /** From environment variables LARDER_MODULE_<ID>_<KEY> (id upper-cased, dashes as underscores). */
  config: Record<string, string>;
  isEnabled(): boolean;
  /** Your own JSON documents, stored by whichever storage adapter is in use. */
  collection<T = Record<string, unknown>>(name: string): DocumentCollection<T>;
  /** For web services (maps, lookups). Use it rather than the global fetch, so tests can stand in for the internet. */
  fetch: typeof fetch;
  addLookupProvider(provider: LookupProvider): void;
  addSearchSection(section: SearchSection): void;
  addRoute(route: ModuleRoute): void;
  /**
   * A sensor for Home Assistant (and MQTT). Its id must start with this module's id in
   * snake_case, e.g. "batteries_low" for the "batteries" module. Hidden while the module is off.
   */
  addSensor(sensor: SensorDefinition): void;
  /** An action for Home Assistant and Node-RED. Same id rule as sensors. */
  addAction<I extends z.ZodObject>(action: ActionDefinition<I>): void;
  /**
   * A tool for AI assistants (MCP). Name it plainly ("check_price"): names are shared
   * with the core and other modules and must be unique. Hidden while the module is off.
   */
  addTool<I extends z.ZodObject>(tool: AssistantTool<I>): void;
  /**
   * Publish an event for the web app, Home Assistant and other modules. The type
   * must start with this module's id, e.g. "batteries.low". Dropped while the module is off.
   */
  publish(type: string, data: Record<string, unknown>): void;
  /** Runs only while the module is switched on. `type` can end in * to match a prefix. */
  on(type: string, handler: (event: LarderEvent) => void | Promise<void>): void;
  log: ModuleLogger;
}

export interface ModuleDefinition {
  /** Lower-case, dashes allowed, e.g. "lookup-openfoodfacts". */
  id: string;
  name: string;
  /** One sentence shown in Settings. */
  description: string;
  version: string;
  defaultEnabled?: boolean;
  /** Schema for this module's data in `product.fields[id]`. */
  productFields?: z.ZodType;
  setup?(ctx: ModuleContext): void | Promise<void>;
  /** Adds this module's part of the example household (LARDER_DEMO), given its items and places by name (and places by code). */
  demo?(ctx: ModuleContext, seed: DemoSeed): Promise<void>;
}

export interface DemoSeed {
  products: Record<string, string>;
  places: Record<string, string>;
}

export function defineModule(def: ModuleDefinition): ModuleDefinition {
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) throw new Error(`Module id "${def.id}" must be lower-case letters, numbers and dashes.`);
  return def;
}

export interface ModuleInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  /** Switched off by LARDER_MODULES_DISABLED, so it can't be switched on in the app. */
  locked: boolean;
}

export interface ModuleRegistry {
  list(): ModuleInfo[];
  isEnabled(id: string): boolean;
  setEnabled(id: string, enabled: boolean): Promise<ModuleInfo>;
  routes(): Array<{ moduleId: string; route: ModuleRoute }>;
  isProviderEnabled(providerId: string): boolean;
  validateFields(fields: Record<string, unknown>): Record<string, unknown>;
  start(core: CoreApi): Promise<void>;
  /** Runs each switched-on module's `demo`, after the core's example household is in. */
  seedDemo(seed: DemoSeed): Promise<void>;
}

export interface ModuleOptions {
  modules?: ModuleDefinition[];
  /** Module ids that are always off. */
  disabled?: string[];
  env?: Record<string, string | undefined>;
  logger?: (level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) => void;
}

function prefixed<T extends { id: string }>(moduleId: string, what: string, item: T): T {
  const prefix = moduleId.replace(/-/g, '_');
  if (item.id !== prefix && !item.id.startsWith(`${prefix}_`)) throw new Error(`${what} "${item.id}" from module ${moduleId} must start with "${prefix}_".`);
  return item;
}

export function createModuleRegistry(ctx: CoreContext, options: ModuleOptions): ModuleRegistry {
  const defs = options.modules ?? [];
  const ids = new Set<string>();
  for (const d of defs) {
    if (ids.has(d.id)) throw new Error(`Two modules use the id "${d.id}".`);
    ids.add(d.id);
  }
  const locked = new Set(options.disabled ?? []);
  let saved: Record<string, boolean> = {};
  const routes: Array<{ moduleId: string; route: ModuleRoute }> = [];
  const providerOwner = new Map<string, string>();
  const log = options.logger ?? (() => {});
  const contexts = new Map<string, ModuleContext>();

  const enabled = (id: string) => {
    if (locked.has(id)) return false;
    const def = defs.find((d) => d.id === id);
    if (!def) return false;
    return saved[id] ?? def.defaultEnabled ?? true;
  };

  const info = (d: ModuleDefinition): ModuleInfo => ({ id: d.id, name: d.name, description: d.description, version: d.version, enabled: enabled(d.id), locked: locked.has(d.id) });

  function configFor(id: string): Record<string, string> {
    const prefix = `LARDER_MODULE_${id.toUpperCase().replace(/-/g, '_')}_`;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env ?? {})) if (k.startsWith(prefix) && v !== undefined) out[k.slice(prefix.length).toLowerCase()] = v;
    return out;
  }

  return {
    list: () => defs.map(info),
    isEnabled: enabled,
    async setEnabled(id, on) {
      const def = defs.find((d) => d.id === id);
      if (!def) throw new LarderError(`There's no module called ${id}.`, 404, 'not_found');
      if (locked.has(id) && on) throw new LarderError(`${def.name} is switched off by the LARDER_MODULES_DISABLED setting on the server.`, 409, 'locked');
      saved = { ...saved, [id]: on };
      await ctx.storage.settings.set('modules', saved);
      ctx.publish('settings.changed', { modules: saved });
      ctx.publish('search.changed', {});
      return info(def);
    },
    routes: () => routes,
    isProviderEnabled: (providerId) => {
      const owner = providerOwner.get(providerId);
      return owner ? enabled(owner) : true;
    },
    validateFields(fields) {
      const out: Record<string, unknown> = { ...fields };
      for (const d of defs) {
        if (!d.productFields || out[d.id] === undefined) continue;
        const parsed = d.productFields.safeParse(out[d.id]);
        if (!parsed.success) throw new ValidationError(`${d.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`);
        out[d.id] = parsed.data;
      }
      return out;
    },
    async seedDemo(seed) {
      for (const def of defs) {
        const mctx = contexts.get(def.id);
        if (def.demo && mctx && enabled(def.id)) await def.demo(mctx, seed);
      }
    },
    async start(core) {
      saved = (await ctx.storage.settings.get<Record<string, boolean>>('modules')) ?? {};
      for (const def of defs) {
        const moduleLog: ModuleLogger = {
          info: (m, e) => log('info', `[${def.id}] ${m}`, e),
          warn: (m, e) => log('warn', `[${def.id}] ${m}`, e),
          error: (m, e) => log('error', `[${def.id}] ${m}`, e),
        };
        const mctx: ModuleContext = {
          id: def.id,
          core,
          config: configFor(def.id),
          isEnabled: () => enabled(def.id),
          collection: <T>(name: string) => ctx.storage.documents<T>(`${def.id}:${name}`),
          fetch: ctx.fetch,
          addLookupProvider(provider) {
            providerOwner.set(provider.id, def.id);
            core.lookup.registerProvider(provider);
          },
          addSearchSection(section) {
            core.search.addSection({ ...section, results: async (q, hits) => (enabled(def.id) ? section.results(q, hits) : []) });
          },
          addRoute(route) {
            routes.push({ moduleId: def.id, route });
          },
          addSensor(sensor) {
            core.automation.addSensor(prefixed(def.id, 'Sensor', sensor), def.id, () => enabled(def.id));
          },
          addAction(action) {
            core.automation.addAction(prefixed(def.id, 'Action', action), def.id, () => enabled(def.id));
          },
          addTool(tool) {
            core.assistant.addTool(tool, def.id, () => enabled(def.id));
          },
          publish(type, data) {
            if (!type.startsWith(`${def.id}.`)) throw new Error(`Event "${type}" from module ${def.id} must start with "${def.id}.".`);
            if (enabled(def.id)) ctx.publish(type, data);
          },
          on(type, handler) {
            const match = type.endsWith('*') ? (t: string) => t.startsWith(type.slice(0, -1)) : (t: string) => t === type;
            ctx.events.subscribe((event) => {
              if (!enabled(def.id) || !match(event.type)) return;
              Promise.resolve(handler(event)).catch((err: unknown) => moduleLog.error('Event handler failed', { error: String(err), event: event.type }));
            });
          },
          log: moduleLog,
        };
        contexts.set(def.id, mctx);
        try {
          await def.setup?.(mctx);
        } catch (err) {
          moduleLog.error('Setup failed; the module is unavailable', { error: String(err) });
          locked.add(def.id);
        }
      }
    },
  };
}
