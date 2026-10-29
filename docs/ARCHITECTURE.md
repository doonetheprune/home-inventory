# Architecture

Larder is one process and one data folder. Everything talks to a small core through ports, so the parts around it can be replaced without touching the rules in the middle.

```
 Web app (React)   Home Assistant integration (Python)   AI assistants (MCP)   scripts / Node-RED
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
                 lookup providers · pricing · batteries · template · (scenarios, printing, recipes, MQTT…)
```

## Core

- **Model** (`src/core/model.ts`): zod schemas for every stored record (Product, Variant, StockEntry, Place, Shop, Category, Movement, User, ApiToken…) and computed view (ProductSummary, PlaceContents, ShoppingList, Dashboard, SearchSection…). The server turns these into the OpenAPI spec; the web app imports the same types.
- **Services** (`src/core/services`): all the rules. Low stock counts expected deliveries; "any shop" items go to shops that sell their category; stock is used soonest-expiring first; rechargeables split into charged and flat; renewals restart the clock; out-of-place stock keeps its usual place.
- **World loading**: reads load everything they need at once and compute in memory (`services/world.ts`). A household has thousands of records at most, so this is fast and keeps adapters simple (no joins).
- **Stock writes**: each operation works on a copy of one product's entries, tidies them (merging identical batches), and writes the difference in one atomic `applyStockChanges` call along with history (movements) and product flag changes.
- **Events**: every change publishes an event (`stock.changed`, `stock.low`, `stock.restocked`, `stock.expiring`, `stock.expired`, `product.*`, `place.changed`, `shop.changed`, `shopping.purchased`, `nfc.scanned`, `settings.changed`, and modules' own like `batteries.low`). The web app refreshes on them via SSE; modules subscribe; the Home Assistant integration fires them as `larder_*` events.
- **Resolving names** (`services/resolve.ts`): actions and (later) MCP tools take names as people say them ("loo roll", "G2-4", "aldi"). The resolver checks ids, codes, barcodes, NFC tags, names and aliases (plural or not), then fuzzy search, and refuses to guess between close matches.
- **Automation** (`services/automation.ts`): the sensors and actions Home Assistant shows. Core defines a stable set; modules add theirs. Served at `/api/v1/automation`, with each action's fields as JSON Schema.

## Storage

The default adapter is SQLite using Node's built-in `node:sqlite` (no native add-ons, so the same image runs on a Raspberry Pi or a NAS). Each record is stored whole as JSON with a few indexed columns for the named queries, the way a document database would hold it. See [adapters.md](adapters.md) to write another adapter.

## Server

Fastify with the zod type provider. Routes live in `src/server/routes`, validate with core schemas and appear in the spec automatically. Login is household accounts (cookie sessions plus bearer tokens), `none` for trusted networks, or `homeassistant` for the add-on: people arriving through Home Assistant ingress are signed in from the Supervisor's `X-Remote-User-*` headers, believed only on connections from the Supervisor's address. The built web app is served from `/` with hash routing and relative paths, so it works behind Home Assistant ingress and reverse proxies.

## Home Assistant

```
 Home Assistant                                Larder (add-on or anywhere)
 ─────────────────────────────────             ───────────────────────────
 sensor.larder_*  ◄── coordinator ── GET /api/v1/automation (+ /state)
 larder.<action>  ──────────────────► POST /api/v1/automation/actions/<id>
 larder_* events  ◄── live events ─── GET /api/v1/events (SSE)
 tag_scanned      ──────────────────► POST /api/v1/nfc/scanned
 battery sensors  ──────────────────► PUT /api/v1/modules/batteries/devices, POST …/low
```

- **Add-on** (`addon/`): the same Docker image. `src/server/addon.ts` turns the add-on options into settings, keeps a token for the integration in the data folder, and announces Larder to the Supervisor (discovery) so the integration sets itself up.
- **Integration** (`custom_components/larder/`): builds its sensors and actions from Larder's list at runtime, so modules extend Home Assistant without touching Python. Talks only to the REST API, so it works the same with Larder running anywhere. See [home-assistant.md](home-assistant.md).

## Web app

React, TanStack Query and React Router. One set of screens: phone layout by default, sidebar and multi-column layouts when the app is at least 900px wide (CSS container queries). Search is the main way in: sections for stock, shopping lists, places, wish list and shops, with keyboard counting (↑/↓ then Enter). Scanning uses the camera (BarcodeDetector or ZXing) or a USB/Bluetooth scanner typing anywhere.

## Modules

See [modules.md](modules.md). A module gets `ctx.core` (the public core API), and hooks to add routes, search sections, lookup providers, product fields, event handlers and its own collections. Web parts register panels and pages through `@larder/web-sdk`. Modules can be switched on and off at runtime.

## AI assistants (MCP)

`src/core/services/assistant.ts` holds a small set of tools (search, get_item, add_item, add/use/move stock, deliveries, shopping list, what to use soon; modules add more with `ctx.addTool`) and the instructions an assistant gets when it connects. The write tools reuse the Home Assistant actions, so an assistant and an automation say the same thing.

`src/server/mcp.ts` serves them with the official MCP SDK at `/mcp`: Streamable HTTP, stateless, plain JSON answers, signed in with an access token. `src/server/oauth.ts` adds the MCP authorization spec's sign-in for connectors (Claude.ai, ChatGPT) when Larder has a public https address: the person approves in the web app and the connector gets an ordinary access token. The Home Assistant integration passes MCP through at `/api/larder/mcp` with Home Assistant sign-in, for Nabu Casa. See [mcp.md](mcp.md).

## Data folder

```
/data
  larder.db (+ -wal, -shm)   SQLite database
  files/                     photos
  backups/                   automatic daily backups (last 7 kept)
```

Back up the folder (or use Settings → Export for a portable JSON file).
