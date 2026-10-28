/**
 * Schema migrations, applied in order and tracked with PRAGMA user_version.
 * Never edit a migration that has shipped; add a new one to the end.
 */
export const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE categories (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE shops (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE places (id TEXT PRIMARY KEY, data TEXT NOT NULL, code_lc TEXT);
  CREATE INDEX places_code ON places (code_lc);
  CREATE TABLE products (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE variants (id TEXT PRIMARY KEY, data TEXT NOT NULL, product_id TEXT NOT NULL);
  CREATE INDEX variants_product ON variants (product_id);
  CREATE TABLE stock (id TEXT PRIMARY KEY, data TEXT NOT NULL, product_id TEXT NOT NULL, place_id TEXT, current_place_id TEXT);
  CREATE INDEX stock_product ON stock (product_id);
  CREATE INDEX stock_place ON stock (place_id);
  CREATE INDEX stock_current_place ON stock (current_place_id);
  CREATE TABLE movements (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, product_id TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX movements_product ON movements (product_id, seq);
  CREATE TABLE lookups (barcode TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE users (id TEXT PRIMARY KEY, data TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, expires_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE tokens (id TEXT PRIMARY KEY, data TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE documents (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id));
  `,
];
