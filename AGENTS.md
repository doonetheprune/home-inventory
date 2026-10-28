# Working on Larder (guide for AI coding assistants and people)

Larder is a self-hosted home inventory: stock, places, shops, shopping lists, scanning. It runs on its own (Docker) and will run as a Home Assistant add-on. Read this file before changing anything.

## Commands

```bash
npm ci                 # install
npm run dev            # API on :8080 + web app on :5173 (no login, data in ./data)
npm test               # unit, storage contract, API, module and architecture tests (fast)
npm run typecheck      # server and web
npm run test:e2e       # builds the web app, then browser tests on phone and desktop sizes
npm run build          # dist/web (web app) + dist/server/main.js (server)
npm run openapi        # refresh docs/openapi.json after changing any route or schema
npm start              # run the built server
```

Run `npm run typecheck && npm test` before every commit. Run `npm run test:e2e` when you change the web app.

## Layout

```
src/core/            The stable core. Data model, ports (interfaces), services, module system. No I/O, no Node APIs.
  model.ts           zod schemas: the single source of truth for records and API payloads
  inputs.ts          request payload schemas (create/patch/stock operations)
  ports.ts           Storage, FileStore, SearchIndex, EventBus, Clock interfaces
  services/          products, stock, places/shops/categories (catalogue), shopping, search, lookup, home
  modules.ts         module definition, context and registry
src/adapters/        Implementations of the ports: storage-sqlite, storage-memory, files-local, files-memory,
                     search-memory (MiniSearch), events-memory
src/server/          Fastify app: REST API (/api/v1), OpenAPI, login and tokens, live events (SSE), static web app
src/web/             React web app (Vite). Mobile first; switches to a sidebar layout at 900px wide
modules/             Feature modules, each self-contained with SPEC.md and tests. modules/index.ts lists them
  _template/         Copy this to start a new module
  _shared/           Helpers modules may import (not modules themselves)
tests/               contract/ (storage), core/, api/, e2e/ (Playwright), architecture.test.ts
docs/                BRIEF.md (requirements), DECISIONS.md, ARCHITECTURE.md, running.md, modules.md, adapters.md, api.md, openapi.json
mockups/             Phase 0 clickable mock-ups (the design reference)
```

## The rules

1. **Core vs modules.** The core (`src/core`, the REST API, storage adapters) is stable and changes rarely. New features go in a module under `modules/` using only `@larder/core` and the module context. If a feature can't be built as a module, add the smallest possible extension hook to the core first, document it in `docs/modules.md`, then build the feature as a module.
2. **Boundaries are tested.** `tests/architecture.test.ts` fails if the core imports Node APIs, adapters, the server or the web app; if adapters reach inside the core; or if modules import anything but `@larder/core`, `@larder/web-sdk`, `zod`, React, `modules/_shared` and their own files.
3. **Storage is swappable.** Never call the database directly from services. Go through the `Storage` port. Keep to its rules (see `src/core/ports.ts`): app-generated string IDs, whole-document `put`, named queries, one atomic `applyStockChanges` for stock writes. Any change to the port must be added to `tests/contract/storage-contract.ts` and implemented in every adapter.
4. **The data model is a contract.** Add fields as optional or with defaults. Never rename or remove a field without a migration in every storage adapter. Module data goes in `product.fields[moduleId]`, validated by the module's `productFields` schema.
5. **The API is a contract.** Routes use zod schemas from `src/core`, so the OpenAPI spec is generated. After changing routes or schemas run `npm run openapi`; a test fails if `docs/openapi.json` is stale. Don't break existing routes; add new ones.
6. **Words matter.** Messages are written for people: say what went wrong and how to fix it. UK English. The app says "Places" (not locations) and "Out of place" (usually lives in the garage, now in the shed). See `docs/DECISIONS.md` for agreed wording and behaviour.
7. **Tests with every change.** Core logic gets a test in `tests/core`. API changes get a test in `tests/api`. Modules carry their own tests next to them.

## Adding a feature module (step by step)

1. `cp -r modules/_template modules/my-feature` and set `id: 'my-feature'` (same as the folder), name and description.
2. Add it to `modules/index.ts`.
3. Use the context in `setup(ctx)`:
   - `ctx.core` is the public core API (products, stock, places, shops, shopping, search, lookup, settings…).
   - `ctx.addRoute({...})` adds `/api/v1/modules/my-feature/...` (validated and documented automatically).
   - `ctx.on('stock.changed', handler)` reacts to events (`*` suffix matches prefixes).
   - `ctx.collection('name')` stores your own JSON documents in whatever storage is in use.
   - `ctx.addLookupProvider(...)`, `ctx.addSearchSection(...)` extend scanning and search.
   - `productFields: z.object({...})` declares data in `product.fields['my-feature']`.
4. Optional UI: `modules/my-feature/web.tsx` default-exports `defineWebModule({ id, productPanels, shoppingPanels, pages })` from `@larder/web-sdk`. It's found automatically and only shown while the module is on.
5. Write `SPEC.md` (what it does, hooks, routes, data, settings) and tests (`*.test.ts`, see `modules/_template/template.test.ts` and `modules/pricing/pricing.test.ts`).
6. `npm run typecheck && npm test && npm run openapi`.

Full reference: `docs/modules.md`.

## Adding a storage adapter (e.g. Firestore)

Implement the `Storage` interface from `src/core/ports.ts` in `src/adapters/storage-<name>/`, add `tests/contract/<name>.test.ts` calling `storageContract('<name>', () => create...())`, then select it in `src/server/main.ts` via `LARDER_STORAGE`. When the contract tests pass, the whole app works on it. Guide: `docs/adapters.md`.

## Where things are decided

- Requirements: `docs/BRIEF.md`. Phases: Phase 1 (this core, standalone) is done; Phase 2 is Home Assistant (add-on + HACS integration), Phase 3 the MCP server, Phase 4 scenarios, printing, recipes, MQTT.
- Decisions made with the owner: `docs/DECISIONS.md`. Add to it when the owner decides something.
- Design reference: `mockups/index.html`.
