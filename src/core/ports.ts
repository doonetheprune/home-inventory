/**
 * Ports: the only ways the core talks to the outside world.
 *
 * Each port is a small async interface with one or more adapters in
 * src/adapters. Swapping SQLite for Firestore (or anything else) means writing
 * a new adapter that passes the shared contract tests in tests/contract. The
 * core must never import an adapter directly.
 *
 * Design rules that keep adapters easy to write:
 * - IDs are strings created by the core (see ids.ts), never by the database.
 * - Records are stored whole: `put` replaces the full document.
 * - Queries are named methods (findByBarcode, listByProduct), not query languages.
 * - Anything that must change together goes through one batch call (applyStockChanges).
 */
import type {
  ApiToken,
  Category,
  LookupRecord,
  Movement,
  Place,
  Product,
  Session,
  Shop,
  StockEntry,
  User,
  Variant,
} from './model';

/** A collection of whole documents keyed by `id`. */
export interface Collection<T extends { id: string }> {
  get(id: string): Promise<T | null>;
  list(): Promise<T[]>;
  /** Insert or replace the whole document. */
  put(doc: T): Promise<void>;
  /** Removing a missing id is not an error. */
  remove(id: string): Promise<void>;
}

export interface PlaceCollection extends Collection<Place> {
  /** Case-insensitive exact match on `code`. */
  findByCode(code: string): Promise<Place | null>;
  findByNfcTag(tag: string): Promise<Place | null>;
}

export interface ProductCollection extends Collection<Product> {
  findByNfcTag(tag: string): Promise<Product | null>;
}

export interface VariantCollection extends Collection<Variant> {
  listByProduct(productId: string): Promise<Variant[]>;
  findByBarcode(barcode: string): Promise<Variant | null>;
  /** Shop code match; shopId narrows it when given. */
  findByShopCode(code: string, shopId?: string): Promise<Variant | null>;
}

export interface StockCollection extends Collection<StockEntry> {
  listByProduct(productId: string): Promise<StockEntry[]>;
  /** Entries whose usual place or current place is this place. */
  listByPlace(placeId: string): Promise<StockEntry[]>;
}

export interface MovementLog {
  append(movements: Movement[]): Promise<void>;
  /** Newest first. */
  listByProduct(productId: string, limit: number): Promise<Movement[]>;
  /** Newest first. */
  listRecent(limit: number): Promise<Movement[]>;
}

export interface LookupCache {
  get(barcode: string): Promise<LookupRecord | null>;
  put(record: LookupRecord): Promise<void>;
}

export interface UserCollection extends Collection<User> {
  /** Case-insensitive. */
  findByUsername(username: string): Promise<User | null>;
}

export interface TokenCollection extends Collection<ApiToken> {
  findByHash(tokenHash: string): Promise<ApiToken | null>;
}

export interface SessionStore {
  get(id: string): Promise<Session | null>;
  put(session: Session): Promise<void>;
  remove(id: string): Promise<void>;
  removeExpired(now: string): Promise<void>;
}

export interface SettingsStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

/** Generic JSON documents, used by modules for their own data. */
export interface DocumentCollection<T = Record<string, unknown>> {
  get(id: string): Promise<T | null>;
  list(): Promise<Array<{ id: string; data: T }>>;
  put(id: string, data: T): Promise<void>;
  remove(id: string): Promise<void>;
}

/** One atomic batch of stock writes. Adapters must apply all of it or none of it. */
export interface StockChanges {
  put?: StockEntry[];
  remove?: string[];
  movements?: Movement[];
  /** Products touched by this change (e.g. to clear a wish flag). */
  products?: Product[];
}

export interface Storage {
  categories: Collection<Category>;
  shops: Collection<Shop>;
  places: PlaceCollection;
  products: ProductCollection;
  variants: VariantCollection;
  stock: StockCollection;
  movements: MovementLog;
  lookups: LookupCache;
  users: UserCollection;
  sessions: SessionStore;
  tokens: TokenCollection;
  settings: SettingsStore;
  /** Module data lives in its own namespaced collections. */
  documents<T = Record<string, unknown>>(collection: string): DocumentCollection<T>;
  applyStockChanges(changes: StockChanges): Promise<void>;
  /** Optional: write a consistent backup into `dir` and return the file path. */
  backup?(dir: string): Promise<string>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */

export interface StoredFile {
  data: Uint8Array;
  contentType: string;
  name: string;
}

/** Photos and other uploads. Local disk by default; S3 or Firebase Storage later. */
export interface FileStore {
  put(file: StoredFile): Promise<{ id: string }>;
  get(id: string): Promise<StoredFile | null>;
  remove(id: string): Promise<void>;
}

/* ------------------------------------------------------------------ */

export interface SearchDoc {
  /** Unique across all types, e.g. "product:abc". */
  id: string;
  type: string;
  refId: string;
  title: string;
  /** Extra searchable words: aliases, notes, category, place names, codes. */
  keywords: string[];
}

export interface SearchHit {
  id: string;
  type: string;
  refId: string;
  score: number;
}

/** Fuzzy, typo-tolerant text search. In-app by default; Typesense or Algolia later. */
export interface SearchIndex {
  replaceAll(docs: SearchDoc[]): Promise<void>;
  upsert(docs: SearchDoc[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  query(text: string, options?: { types?: string[]; limit?: number }): Promise<SearchHit[]>;
}

/* ------------------------------------------------------------------ */

export interface LarderEvent<T = Record<string, unknown>> {
  type: string;
  at: string;
  data: T;
}

/** Change notifications. In-process by default; MQTT and Home Assistant listen to it. */
export interface EventBus {
  publish(event: LarderEvent): void;
  subscribe(handler: (event: LarderEvent) => void): () => void;
}

/* ------------------------------------------------------------------ */

export interface Clock {
  now(): Date;
}

/* ------------------------------------------------------------------ */

/**
 * Home Assistant, when Larder can reach it: as an add-on through the
 * Supervisor, or given Home Assistant's address and a token. Null
 * otherwise, and features that need it offer YAML to paste instead.
 */
export interface HomeAssistantPort {
  /** Home's location, as set in Home Assistant. */
  home(): Promise<{ latitude: number; longitude: number; name: string }>;
  /** People, and the phones (mobile app notify actions) they can be told on. */
  people(): Promise<{ people: HomeAssistantPerson[]; phones: HomeAssistantPhone[] }>;
  /** Creates each zone, or updates the one with its id (making a new one if it has gone). In the same order. */
  saveZones(zones: HomeAssistantZone[]): Promise<Array<{ id: string; entityId: string }>>;
  /**
   * Creates or replaces an automation by its id, then waits for Home Assistant to load it.
   * entityId is null when it saved the automation but didn't load it (automations.yaml isn't included).
   */
  saveAutomation(id: string, config: Record<string, unknown>): Promise<{ entityId: string | null }>;
  /** Deletes zones Larder made, by id. Ones already gone are fine. */
  removeZones(ids: string[]): Promise<void>;
  /** Deletes an automation by its id. One already gone is fine. */
  removeAutomation(id: string): Promise<void>;
  /** Where Larder opens inside Home Assistant (the add-on's panel), for links in notifications. */
  appPath(): Promise<string | null>;
}

export interface HomeAssistantPerson {
  entityId: string;
  name: string;
  /** Notify actions for this person's own phones, e.g. "notify.mobile_app_shauns_phone". */
  phones: string[];
}

export interface HomeAssistantPhone {
  /** The notify action, e.g. "notify.mobile_app_shauns_phone". */
  action: string;
  name: string;
}

export interface HomeAssistantZone {
  id?: string | null;
  name: string;
  latitude: number;
  longitude: number;
  /** Metres. */
  radius: number;
  icon?: string;
}

