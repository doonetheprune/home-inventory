/**
 * SQLite storage using Node's built-in `node:sqlite` (no native add-ons, so
 * the Docker image works on Raspberry Pi and x86 alike).
 *
 * Each record is stored whole as JSON in a `data` column, with a few extra
 * indexed columns for the named queries the Storage port needs. This mirrors
 * how a document database like Firestore would hold the same data.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ApiToken, Category, Collection, DocumentCollection, LookupRecord, Movement, Place, PlaceCollection, Product, ProductCollection,
  Session, Shop, StockChanges, StockCollection, StockEntry, Storage, TokenCollection, User, UserCollection, Variant, VariantCollection,
} from '@larder/core';
import { MIGRATIONS } from './migrations';
import { ConflictError } from '@larder/core';

type Row = Record<string, unknown>;
type Extra<T> = (doc: T) => Record<string, string | number | null>;

function openDatabase(path: string): DatabaseSync {
  const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new sqlite.DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  return db;
}

function migrate(db: DatabaseSync) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

class SqlCollection<T extends { id: string }> implements Collection<T> {
  private readonly getStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly putStmt: StatementSync;
  private readonly removeStmt: StatementSync;

  constructor(
    protected readonly db: DatabaseSync,
    protected readonly table: string,
    private readonly extra: Extra<T> = () => ({}),
    extraColumns: string[] = [],
  ) {
    const cols = ['id', 'data', ...extraColumns];
    this.getStmt = db.prepare(`SELECT data FROM ${table} WHERE id = ?`);
    this.listStmt = db.prepare(`SELECT data FROM ${table} ORDER BY rowid`);
    this.putStmt = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`);
    this.removeStmt = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    this.extraColumns = extraColumns;
  }
  private readonly extraColumns: string[];

  protected parse(row: Row | undefined): T | null {
    return row ? (JSON.parse(row.data as string) as T) : null;
  }
  protected parseAll(rows: Row[]): T[] {
    return rows.map((r) => JSON.parse(r.data as string) as T);
  }
  async get(id: string) {
    return this.parse(this.getStmt.get(id) as Row | undefined);
  }
  async list() {
    return this.parseAll(this.listStmt.all() as Row[]);
  }
  /** Synchronous put, used inside batches. */
  putSync(doc: T) {
    const extra = this.extra(doc);
    this.putStmt.run(doc.id, JSON.stringify(doc), ...this.extraColumns.map((c) => extra[c] ?? null));
  }
  removeSync(id: string) {
    this.removeStmt.run(id);
  }
  async put(doc: T) {
    this.putSync(doc);
  }
  async remove(id: string) {
    this.removeSync(id);
  }
}

class Places extends SqlCollection<Place> implements PlaceCollection {
  private byCode = this.db.prepare('SELECT data FROM places WHERE code_lc = ?');
  private byTag = this.db.prepare("SELECT p.data FROM places p, json_each(p.data, '$.nfcTags') t WHERE t.value = ? LIMIT 1");
  async findByCode(code: string) {
    return this.parse(this.byCode.get(code.trim().toLowerCase()) as Row | undefined);
  }
  async findByNfcTag(tag: string) {
    return this.parse(this.byTag.get(tag) as Row | undefined);
  }
}

class Products extends SqlCollection<Product> implements ProductCollection {
  private byTag = this.db.prepare("SELECT p.data FROM products p, json_each(p.data, '$.nfcTags') t WHERE t.value = ? LIMIT 1");
  async findByNfcTag(tag: string) {
    return this.parse(this.byTag.get(tag) as Row | undefined);
  }
}

class Variants extends SqlCollection<Variant> implements VariantCollection {
  private byProduct = this.db.prepare('SELECT data FROM variants WHERE product_id = ? ORDER BY rowid');
  private byBarcode = this.db.prepare("SELECT v.data FROM variants v, json_each(v.data, '$.barcodes') b WHERE b.value = ? LIMIT 1");
  private byShopCode = this.db.prepare(
    "SELECT v.data FROM variants v, json_each(v.data, '$.shopCodes') s WHERE lower(json_extract(s.value, '$.code')) = ? AND (? IS NULL OR json_extract(s.value, '$.shopId') = ?) LIMIT 1",
  );
  async listByProduct(productId: string) {
    return this.parseAll(this.byProduct.all(productId) as Row[]);
  }
  async findByBarcode(barcode: string) {
    return this.parse(this.byBarcode.get(barcode) as Row | undefined);
  }
  async findByShopCode(code: string, shopId?: string) {
    const s = shopId ?? null;
    return this.parse(this.byShopCode.get(code.trim().toLowerCase(), s, s) as Row | undefined);
  }
}

class Stock extends SqlCollection<StockEntry> implements StockCollection {
  private byProduct = this.db.prepare('SELECT data FROM stock WHERE product_id = ? ORDER BY rowid');
  private byPlace = this.db.prepare('SELECT data FROM stock WHERE place_id = ? OR current_place_id = ? ORDER BY rowid');
  async listByProduct(productId: string) {
    return this.parseAll(this.byProduct.all(productId) as Row[]);
  }
  async listByPlace(placeId: string) {
    return this.parseAll(this.byPlace.all(placeId, placeId) as Row[]);
  }
}

class Users extends SqlCollection<User> implements UserCollection {
  private byName = this.db.prepare('SELECT data FROM users WHERE username_lc = ?');
  override async put(doc: User) {
    const other = await this.findByUsername(doc.username);
    if (other && other.id !== doc.id) throw new ConflictError(`There's already an account called ${doc.username}.`);
    await super.put(doc);
  }
  async findByUsername(username: string) {
    return this.parse(this.byName.get(username.trim().toLowerCase()) as Row | undefined);
  }
}

class Tokens extends SqlCollection<ApiToken> implements TokenCollection {
  private byHash = this.db.prepare('SELECT data FROM tokens WHERE token_hash = ?');
  async findByHash(tokenHash: string) {
    return this.parse(this.byHash.get(tokenHash) as Row | undefined);
  }
}

export interface SqliteStorageOptions {
  /** File path, or ":memory:". */
  path: string;
}

export function createSqliteStorage(options: SqliteStorageOptions): Storage {
  const db = openDatabase(options.path);
  migrate(db);

  const stock = new Stock(db, 'stock', (e) => ({ product_id: e.productId, place_id: e.placeId, current_place_id: e.currentPlaceId }), ['product_id', 'place_id', 'current_place_id']);
  const products = new Products(db, 'products');
  const appendMovement = db.prepare('INSERT INTO movements (id, product_id, at, data) VALUES (?, ?, ?, ?)');
  const movementsByProduct = db.prepare('SELECT data FROM movements WHERE product_id = ? ORDER BY seq DESC LIMIT ?');
  const movementsRecent = db.prepare('SELECT data FROM movements ORDER BY seq DESC LIMIT ?');
  const getLookup = db.prepare('SELECT data FROM lookups WHERE barcode = ?');
  const putLookup = db.prepare('INSERT INTO lookups (barcode, data) VALUES (?, ?) ON CONFLICT(barcode) DO UPDATE SET data = excluded.data');
  const getSession = db.prepare('SELECT data FROM sessions WHERE id = ?');
  const putSession = db.prepare('INSERT INTO sessions (id, expires_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data');
  const removeSession = db.prepare('DELETE FROM sessions WHERE id = ?');
  const removeExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const docGet = db.prepare('SELECT data FROM documents WHERE collection = ? AND id = ?');
  const docList = db.prepare('SELECT id, data FROM documents WHERE collection = ? ORDER BY rowid');
  const docPut = db.prepare('INSERT INTO documents (collection, id, data) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data');
  const docRemove = db.prepare('DELETE FROM documents WHERE collection = ? AND id = ?');

  const json = <T>(row: unknown, col = 'data'): T | null => (row ? (JSON.parse((row as Row)[col] as string) as T) : null);
  const insertMovements = (ms: Movement[]) => {
    for (const m of ms) appendMovement.run(m.id, m.productId, m.at, JSON.stringify(m));
  };

  return {
    categories: new SqlCollection<Category>(db, 'categories'),
    shops: new SqlCollection<Shop>(db, 'shops'),
    places: new Places(db, 'places', (p) => ({ code_lc: p.code ? p.code.trim().toLowerCase() : null }), ['code_lc']),
    products,
    variants: new Variants(db, 'variants', (v) => ({ product_id: v.productId }), ['product_id']),
    stock,
    movements: {
      async append(ms) {
        insertMovements(ms);
      },
      async listByProduct(productId, limit) {
        return (movementsByProduct.all(productId, limit) as Row[]).map((r) => json<Movement>(r)!);
      },
      async listRecent(limit) {
        return (movementsRecent.all(limit) as Row[]).map((r) => json<Movement>(r)!);
      },
    },
    lookups: {
      async get(barcode) {
        return json<LookupRecord>(getLookup.get(barcode));
      },
      async put(record) {
        putLookup.run(record.barcode, JSON.stringify(record));
      },
    },
    users: new Users(db, 'users', (u) => ({ username_lc: u.username.trim().toLowerCase() }), ['username_lc']),
    sessions: {
      async get(id) {
        return json<Session>(getSession.get(id));
      },
      async put(s) {
        putSession.run(s.id, s.expiresAt, JSON.stringify(s));
      },
      async remove(id) {
        removeSession.run(id);
      },
      async removeExpired(now) {
        removeExpired.run(now);
      },
    },
    tokens: new Tokens(db, 'tokens', (t) => ({ token_hash: t.tokenHash }), ['token_hash']),
    settings: {
      async get<T>(key: string) {
        return json<T>(getSetting.get(key), 'value');
      },
      async set(key, value) {
        putSetting.run(key, JSON.stringify(value));
      },
    },
    documents<T>(collection: string): DocumentCollection<T> {
      return {
        async get(id) {
          return json<T>(docGet.get(collection, id));
        },
        async list() {
          return (docList.all(collection) as Row[]).map((r) => ({ id: r.id as string, data: JSON.parse(r.data as string) as T }));
        },
        async put(id, data) {
          docPut.run(collection, id, JSON.stringify(data));
        },
        async remove(id) {
          docRemove.run(collection, id);
        },
      };
    },
    async applyStockChanges(changes: StockChanges) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const e of changes.put ?? []) stock.putSync(e);
        for (const id of changes.remove ?? []) stock.removeSync(id);
        insertMovements(changes.movements ?? []);
        for (const p of changes.products ?? []) products.putSync(p);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async backup(dir: string) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `larder-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      db.prepare('VACUUM INTO ?').run(file);
      return file;
    },
    async close() {
      db.close();
    },
  };
}
