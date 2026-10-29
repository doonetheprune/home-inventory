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
import { createModuleRegistry, type ModuleOptions, type ModuleRegistry } from './modules';
import type { EventBus, FileStore, LarderEvent, Storage } from './ports';
import type { Movement } from './model';

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
  settings: {
    get(): Promise<HouseholdSettings>;
    update(patch: Partial<HouseholdSettings>): Promise<HouseholdSettings>;
  };
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

  const core: CoreApi = {
    categories,
    shops: createShopService(ctx),
    places: createPlaceService(ctx),
    products,
    stock,
    shopping,
    search: createSearchService(ctx),
    lookup: createLookupService(ctx, products, (id) => modules.isProviderEnabled(id)),
    home: createHomeService(ctx, stock, shopping),
    settings: {
      get: () => ctx.household(),
      async update(patch) {
        const next = HouseholdSettings.parse({ ...(await ctx.household()), ...patch });
        await ctx.storage.settings.set('household', next);
        ctx.publish('settings.changed', { household: next });
        return ctx.household();
      },
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
  await categories.ensureDefaults();
  await modules.start(core);
  return core;
}
