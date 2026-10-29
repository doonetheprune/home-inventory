/**
 * Wires the core services to whichever adapters you pass in.
 *
 *   const core = await createCore({ storage, files, search, events }, { modules });
 *
 * The server, tests and modules all use the object this returns.
 */
import { HouseholdSettings, createContext, type CoreDeps } from './services/context';
import { createCategoryService, createPlaceService, createShopService } from './services/catalogue';
import { createHomeService } from './services/home';
import { createLookupService } from './services/lookup';
import { createProductService } from './services/products';
import { createSearchService } from './services/search';
import { createShoppingService } from './services/shopping';
import { createStockService } from './services/stock';
import { createAutomation, type Automation } from './services/automation';
import { createResolver, type Resolver } from './services/resolve';
import { createNfcService } from './services/nfc';
import { createAssistant, type Assistant } from './services/assistant';
import { createModuleRegistry, type ModuleOptions, type ModuleRegistry } from './modules';
import type { EventBus, FileStore, LarderEvent, Storage } from './ports';
import type { Movement } from './model';
import { newId } from './util';

export interface CoreApi {
  categories: ReturnType<typeof createCategoryService>;
  shops: ReturnType<typeof createShopService>;
  places: ReturnType<typeof createPlaceService>;
  products: ReturnType<typeof createProductService>;
  stock: ReturnType<typeof createStockService>;
  shopping: ReturnType<typeof createShoppingService>;
  search: ReturnType<typeof createSearchService>;
  lookup: ReturnType<typeof createLookupService>;
  home: ReturnType<typeof createHomeService>;
  /** Find things by name, code or id ("loo roll", "G2-4", "Aldi"). Refuses to guess between close matches. */
  resolve: Resolver;
  /** Sensors and actions for Home Assistant, Node-RED and MQTT. */
  automation: Automation;
  /** NFC tag scans and linking. */
  nfc: ReturnType<typeof createNfcService>;
  /** Tools for AI assistants, served over MCP. */
  assistant: Assistant;
  settings: {
    get(): Promise<HouseholdSettings>;
    update(patch: Partial<HouseholdSettings>): Promise<HouseholdSettings>;
  };
  /** A random id made the first time this Larder starts. Integrations use it to tell Larders apart. */
  instanceId(): Promise<string>;
  history: {
    recent(limit?: number): Promise<Movement[]>;
  };
  modules: ModuleRegistry;
  events: {
    subscribe(handler: (event: LarderEvent) => void): () => void;
  };
  /** Adapters, for the server's own needs (login, files, backups). Modules should not use these. */
  adapters: { storage: Storage; files: FileStore; events: EventBus };
  today(): string;
  now(): string;
}

export async function createCore(deps: CoreDeps, options: ModuleOptions = {}): Promise<CoreApi> {
  const ctx = createContext(deps);
  const modules = createModuleRegistry(ctx, options);
  const categories = createCategoryService(ctx);
  const products = createProductService(ctx, (f) => modules.validateFields(f));
  const stock = createStockService(ctx);
  const shopping = createShoppingService(ctx, stock);
  const search = createSearchService(ctx);
  const lookup = createLookupService(ctx, products, (id) => modules.isProviderEnabled(id));
  const home = createHomeService(ctx, stock, shopping);
  const resolve = createResolver(ctx, search, lookup);
  const automation = createAutomation({ ctx, products, stock, shopping, resolve });

  const core: CoreApi = {
    categories,
    shops: createShopService(ctx),
    places: createPlaceService(ctx),
    products,
    stock,
    shopping,
    search,
    lookup,
    home,
    resolve,
    automation,
    nfc: createNfcService(ctx, products),
    assistant: createAssistant({ ctx, products, stock, shopping, search, categories, automation, resolve }),
    settings: {
      get: () => ctx.household(),
      async update(patch) {
        const next = HouseholdSettings.parse({ ...(await ctx.household()), ...patch });
        await ctx.storage.settings.set('household', next);
        ctx.publish('settings.changed', { household: next });
        return ctx.household();
      },
    },
    async instanceId() {
      const saved = await ctx.storage.settings.get<string>('instanceId');
      if (saved) return saved;
      const id = newId();
      await ctx.storage.settings.set('instanceId', id);
      return id;
    },
    history: {
      recent: (limit = 50) => ctx.storage.movements.listRecent(limit),
    },
    modules,
    events: { subscribe: (h) => ctx.events.subscribe(h) },
    adapters: { storage: deps.storage, files: deps.files, events: deps.events },
    today: () => ctx.today(),
    now: () => ctx.now(),
  };

  await ctx.household();
  await core.instanceId();
  await categories.ensureDefaults();
  await modules.start(core);
  return core;
}
