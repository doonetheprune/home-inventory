/**
 * In-memory storage. Used by tests and as the reference implementation for
 * new adapters: it is the simplest code that passes tests/contract.
 * Everything is lost when the process stops.
 */
import type {
  ApiToken, Category, Collection, DocumentCollection, LookupRecord, Movement, Place, PlaceCollection, Product, ProductCollection,
  Session, Shop, StockChanges, StockCollection, StockEntry, Storage, TokenCollection, User, UserCollection, Variant, VariantCollection,
} from '@larder/core';
import { ConflictError } from '@larder/core';

const clone = <T>(v: T): T => structuredClone(v);

class MemoryCollection<T extends { id: string }> implements Collection<T> {
  protected items = new Map<string, T>();
  async get(id: string) {
    const v = this.items.get(id);
    return v ? clone(v) : null;
  }
  async list() {
    return [...this.items.values()].map(clone);
  }
  async put(doc: T) {
    this.items.set(doc.id, clone(doc));
  }
  async remove(id: string) {
    this.items.delete(id);
  }
  protected find(pred: (v: T) => boolean): T | null {
    for (const v of this.items.values()) if (pred(v)) return clone(v);
    return null;
  }
  protected filter(pred: (v: T) => boolean): T[] {
    return [...this.items.values()].filter(pred).map(clone);
  }
  /** Used by the batch writer. */
  raw() {
    return this.items;
  }
}

class Places extends MemoryCollection<Place> implements PlaceCollection {
  async findByCode(code: string) {
    const c = code.trim().toLowerCase();
    return this.find((p) => !!p.code && p.code.toLowerCase() === c);
  }
  async findByNfcTag(tag: string) {
    return this.find((p) => p.nfcTags.includes(tag));
  }
}

class Products extends MemoryCollection<Product> implements ProductCollection {
  async findByNfcTag(tag: string) {
    return this.find((p) => p.nfcTags.includes(tag));
  }
}

class Variants extends MemoryCollection<Variant> implements VariantCollection {
  async listByProduct(productId: string) {
    return this.filter((v) => v.productId === productId);
  }
  async findByBarcode(barcode: string) {
    return this.find((v) => v.barcodes.includes(barcode));
  }
  async findByShopCode(code: string, shopId?: string) {
    const c = code.trim().toLowerCase();
    return this.find((v) => v.shopCodes.some((s) => s.code.toLowerCase() === c && (!shopId || s.shopId === shopId)));
  }
}

class Stock extends MemoryCollection<StockEntry> implements StockCollection {
  async listByProduct(productId: string) {
    return this.filter((e) => e.productId === productId);
  }
  async listByPlace(placeId: string) {
    return this.filter((e) => e.placeId === placeId || e.currentPlaceId === placeId);
  }
}

class Users extends MemoryCollection<User> implements UserCollection {
  override async put(doc: User) {
    const u = doc.username.trim().toLowerCase();
    if (this.find((x) => x.id !== doc.id && x.username.toLowerCase() === u)) throw new ConflictError(`There's already an account called ${doc.username}.`);
    await super.put(doc);
  }
  async findByUsername(username: string) {
    const u = username.trim().toLowerCase();
    return this.find((x) => x.username.toLowerCase() === u);
  }
}

class Tokens extends MemoryCollection<ApiToken> implements TokenCollection {
  async findByHash(tokenHash: string) {
    return this.find((t) => t.tokenHash === tokenHash);
  }
}

export function createMemoryStorage(): Storage {
  const stock = new Stock();
  const products = new Products();
  const movements: Movement[] = [];
  const lookups = new Map<string, LookupRecord>();
  const sessions = new Map<string, Session>();
  const settings = new Map<string, unknown>();
  const documents = new Map<string, Map<string, unknown>>();

  return {
    categories: new MemoryCollection<Category>(),
    shops: new MemoryCollection<Shop>(),
    places: new Places(),
    products,
    variants: new Variants(),
    stock,
    movements: {
      async append(ms) {
        movements.push(...ms.map(clone));
      },
      async listByProduct(productId, limit) {
        return movements.filter((m) => m.productId === productId).reverse().slice(0, limit).map(clone);
      },
      async listRecent(limit) {
        return [...movements].reverse().slice(0, limit).map(clone);
      },
    },
    lookups: {
      async get(barcode) {
        const r = lookups.get(barcode);
        return r ? clone(r) : null;
      },
      async put(record) {
        lookups.set(record.barcode, clone(record));
      },
    },
    users: new Users(),
    sessions: {
      async get(id) {
        const s = sessions.get(id);
        return s ? clone(s) : null;
      },
      async put(s) {
        sessions.set(s.id, clone(s));
      },
      async remove(id) {
        sessions.delete(id);
      },
      async removeExpired(now) {
        for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
      },
    },
    tokens: new Tokens(),
    settings: {
      async get<T>(key: string) {
        return settings.has(key) ? (clone(settings.get(key)) as T) : null;
      },
      async set(key, value) {
        settings.set(key, clone(value));
      },
    },
    documents<T>(name: string): DocumentCollection<T> {
      let col = documents.get(name);
      if (!col) documents.set(name, (col = new Map()));
      const c = col;
      return {
        async get(id) {
          return c.has(id) ? (clone(c.get(id)) as T) : null;
        },
        async list() {
          return [...c.entries()].map(([id, data]) => ({ id, data: clone(data) as T }));
        },
        async put(id, data) {
          c.set(id, clone(data));
        },
        async remove(id) {
          c.delete(id);
        },
      };
    },
    async applyStockChanges(changes: StockChanges) {
      // Validate everything first so the batch is all-or-nothing.
      for (const e of changes.put ?? []) if (!e.id || !e.productId) throw new Error('Stock entry needs an id and productId');
      for (const e of changes.put ?? []) stock.raw().set(e.id, clone(e));
      for (const id of changes.remove ?? []) stock.raw().delete(id);
      movements.push(...(changes.movements ?? []).map(clone));
      for (const p of changes.products ?? []) products.raw().set(p.id, clone(p));
    },
    async close() {},
  };
}
