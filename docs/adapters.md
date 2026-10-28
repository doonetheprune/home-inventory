# Writing a storage adapter

Larder's core never talks to a database. It talks to the `Storage` port in `src/core/ports.ts`. SQLite is the default adapter; in-memory is the reference implementation used by tests. To run Larder on something else (Firestore, Postgres, Supabase, DynamoDB…), write another adapter.

## Steps

1. Create `src/adapters/storage-<name>/index.ts` exporting `create<Name>Storage(options): Storage`. Import types only from `@larder/core`.
2. Add `tests/contract/<name>.test.ts`:
   ```ts
   import { storageContract } from './storage-contract';
   import { createFirestoreStorage } from '../../src/adapters/storage-firestore';
   storageContract('Firestore (emulator)', () => createFirestoreStorage({ projectId: 'demo-larder' }));
   ```
3. Make `npm test` pass. The contract covers every method, including copies-not-references, case-insensitive lookups and atomic batches.
4. Select it in `src/server/main.ts` (add a value to `LARDER_STORAGE` in `src/server/config.ts`).
5. Move existing data with Settings → Data → Export (one JSON file) and a small import script that `put`s each record.

## The rules the port follows (and why)

| Rule | Why it makes adapters easy |
|---|---|
| IDs are strings made by the core | No auto-increment needed; Firestore document ids work as they are |
| `put` replaces the whole document | Maps to `set()` in Firestore, upsert in SQL |
| Queries are named methods (`findByBarcode`, `listByProduct`, `listByPlace`) | Each needs one index or one query, not a query language |
| Arrays inside documents (`barcodes`, `nfcTags`, `shopCodes`) | Firestore `array-contains`; SQL `json_each` or a side table |
| `applyStockChanges` is all or nothing | One Firestore batch / SQL transaction |
| Reads load collections whole | No joins; the core works out summaries in memory |
| Module data via `documents(collection)` | One generic collection per module |

## Firestore notes

- Collections map one to one: `categories`, `shops`, `places`, `products`, `variants`, `stock`, `movements`, `lookups` (keyed by barcode), `users`, `sessions`, `tokens`, `settings` (keyed by setting name), and module collections like `pricing:prices`.
- `findByCode` is case-insensitive: store a lower-cased copy of `code` (`code_lc`) and query that. Same for `username`.
- `findByShopCode` searches inside an array of objects: also store a flat `shopCodeKeys` array like `["76043", "toolstation-id:76043"]` and use `array-contains`.
- `movements.listRecent` needs ordering: store a timestamp (and a counter if two can share one) and order by it.
- Search isn't part of Storage: the in-app search index works with any storage. If you replace the whole server with Cloud Functions, implement the `SearchIndex` port with Typesense or Algolia.
- Photos go through the separate `FileStore` port (Firebase Storage would be another small adapter).
- Live updates come from the `EventBus` port. Firestore's own listeners can stay internal to the adapter; the core still publishes events.

## Replacing the whole server instead

Everything outside the server (the web app, the Home Assistant integration, the MCP server) only uses the REST API described in `docs/openapi.json`. A completely different back end that serves the same API works with all of them. `tests/api` can be pointed at it to check.
