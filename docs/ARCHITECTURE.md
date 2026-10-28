# Architecture

Larder is one process and one data folder. Everything talks to a small core through ports, so the parts around it can be replaced without touching the rules in the middle.

```
 Web app (React)   Home Assistant integration (Phase 2)   MCP server (Phase 3)   scripts / Node-RED
        │                      │                                │                     │
        └──────────────────────┴────────── REST API /api/v1 ────┴─────────────────────┘
                                   (OpenAPI: docs/openapi.json, /api/docs)
                                               │
                                   Server (src/server): login, tokens,
                                   live events (SSE), photos, backups
                                               │
                          ┌──────────── Core (src/core) ─────────────┐
                          │ model (zod) · services · module registry │
                          │ products · stock · places · shops ·      │
                          │ shopping · search · lookup · home        │
                          └───────────────┬──────────────────────────┘
                                          │ ports (src/core/ports.ts)
            ┌──────────────┬──────────────┼───────────────┬──────────────┐
         Storage        Files          Search          Events          Clock
     SQLite / memory   local disk   MiniSearch      in-process       system
     (Firestore…)      (S3…)        (Typesense…)    (MQTT, HA…)
                                          │
                              Feature modules (modules/)
                 lookup providers · pricing · template · (scenarios, printing, recipes, MQTT…)
```

## Core

- **Model** (`src/core/model.ts`): zod schemas for every stored record (Product, Variant, StockEntry, Place, Shop, Category, Movement, User, ApiToken…) and computed view (ProductSummary, PlaceContents, ShoppingList, Dashboard, SearchSection…). The server turns these into the OpenAPI spec; the web app imports the same types.
- **Services** (`src/core/services`): all the rules. Low stock counts expected deliveries; "any shop" items go to shops that sell their category; stock is used soonest-expiring first; rechargeables split into charged and flat; renewals restart the clock; out-of-place stock keeps its usual place.
- **World loading**: reads load everything they need at once and compute in memory (`services/world.ts`). A household has thousands of records at most, so this is fast and keeps adapters simple (no joins).
- **Stock writes**: each operation works on a copy of one product's entries, tidies them (merging identical batches), and writes the difference in one atomic `applyStockChanges` call along with history (movements) and product flag changes.
- **Events**: every change publishes an event (`stock.changed`, `stock.low`, `stock.restocked`, `product.*`, `place.changed`, `shop.changed`, `shopping.purchased`, `settings.changed`). The web app refreshes on them via SSE; modules subscribe; Home Assistant will too.

## Storage

The default adapter is SQLite using Node's built-in `node:sqlite` (no native add-ons, so the same image runs on a Raspberry Pi or a NAS). Each record is stored whole as JSON with a few indexed columns for the named queries, the way a document database would hold it. See [adapters.md](adapters.md) to write another adapter.

## Server

Fastify with the zod type provider. Routes live in `src/server/routes`, validate with core schemas and appear in the spec automatically. Login is either household accounts (cookie sessions plus bearer tokens) or `none` for trusted networks; Home Assistant ingress login comes in Phase 2. The built web app is served from `/` with hash routing and relative paths, so it works behind Home Assistant ingress and reverse proxies.

## Web app

React, TanStack Query and React Router. One set of screens: phone layout by default, sidebar and multi-column layouts when the app is at least 900px wide (CSS container queries). Search is the main way in: sections for stock, shopping lists, places, wish list and shops, with keyboard counting (↑/↓ then Enter). Scanning uses the camera (BarcodeDetector or ZXing) or a USB/Bluetooth scanner typing anywhere.

## Modules

See [modules.md](modules.md). A module gets `ctx.core` (the public core API), and hooks to add routes, search sections, lookup providers, product fields, event handlers and its own collections. Web parts register panels and pages through `@larder/web-sdk`. Modules can be switched on and off at runtime.

## Data folder

```
/data
  larder.db (+ -wal, -shm)   SQLite database
  files/                     photos
  backups/                   automatic daily backups (last 7 kept)
```

Back up the folder (or use Settings → Export for a portable JSON file).
